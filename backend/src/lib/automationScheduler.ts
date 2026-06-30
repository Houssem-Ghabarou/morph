import cron, { ScheduledTask } from 'node-cron';
import { query } from './postgres';
import {
  AutomationRow,
  runAutomation,
  automationWouldFire,
  cooldownElapsed,
} from './automationEngine';

// Registered cron jobs for 'schedule' automations, keyed by automation id.
const scheduledJobs = new Map<number, ScheduledTask>();
// The single recurring checker for threshold / date_proximity automations.
let triggerChecker: ScheduledTask | null = null;

const TRIGGER_TYPES = ['threshold', 'date_proximity'];

async function loadAutomation(id: number): Promise<AutomationRow | null> {
  const res = await query(`SELECT * FROM morph_automations WHERE id = $1`, [id]);
  return res.rows.length > 0 ? (res.rows[0] as AutomationRow) : null;
}

async function loadEnabled(): Promise<AutomationRow[]> {
  const res = await query(`SELECT * FROM morph_automations WHERE enabled = TRUE`);
  return res.rows as AutomationRow[];
}

/** Register (or replace) the cron job for a single schedule-type automation. */
function registerScheduleJob(automation: AutomationRow): void {
  unregisterAutomation(automation.id);
  if (automation.trigger_type !== 'schedule') return;

  const cronExpr = (automation.trigger_config?.cron as string) ?? '';
  if (!cron.validate(cronExpr)) {
    console.warn(`Automation ${automation.id} has invalid cron "${cronExpr}" — skipped`);
    return;
  }
  const timezone = (automation.trigger_config?.timezone as string) || undefined;

  const task = cron.schedule(
    cronExpr,
    async () => {
      const fresh = await loadAutomation(automation.id);
      if (!fresh || !fresh.enabled) return;
      console.log(`⏰ Running scheduled automation ${fresh.id} "${fresh.name}"`);
      await runAutomation(fresh, `Scheduled: ${cronExpr}`);
    },
    timezone ? { timezone } : undefined
  );

  scheduledJobs.set(automation.id, task);
  console.log(`✅ Scheduled automation ${automation.id} "${automation.name}" (${cronExpr})`);
}

/** Stop and remove any cron job for the given automation. */
export function unregisterAutomation(id: number): void {
  const job = scheduledJobs.get(id);
  if (job) {
    job.stop();
    scheduledJobs.delete(id);
  }
}

/** Re-read one automation from the DB and (re)register it as appropriate. */
export async function reloadAutomation(id: number): Promise<void> {
  const automation = await loadAutomation(id);
  if (!automation || !automation.enabled) {
    unregisterAutomation(id);
    return;
  }
  if (automation.trigger_type === 'schedule') {
    registerScheduleJob(automation);
  } else {
    // threshold / date_proximity are handled by the global checker.
    unregisterAutomation(id);
  }
}

/** The recurring checker for threshold / date_proximity automations. */
async function checkTriggerAutomations(): Promise<void> {
  let automations: AutomationRow[];
  try {
    const res = await query(
      `SELECT * FROM morph_automations WHERE enabled = TRUE AND trigger_type = ANY($1)`,
      [TRIGGER_TYPES]
    );
    automations = res.rows as AutomationRow[];
  } catch (err) {
    console.error('Trigger checker failed to load automations:', err);
    return;
  }

  for (const automation of automations) {
    try {
      if (!cooldownElapsed(automation)) continue;
      const { fire } = await automationWouldFire(automation);
      if (!fire) continue;
      console.log(`🔔 Trigger fired for automation ${automation.id} "${automation.name}"`);
      await runAutomation(automation, `Trigger: ${automation.trigger_type}`);
    } catch (err) {
      console.error(`Error checking automation ${automation.id}:`, err);
    }
  }
}

/** Boot the scheduler: register all schedule jobs + start the 5-min checker. */
export async function startScheduler(): Promise<void> {
  try {
    const automations = await loadEnabled();
    for (const a of automations) {
      if (a.trigger_type === 'schedule') registerScheduleJob(a);
    }
    console.log(`Automation scheduler started: ${scheduledJobs.size} scheduled job(s)`);
  } catch (err) {
    console.error('Failed to start scheduler:', err);
  }

  // Run the trigger checker every 5 minutes.
  triggerChecker = cron.schedule('*/5 * * * *', () => {
    checkTriggerAutomations().catch((err) =>
      console.error('Trigger checker error:', err)
    );
  });
}
