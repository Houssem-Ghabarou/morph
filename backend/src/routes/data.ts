import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../lib/postgres';

async function tableExists(tableName: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return result.rows.length > 0;
}

export default async function dataRoutes(fastify: FastifyInstance) {
  // Get all rows from a table
  fastify.get<{ Params: { tableName: string } }>(
    '/api/data/:tableName',
    async (request: FastifyRequest<{ Params: { tableName: string } }>, reply: FastifyReply) => {
      const { tableName } = request.params;
      if (!(await tableExists(tableName))) {
        return reply.status(404).send({ error: `Table "${tableName}" not found` });
      }
      const result = await query(`SELECT * FROM "${tableName}" ORDER BY created_at DESC`);
      return reply.send({ rows: result.rows });
    }
  );

  // Insert a row into a table
  fastify.post<{ Params: { tableName: string }; Body: Record<string, unknown> }>(
    '/api/data/:tableName',
    async (
      request: FastifyRequest<{ Params: { tableName: string }; Body: Record<string, unknown> }>,
      reply: FastifyReply
    ) => {
      const { tableName } = request.params;
      if (!(await tableExists(tableName))) {
        return reply.status(404).send({ error: `Table "${tableName}" not found` });
      }
      const body = request.body;

      const columns = Object.keys(body).filter((k) => k !== 'id' && k !== 'created_at');
      const values = columns.map((k) => body[k]);
      const placeholders = columns.map((_, i) => `$${i + 1}`);

      const sql = `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(', ')})
                   VALUES (${placeholders.join(', ')})
                   RETURNING *`;

      const result = await query(sql, values);
      return reply.status(201).send({ row: result.rows[0] });
    }
  );
}
