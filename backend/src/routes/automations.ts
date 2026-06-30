import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../lib/postgres';
import { requireAuth } from '../lib/requireAuth';
import { buildAutomationContext } from '../lib/sessionSchema';
import { parseAutomation } from '../lib/claude';
import { runAutomation, AutomationRow } from '../lib/automationEngine';
import { reloadAutomation, unregisterAutomation } from '../lib/automationScheduler';

interface AutomationBody {
  sessionId?: number;
  name?: string;
  description?: string;
  enabled?: boolean;
  trigger_type?: string;
  trigger_config?: Record<string, unknown>;
  source_table?: string;
  query_sql?: string;
  condition_expr?: string | null;
  action_type?: string;
  action_config?: Record<string, unknown>;
  cooldown_minutes?: number | null;
}

async function ownedAutomation(id: number, userId: number): Promise<AutomationRow | null> {
  const res = await query(
    `SELECT * FROM morph_automations WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return res.rows.length > 0 ? (res.rows[0] as AutomationRow) : null;
}

export default async function automationRoutes(fastify: FastifyInstance) {
  // POST /api/automations/parse — natural language → automation definition
  fastify.post<{ Body: { input: string; sessionId: number } }>(
    '/api/automations/parse',
    async (req: FastifyRequest<{ Body: { input: string; sessionId: number } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const { input, sessionId } = req.body;
      if (!input?.trim()) return reply.status(400).send({ error: 'input is required' });
      if (!sessionId) return reply.status(400).send({ error: 'sessionId is required' });

      const owned = await query(
        `SELECT id FROM morph_sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, user.userId]
      );
      if (owned.rows.length === 0) return reply.status(403).send({ error: 'Forbidden' });

      const { context } = await buildAutomationContext(sessionId);

      try {
        const parsed = await parseAutomation(input, context);
        return reply.send({ automation: parsed, defaultEmail: user.email });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(502).send({ error: 'Could not interpret that request. Try rephrasing.' });
      }
    }
  );

  // GET /api/automations/runs/recent — recent runs across all of the user's automations
  fastify.get('/api/automations/runs/recent', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const res = await query(
      `SELECT r.*, a.name AS automation_name
       FROM morph_automation_runs r
       JOIN morph_automations a ON a.id = r.automation_id
       WHERE a.user_id = $1
       ORDER BY r.executed_at DESC
       LIMIT 30`,
      [user.userId]
    );
    return reply.send({ runs: res.rows });
  });

  // GET /api/automations?sessionId=X — list automations for a session
  fastify.get<{ Querystring: { sessionId?: string } }>(
    '/api/automations',
    async (req: FastifyRequest<{ Querystring: { sessionId?: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const sessionId = req.query.sessionId ? Number(req.query.sessionId) : null;
      const res = sessionId
        ? await query(
            `SELECT * FROM morph_automations WHERE user_id = $1 AND session_id = $2 ORDER BY created_at DESC`,
            [user.userId, sessionId]
          )
        : await query(
            `SELECT * FROM morph_automations WHERE user_id = $1 ORDER BY created_at DESC`,
            [user.userId]
          );
      return reply.send({ automations: res.rows });
    }
  );

  // POST /api/automations — create
  fastify.post<{ Body: AutomationBody }>(
    '/api/automations',
    async (req: FastifyRequest<{ Body: AutomationBody }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const b = req.body ?? {};
      if (!b.name?.trim()) return reply.status(400).send({ error: 'name is required' });
      if (!b.trigger_type) return reply.status(400).send({ error: 'trigger_type is required' });

      if (b.sessionId) {
        const owned = await query(
          `SELECT id FROM morph_sessions WHERE id = $1 AND user_id = $2`,
          [b.sessionId, user.userId]
        );
        if (owned.rows.length === 0) return reply.status(403).send({ error: 'Forbidden' });
      }

      const res = await query(
        `INSERT INTO morph_automations
          (user_id, session_id, name, description, enabled, trigger_type, trigger_config,
           source_table, query_sql, condition_expr, action_type, action_config, cooldown_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          user.userId,
          b.sessionId ?? null,
          b.name.trim(),
          b.description ?? null,
          b.enabled ?? true,
          b.trigger_type,
          JSON.stringify(b.trigger_config ?? {}),
          b.source_table ?? null,
          b.query_sql ?? null,
          b.condition_expr ?? null,
          b.action_type ?? 'send_email',
          JSON.stringify(b.action_config ?? {}),
          b.cooldown_minutes ?? null,
        ]
      );

      const automation = res.rows[0] as AutomationRow;
      await reloadAutomation(automation.id);
      return reply.status(201).send({ automation });
    }
  );

  // GET /api/automations/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/automations/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;
      const automation = await ownedAutomation(Number(req.params.id), user.userId);
      if (!automation) return reply.status(404).send({ error: 'Automation not found' });
      return reply.send({ automation });
    }
  );

  // PATCH /api/automations/:id — update (enable/disable or edit)
  fastify.patch<{ Params: { id: string }; Body: AutomationBody }>(
    '/api/automations/:id',
    async (req: FastifyRequest<{ Params: { id: string }; Body: AutomationBody }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const id = Number(req.params.id);
      const existing = await ownedAutomation(id, user.userId);
      if (!existing) return reply.status(404).send({ error: 'Automation not found' });

      const b = req.body ?? {};
      const merged = {
        name: b.name ?? existing.name,
        description: b.description ?? existing.description,
        enabled: b.enabled ?? existing.enabled,
        trigger_type: b.trigger_type ?? existing.trigger_type,
        trigger_config: b.trigger_config ?? existing.trigger_config,
        source_table: b.source_table ?? existing.source_table,
        query_sql: b.query_sql ?? existing.query_sql,
        condition_expr: b.condition_expr !== undefined ? b.condition_expr : existing.condition_expr,
        action_type: b.action_type ?? existing.action_type,
        action_config: b.action_config ?? existing.action_config,
        cooldown_minutes: b.cooldown_minutes !== undefined ? b.cooldown_minutes : existing.cooldown_minutes,
      };

      const res = await query(
        `UPDATE morph_automations SET
           name = $2, description = $3, enabled = $4, trigger_type = $5, trigger_config = $6,
           source_table = $7, query_sql = $8, condition_expr = $9, action_type = $10,
           action_config = $11, cooldown_minutes = $12, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          merged.name,
          merged.description,
          merged.enabled,
          merged.trigger_type,
          JSON.stringify(merged.trigger_config ?? {}),
          merged.source_table,
          merged.query_sql,
          merged.condition_expr,
          merged.action_type,
          JSON.stringify(merged.action_config ?? {}),
          merged.cooldown_minutes,
        ]
      );

      const automation = res.rows[0] as AutomationRow;
      await reloadAutomation(automation.id);
      return reply.send({ automation });
    }
  );

  // DELETE /api/automations/:id
  fastify.delete<{ Params: { id: string } }>(
    '/api/automations/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;
      const id = Number(req.params.id);
      const existing = await ownedAutomation(id, user.userId);
      if (!existing) return reply.status(404).send({ error: 'Automation not found' });

      unregisterAutomation(id);
      await query(`DELETE FROM morph_automations WHERE id = $1`, [id]);
      return reply.send({ ok: true });
    }
  );

  // POST /api/automations/:id/run — manual test run
  fastify.post<{ Params: { id: string } }>(
    '/api/automations/:id/run',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;
      const automation = await ownedAutomation(Number(req.params.id), user.userId);
      if (!automation) return reply.status(404).send({ error: 'Automation not found' });

      const outcome = await runAutomation(automation, 'Manual run');
      return reply.send({ outcome });
    }
  );

  // GET /api/automations/:id/runs — execution history
  fastify.get<{ Params: { id: string } }>(
    '/api/automations/:id/runs',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;
      const automation = await ownedAutomation(Number(req.params.id), user.userId);
      if (!automation) return reply.status(404).send({ error: 'Automation not found' });

      const res = await query(
        `SELECT * FROM morph_automation_runs WHERE automation_id = $1 ORDER BY executed_at DESC LIMIT 10`,
        [automation.id]
      );
      return reply.send({ runs: res.rows });
    }
  );
}
