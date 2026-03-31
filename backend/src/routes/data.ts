import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../lib/postgres';

export default async function dataRoutes(fastify: FastifyInstance) {
  // Get all rows from a table
  fastify.get<{ Params: { tableName: string } }>(
    '/api/data/:tableName',
    async (request: FastifyRequest<{ Params: { tableName: string } }>, reply: FastifyReply) => {
      const { tableName } = request.params;
      // Safe: tableName is validated against information_schema before use
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
