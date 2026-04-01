import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, runInTransaction } from '../lib/postgres';
import { Relation } from '../types';

async function getRelationsForTables(tableNames: string[]): Promise<Relation[]> {
  if (tableNames.length === 0) return [];

  // Fetch all text columns for every session table
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

    // Skip system columns
    if (col === 'id' || col === 'created_at' || col === 'updated_at') continue;

    // Check if this column name matches another session table (with/without trailing 's')
    for (const other of tableNames) {
      if (other === tbl) continue;
      // Strip the session prefix (s3_) from both for comparison
      const colNorm   = col.toLowerCase();
      const otherBase = other.replace(/^s\d+_/, '').toLowerCase();

      if (colNorm === otherBase || colNorm + 's' === otherBase || colNorm === otherBase + 's') {
        relations.push({ from: tbl, to: other, on: col });
        break;
      }
    }
  }

  return relations;
}

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

  // Get FK relations for all tables in a session
  fastify.get<{ Params: { id: string } }>(
    '/api/sessions/:id/relations',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const sessionId = Number(req.params.id);
      const tablesRes = await query(
        `SELECT table_name FROM morph_session_tables WHERE session_id = $1`,
        [sessionId]
      );
      const tableNames = tablesRes.rows.map((r: { table_name: string }) => r.table_name);
      const relations = await getRelationsForTables(tableNames);
      return reply.send({ relations });
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
