import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateSQL } from '../lib/claude';
import { query, getTableSchema } from '../lib/postgres';
import { ChatRequest, ChatResponse, TableSchema } from '../types';

function detectAction(sql: string): ChatResponse['action'] {
  const upper = sql.toUpperCase().trimStart();
  if (upper.startsWith('CREATE TABLE')) return 'create';
  if (upper.startsWith('ALTER TABLE')) return 'alter';
  if (upper.startsWith('INSERT')) return 'insert';
  if (upper.startsWith('SELECT')) return 'select';
  return 'unknown';
}

function extractTableName(sql: string): string | null {
  const create = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
  if (create) return create[1];
  const alter = sql.match(/ALTER\s+TABLE\s+(\w+)/i);
  if (alter) return alter[1];
  const insert = sql.match(/INSERT\s+INTO\s+(\w+)/i);
  if (insert) return insert[1];
  return null;
}

export default async function chatRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: ChatRequest }>('/api/chat', async (request: FastifyRequest<{ Body: ChatRequest }>, reply: FastifyReply) => {
    const { message } = request.body;

    if (!message || message.trim() === '') {
      return reply.status(400).send({ error: 'Message is required' });
    }

    let sql: string;
    try {
      sql = await generateSQL(message);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(502).send({ error: 'Claude API error', details: String(err) });
    }

    const action = detectAction(sql);
    const tableName = extractTableName(sql);

    try {
      await query(sql);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'SQL execution failed', details: String(err) });
    }

    let schema: TableSchema | null = null;
    if (tableName) {
      const columns = await getTableSchema(tableName);
      schema = {
        tableName,
        columns: columns.map((col) => ({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable === 'YES',
        })),
      };
    }

    const response: ChatResponse = { sql, schema, action };
    return reply.send(response);
  });
}
