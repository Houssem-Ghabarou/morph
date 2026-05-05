import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, runInTransaction } from '../lib/postgres';
import { requireAuth } from '../lib/requireAuth';
import { Relation } from '../types';

async function getRelationsForTables(tableNames: string[]): Promise<Relation[]> {
  if (tableNames.length === 0) return [];

  const result = await query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = ANY($1)
       AND data_type IN ('text', 'character varying', 'varchar')`,
    [tableNames]
  );

  const relations: Relation[] = [];

  for (const row of result.rows) {
    const col: string  = row.column_name;
    const tbl: string  = row.table_name;

    if (col === 'id' || col === 'created_at' || col === 'updated_at') continue;

    for (const other of tableNames) {
      if (other === tbl) continue;
      const colNorm   = col.toLowerCase();
      const colBase   = colNorm.endsWith('_ref') ? colNorm.slice(0, -4) : colNorm;
      const otherBase = other.replace(/^s\d+_/, '').toLowerCase();

      if (colBase === otherBase || colBase + 's' === otherBase || colBase === otherBase + 's') {
        relations.push({ from: tbl, to: other, on: col });
        break;
      }
    }
  }

  return relations;
}

export default async function sessionRoutes(fastify: FastifyInstance) {
  // List sessions for the authenticated user
  fastify.get('/api/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const result = await query(
      `SELECT id, name, created_at, updated_at
       FROM morph_sessions
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [user.userId]
    );
    return reply.send({ sessions: result.rows });
  });

  // Create a new session for the authenticated user
  fastify.post('/api/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const result = await query(
      `INSERT INTO morph_sessions (name, user_id) VALUES ('New Chat', $1) RETURNING *`,
      [user.userId]
    );
    return reply.status(201).send(result.rows[0]);
  });

  // Get full session detail (messages + table positions) — owned by user
  fastify.get<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const sessionId = Number(req.params.id);

      const [sessionRes, messagesRes, tablesRes] = await Promise.all([
        query(`SELECT * FROM morph_sessions WHERE id = $1 AND user_id = $2`, [sessionId, user.userId]),
        query(
          `SELECT id, role, text, warning FROM morph_messages
           WHERE session_id = $1 ORDER BY created_at ASC`,
          [sessionId]
        ),
        query(
          `SELECT table_name, pos_x, pos_y, column_sources FROM morph_session_tables
           WHERE session_id = $1 ORDER BY created_at ASC`,
          [sessionId]
        ),
      ]);

      if (sessionRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Session not found' });
      }

      const tableNames = tablesRes.rows.map((r: { table_name: string }) => r.table_name);
      const relations = await getRelationsForTables(tableNames);

      return reply.send({
        ...sessionRes.rows[0],
        messages: messagesRes.rows,
        sessionTables: tablesRes.rows,
        relations,
      });
    }
  );

  // Delete a session — only if owned by user
  fastify.delete<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const sessionId = Number(req.params.id);

      await runInTransaction(async (client) => {
        // Verify ownership
        const owned = await client.query(
          `SELECT id FROM morph_sessions WHERE id = $1 AND user_id = $2`,
          [sessionId, user.userId]
        );
        if (owned.rows.length === 0) {
          reply.status(404).send({ error: 'Session not found' });
          return;
        }

        const tables = await client.query(
          `SELECT table_name FROM morph_session_tables WHERE session_id = $1`,
          [sessionId]
        );

        for (const row of tables.rows) {
          await client.query(`DROP TABLE IF EXISTS "${row.table_name}" CASCADE`);
        }

        await client.query(`DELETE FROM morph_sessions WHERE id = $1`, [sessionId]);
      });

      return reply.send({ ok: true });
    }
  );

  // Get FK relations — user must own session
  fastify.get<{ Params: { id: string } }>(
    '/api/sessions/:id/relations',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const sessionId = Number(req.params.id);
      const owned = await query(
        `SELECT id FROM morph_sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, user.userId]
      );
      if (owned.rows.length === 0) return reply.status(404).send({ error: 'Session not found' });

      const tablesRes = await query(
        `SELECT table_name FROM morph_session_tables WHERE session_id = $1`,
        [sessionId]
      );
      const tableNames = tablesRes.rows.map((r: { table_name: string }) => r.table_name);
      const relations = await getRelationsForTables(tableNames);
      return reply.send({ relations });
    }
  );

  // Rename a session — user must own it
  fastify.patch<{ Params: { id: string }; Body: { name: string } }>(
    '/api/sessions/:id/name',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { name: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const sessionId = Number(req.params.id);
      const { name } = req.body;
      if (!name?.trim()) return reply.status(400).send({ error: 'Name is required' });

      await query(
        `UPDATE morph_sessions SET name = $1 WHERE id = $2 AND user_id = $3`,
        [name.trim(), sessionId, user.userId]
      );
      return reply.send({ ok: true });
    }
  );

  // Update card position
  fastify.patch<{
    Params: { id: string; tableName: string };
    Body: { x: number; y: number };
  }>(
    '/api/sessions/:id/tables/:tableName/position',
    async (
      req: FastifyRequest<{ Params: { id: string; tableName: string }; Body: { x: number; y: number } }>,
      reply: FastifyReply
    ) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const sessionId = Number(req.params.id);
      const { tableName } = req.params;
      const { x, y } = req.body;

      // Verify ownership
      const owned = await query(
        `SELECT id FROM morph_sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, user.userId]
      );
      if (owned.rows.length === 0) return reply.status(403).send({ error: 'Forbidden' });

      await query(
        `INSERT INTO morph_session_tables (session_id, table_name, pos_x, pos_y)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id, table_name) DO UPDATE SET pos_x = $3, pos_y = $4`,
        [sessionId, tableName, x, y]
      );

      return reply.send({ ok: true });
    }
  );
}
