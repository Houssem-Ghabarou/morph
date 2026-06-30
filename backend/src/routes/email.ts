import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../lib/postgres';
import { requireAuth } from '../lib/requireAuth';
import { getEmailSettings, sendEmail, verifySmtp, SmtpSettings } from '../lib/emailService';
import { renderEmail } from '../lib/emailTemplates';
import { generateEmailContent } from '../lib/claude';

interface SettingsBody {
  provider?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  smtp_user?: string;
  smtp_pass?: string;
  from_name?: string;
  from_email?: string;
  api_key?: string;
}

const MASK = '••••••••';

/** Never return real secrets to the client. */
function maskSettings(s: SmtpSettings) {
  return {
    provider: s.provider,
    host: s.host,
    port: s.port,
    secure: s.secure,
    smtp_user: s.smtp_user,
    smtp_pass: s.smtp_pass ? MASK : null,
    from_name: s.from_name,
    from_email: s.from_email,
    api_key: s.api_key ? MASK : null,
    configured: !!(s.provider === 'smtp' && s.host && s.from_email),
  };
}

export default async function emailRoutes(fastify: FastifyInstance) {
  // GET /api/email/settings — current config, secrets masked
  fastify.get('/api/email/settings', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const settings = await getEmailSettings(user.userId);
    if (!settings) return reply.send({ settings: null });
    return reply.send({ settings: maskSettings(settings) });
  });

  // POST /api/email/settings — upsert. A masked password means "keep existing".
  fastify.post<{ Body: SettingsBody }>(
    '/api/email/settings',
    async (req: FastifyRequest<{ Body: SettingsBody }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const b = req.body ?? {};
      const existing = await getEmailSettings(user.userId);

      // Preserve stored secrets when the client sends back the mask.
      const smtpPass =
        !b.smtp_pass || b.smtp_pass === MASK ? existing?.smtp_pass ?? null : b.smtp_pass;
      const apiKey =
        !b.api_key || b.api_key === MASK ? existing?.api_key ?? null : b.api_key;

      const res = await query(
        `INSERT INTO morph_smtp_settings
          (user_id, provider, host, port, secure, smtp_user, smtp_pass, from_name, from_email, api_key, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           provider = EXCLUDED.provider,
           host = EXCLUDED.host,
           port = EXCLUDED.port,
           secure = EXCLUDED.secure,
           smtp_user = EXCLUDED.smtp_user,
           smtp_pass = EXCLUDED.smtp_pass,
           from_name = EXCLUDED.from_name,
           from_email = EXCLUDED.from_email,
           api_key = EXCLUDED.api_key,
           updated_at = NOW()
         RETURNING *`,
        [
          user.userId,
          b.provider ?? 'smtp',
          b.host ?? null,
          b.port ?? null,
          b.secure ?? false,
          b.smtp_user ?? null,
          smtpPass,
          b.from_name ?? null,
          b.from_email ?? null,
          apiKey,
        ]
      );
      return reply.send({ settings: maskSettings(res.rows[0] as SmtpSettings) });
    }
  );

  // POST /api/email/test — verify config and send a test email
  fastify.post<{ Body: { to?: string } }>(
    '/api/email/test',
    async (req: FastifyRequest<{ Body: { to?: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const settings = await getEmailSettings(user.userId);
      const to = req.body?.to || user.email;

      // If real SMTP is configured, verify credentials first for a clear error.
      if (settings && settings.provider === 'smtp' && settings.host) {
        try {
          await verifySmtp(settings);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.status(400).send({ ok: false, error: `SMTP verification failed: ${msg}` });
        }
      }

      const { html, text } = renderEmail({
        template: 'notification',
        heading: 'Your Morph email is working ✓',
        message: 'This is a test message confirming that Morph can send email on your behalf.',
        footerNote: 'You can now create automations that email you reports, alerts, and reminders.',
      });

      try {
        const result = await sendEmail(settings, { to: [to], subject: 'Morph — test email', html, text });
        return reply.send({ ok: result.ok, via: result.via, detail: result.detail });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ ok: false, error: msg });
      }
    }
  );

  // POST /api/email/report — manual session digest (no stored automation)
  fastify.post<{ Body: { sessionId: number; to?: string; subject?: string } }>(
    '/api/email/report',
    async (
      req: FastifyRequest<{ Body: { sessionId: number; to?: string; subject?: string } }>,
      reply: FastifyReply
    ) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const { sessionId } = req.body;
      if (!sessionId) return reply.status(400).send({ error: 'sessionId is required' });

      // Verify ownership
      const owned = await query(
        `SELECT name FROM morph_sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, user.userId]
      );
      if (owned.rows.length === 0) return reply.status(403).send({ error: 'Forbidden' });
      const sessionName = owned.rows[0].name as string;

      const tablesRes = await query(
        `SELECT table_name FROM morph_session_tables WHERE session_id = $1 ORDER BY created_at ASC`,
        [sessionId]
      );
      if (tablesRes.rows.length === 0) {
        return reply.status(400).send({ error: 'This session has no data to report on yet.' });
      }

      const sections: Array<{ title: string; rows: Record<string, unknown>[]; columns?: string[] }> = [];
      const digestForLlm: string[] = [];

      for (const row of tablesRes.rows as { table_name: string }[]) {
        const name = row.table_name;
        const display = name.replace(/^s\d+_/, '').replace(/_/g, ' ');
        try {
          const dataRes = await query(`SELECT * FROM "${name}" ORDER BY id DESC LIMIT 10`);
          const rows = (dataRes.rows as Record<string, unknown>[]).map((r) => {
            const { created_at, ...rest } = r as Record<string, unknown>;
            void created_at;
            return rest;
          });
          const countRes = await query(`SELECT COUNT(*) AS cnt FROM "${name}"`);
          const total = Number(countRes.rows[0]?.cnt ?? 0);
          sections.push({
            title: `${display} (${total} total, showing latest ${rows.length})`,
            rows,
            columns: rows.length > 0 ? Object.keys(rows[0]) : [],
          });
          digestForLlm.push(`${display}: ${total} rows. Latest: ${rows.slice(0, 5).map((r) => JSON.stringify(r)).join('; ')}`);
        } catch {
          /* skip unreadable table */
        }
      }

      const { summary, suggestion } = await generateEmailContent(
        `Business snapshot for "${sessionName}"`,
        // Feed compact digest rows so the LLM can summarize across modules.
        digestForLlm.map((d) => ({ module: d }))
      );

      const subject = req.body.subject || `${sessionName} — data snapshot`;
      const { html, text } = renderEmail({
        template: 'report',
        heading: `${sessionName} — snapshot`,
        summary: summary || undefined,
        suggestion: suggestion || undefined,
        sections,
        maxRows: 10,
        footerNote: 'Manual report generated from Morph.',
      });

      const to = req.body.to || user.email;
      const settings = await getEmailSettings(user.userId);
      try {
        const result = await sendEmail(settings, { to: [to], subject, html, text });
        return reply.send({ ok: result.ok, via: result.via, detail: result.detail });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ ok: false, error: msg });
      }
    }
  );
}
