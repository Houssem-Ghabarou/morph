import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, runInTransaction } from '../lib/postgres';

export default async function sessionRoutes(fastify: FastifyInstance) {
  // List all sessions
  fastify.get('/api/sessions', async (_req: FastifyRequest, reply: FastifyReply) => {
    const result = await query(
      `SELECT id, name, created_at, updated_at
       FROM morph_sessions
       ORDER BY updated_at DESC`
    );
    return reply.send({ sessions: result.rows });
  });

  // Create a new session
  fastify.post('/api/sessions', async (_req: FastifyRequest, reply: FastifyReply) => {
    const result = await query(
      `INSERT INTO morph_sessions (name) VALUES ('New Chat') RETURNING *`
    );
    return reply.status(201).send(result.rows[0]);
  });

  // Get full session detail (messages + table positions)
  fastify.get<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const sessionId = Number(req.params.id);

      const [sessionRes, messagesRes, tablesRes] = await Promise.all([
        query(`SELECT * FROM morph_sessions WHERE id = $1`, [sessionId]),
        query(
          `SELECT id, role, text, warning FROM morph_messages
           WHERE session_id = $1 ORDER BY created_at ASC`,
          [sessionId]
        ),
        query(
          `SELECT table_name, pos_x, pos_y FROM morph_session_tables
           WHERE session_id = $1 ORDER BY created_at ASC`,
          [sessionId]
        ),
      ]);

      if (sessionRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Session not found' });
      }

      return reply.send({
        ...sessionRes.rows[0],
        messages: messagesRes.rows,
        sessionTables: tablesRes.rows,
      });
    }
  );

  // Delete a session — drops all user tables that belong to it
  fastify.delete<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const sessionId = Number(req.params.id);

      await runInTransaction(async (client) => {
        // Get tables owned by this session
        const tables = await client.query(
          `SELECT table_name FROM morph_session_tables WHERE session_id = $1`,
          [sessionId]
        );

        // Drop each user table
        for (const row of tables.rows) {
          await client.query(`DROP TABLE IF EXISTS "${row.table_name}" CASCADE`);
        }

        // Delete session — cascades to morph_messages + morph_session_tables
        await client.query(`DELETE FROM morph_sessions WHERE id = $1`, [sessionId]);
      });

      return reply.send({ ok: true });
    }
  );

  // Update card position (called on drag end)
  fastify.patch<{
    Params: { id: string; tableName: string };
    Body: { x: number; y: number };
  }>(
    '/api/sessions/:id/tables/:tableName/position',
    async (
      req: FastifyRequest<{ Params: { id: string; tableName: string }; Body: { x: number; y: number } }>,
      reply: FastifyReply
    ) => {
      const sessionId = Number(req.params.id);
      const { tableName } = req.params;
      const { x, y } = req.body;

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
