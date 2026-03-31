import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, getTableSchema } from '../lib/postgres';

export default async function schemaRoutes(fastify: FastifyInstance) {
  // List all user tables
  fastify.get('/api/schema', async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'morph_%'
       ORDER BY table_name`
    );
    return reply.send({ tables: result.rows.map((r) => r.table_name) });
  });

  // Get columns for a specific table
  fastify.get<{ Params: { tableName: string } }>(
    '/api/schema/:tableName',
    async (request: FastifyRequest<{ Params: { tableName: string } }>, reply: FastifyReply) => {
      const { tableName } = request.params;
      const columns = await getTableSchema(tableName);
      if (columns.length === 0) {
        return reply.status(404).send({ error: `Table "${tableName}" not found` });
      }
      return reply.send({ tableName, columns });
    }
  );
}
