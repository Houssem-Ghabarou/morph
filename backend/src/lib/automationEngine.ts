import { query } from './postgres';
import { getEmailSettings, sendEmail } from './emailService';
import { renderEmail, interpolate, EmailTemplate } from './emailTemplates';
import { generateEmailContent } from './claude';

export interface AutomationRow {
  id: number;
  user_id: number;
  session_id: number | null;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_type: 'schedule' | 'threshold' | 'date_proximity' | string;
  trigger_config: Record<string, unknown>;
  source_table: string | null;
  query_sql: string | null;
  condition_expr: string | null;
  action_type: string;
  action_config: Record<string, unknown>;
  cooldown_minutes: number | null;
  last_run_at: string | null;
  last_fired_at: string | null;
}

export interface RunOutcome {
  status: 'success' | 'failed' | 'skipped' | 'no_data';
  rowsAffected: number;
  actionResult: string;
  error?: string;
}

/** Evaluate condition expressions like "rows.length > 0" or "count >= 5". */
function conditionMet(expr: string | null | undefined, rowCount: number): boolean {
  if (!expr || !expr.trim()) return true;
  const m = expr.match(/(?:rows\.length|count|rows)\s*(<=|>=|<|>|==|=|!=)\s*(\d+)/i);
  if (!m) return rowCount > 0; // unknown expression → safe default
  const op = m[1];
  const n = Number(m[2]);
  switch (op) {
    case '<': return rowCount < n;
    case '<=': return rowCount <= n;
    case '>': return rowCount > n;
    case '>=': return rowCount >= n;
    case '==':
    case '=': return rowCount === n;
    case '!=': return rowCount !== n;
    default: return rowCount > 0;
  }
}

async function getUserEmail(userId: number): Promise<string | null> {
  const res = await query(`SELECT email FROM morph_users WHERE id = $1`, [userId]);
  return res.rows[0]?.email ?? null;
}

function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  const { ...rest } = row;
  return rest;
}

/**
 * Execute one automation end-to-end and write a row to morph_automation_runs.
 * Returns the outcome. Never throws — failures are logged as 'failed' runs.
 */
export async function runAutomation(
  automation: AutomationRow,
  triggerReason: string
): Promise<RunOutcome> {
  const started = Date.now();
  let outcome: RunOutcome;

  try {
    // 1. Run the data query (if any)
    let rows: Record<string, unknown>[] = [];
    if (automation.query_sql && automation.query_sql.trim()) {
      const result = await query(automation.query_sql);
      rows = (result.rows as Record<string, unknown>[]).map(cleanRow);
    }

    // 2. Evaluate the firing condition
    if (!conditionMet(automation.condition_expr, rows.length)) {
      outcome = {
        status: 'no_data',
        rowsAffected: rows.length,
        actionResult: `Condition not met (${rows.length} rows) — no email sent`,
      };
      return await finalize(automation, outcome, triggerReason, started);
    }

    // 3. Build email content
    const config = automation.action_config ?? {};
    const template = (config.template as EmailTemplate) ?? 'report';
    const includeSummary = config.include_summary !== false;
    const includeTable = config.include_table !== false;
    const maxRows = typeof config.max_rows === 'number' ? config.max_rows : 50;

    let summary = '';
    let suggestion = '';
    if (includeSummary && rows.length > 0) {
      const gen = await generateEmailContent(
        automation.description || automation.name,
        rows
      );
      summary = gen.summary;
      suggestion = gen.suggestion;
    }

    const vars = { count: rows.length, name: automation.name };
    const subjectTpl = (config.subject as string) || automation.name;
    const subject = interpolate(subjectTpl, vars);
    const message = config.message_template
      ? interpolate(config.message_template as string, vars)
      : undefined;

    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const { html, text } = renderEmail({
      template,
      heading: automation.name,
      summary: summary || undefined,
      suggestion: suggestion || undefined,
      message,
      rows: includeTable ? rows : undefined,
      columns,
      maxRows,
      footerNote: `Automation: ${automation.name}`,
    });

    // 4. Resolve recipients (default to the owner's email)
    let to = Array.isArray(config.to) ? (config.to as string[]) : [];
    to = to.filter((t) => typeof t === 'string' && t.includes('@'));
    if (to.length === 0) {
      const ownerEmail = await getUserEmail(automation.user_id);
      if (ownerEmail) to = [ownerEmail];
    }

    // 5. Send
    const settings = await getEmailSettings(automation.user_id);
    const sendResult = await sendEmail(settings, { to, subject, html, text });

    outcome = {
      status: sendResult.ok ? 'success' : 'failed',
      rowsAffected: rows.length,
      actionResult: `${sendResult.detail} — "${subject}"`,
      error: sendResult.ok ? undefined : sendResult.detail,
    };
  } catch (err) {
    outcome = {
      status: 'failed',
      rowsAffected: 0,
      actionResult: 'Automation run failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return await finalize(automation, outcome, triggerReason, started);
}

async function finalize(
  automation: AutomationRow,
  outcome: RunOutcome,
  triggerReason: string,
  started: number
): Promise<RunOutcome> {
  const durationMs = Date.now() - started;
  try {
    await query(
      `INSERT INTO morph_automation_runs
        (automation_id, status, trigger_reason, rows_affected, action_result, error_message, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        automation.id,
        outcome.status,
        triggerReason,
        outcome.rowsAffected,
        outcome.actionResult,
        outcome.error ?? null,
        durationMs,
      ]
    );

    // last_run_at = any run; last_fired_at = a run that actually sent (for cooldown)
    const fired = outcome.status === 'success';
    await query(
      `UPDATE morph_automations
       SET last_run_at = NOW(),
           run_count = run_count + 1
           ${fired ? ', last_fired_at = NOW()' : ''}
       WHERE id = $1`,
      [automation.id]
    );
  } catch (err) {
    console.error('Failed to log automation run:', err);
  }
  return outcome;
}

/**
 * Lightweight pre-check used by the trigger checker: run the query and test the
 * condition WITHOUT sending or logging. Lets the checker stay quiet when a
 * monitor has nothing to report (avoids flooding the run log every 5 minutes).
 */
export async function automationWouldFire(
  automation: AutomationRow
): Promise<{ fire: boolean; rowCount: number }> {
  if (!automation.query_sql || !automation.query_sql.trim()) {
    return { fire: true, rowCount: 0 };
  }
  try {
    const result = await query(automation.query_sql);
    const n = result.rows.length;
    return { fire: conditionMet(automation.condition_expr, n), rowCount: n };
  } catch (err) {
    console.error(`Trigger pre-check failed for automation ${automation.id}:`, err);
    return { fire: false, rowCount: 0 };
  }
}

/** Has the automation's cooldown elapsed since it last actually fired? */
export function cooldownElapsed(automation: AutomationRow): boolean {
  if (!automation.last_fired_at) return true;
  const defaultCooldown = automation.trigger_type === 'threshold' ? 1440 : 60; // mins
  const cooldown = automation.cooldown_minutes ?? defaultCooldown;
  const last = new Date(automation.last_fired_at).getTime();
  return Date.now() - last >= cooldown * 60 * 1000;
}
