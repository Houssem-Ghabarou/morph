import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, runInTransaction } from '../lib/postgres';

interface SchemaChange {
  action: 'add' | 'rename' | 'retype';
  column: string;
  newName?: string;
  newType?: string;
}

const ALLOWED_TYPES = new Set([
  'text', 'integer', 'numeric', 'boolean', 'date', 'timestamp',
  'bigint', 'smallint', 'real', 'double precision', 'varchar',
]);

function sanitizeIdentifier(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

async function tableExists(tableName: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return result.rows.length > 0;
}

export default async function dataRoutes(fastify: FastifyInstance) {
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

  // Update a single row
  fastify.patch<{ Params: { tableName: string; id: string }; Body: Record<string, unknown> }>(
    '/api/data/:tableName/:id',
    async (
      request: FastifyRequest<{ Params: { tableName: string; id: string }; Body: Record<string, unknown> }>,
      reply: FastifyReply
    ) => {
      const { tableName, id } = request.params;
      if (!(await tableExists(tableName))) {
        return reply.status(404).send({ error: `Table "${tableName}" not found` });
      }
      const body = request.body;
      const columns = Object.keys(body).filter((k) => k !== 'id' && k !== 'created_at');
      if (columns.length === 0) return reply.status(400).send({ error: 'No fields to update' });

      const setClause = columns.map((c, i) => `"${sanitizeIdentifier(c)}" = $${i + 1}`).join(', ');
      const values = [...columns.map((c) => body[c]), id];
      const result = await query(
        `UPDATE "${tableName}" SET ${setClause} WHERE id = $${columns.length + 1} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return reply.status(404).send({ error: 'Row not found' });
      return reply.send({ row: result.rows[0] });
    }
  );

  // Delete a single row
  fastify.delete<{ Params: { tableName: string; id: string } }>(
    '/api/data/:tableName/:id',
    async (
      request: FastifyRequest<{ Params: { tableName: string; id: string } }>,
      reply: FastifyReply
    ) => {
      const { tableName, id } = request.params;
      if (!(await tableExists(tableName))) {
        return reply.status(404).send({ error: `Table "${tableName}" not found` });
      }
      await query(`DELETE FROM "${tableName}" WHERE id = $1`, [id]);
      return reply.send({ ok: true });
    }
  );

  // ALTER schema + INSERT in one transaction
  fastify.patch<{
    Params: { tableName: string };
    Body: { changes: SchemaChange[]; row: Record<string, unknown> };
  }>(
    '/api/data/:tableName/schema',
    async (
      request: FastifyRequest<{
        Params: { tableName: string };
        Body: { changes: SchemaChange[]; row: Record<string, unknown> };
      }>,
      reply: FastifyReply
    ) => {
      const { tableName } = request.params;
      if (!(await tableExists(tableName))) {
        return reply.status(404).send({ error: `Table "${tableName}" not found` });
      }

      const { changes, row } = request.body;

      try {
        const result = await runInTransaction(async (client) => {
          for (const change of changes) {
            const col = sanitizeIdentifier(change.column);
            if (!col) continue;

            if (change.action === 'add' && change.newType) {
              const t = change.newType.toLowerCase();
              if (!ALLOWED_TYPES.has(t)) continue;
              await client.query(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${col}" ${t}`);
            }

            if (change.action === 'rename' && change.newName) {
              const newCol = sanitizeIdentifier(change.newName);
              if (!newCol || newCol === col) continue;
              await client.query(`ALTER TABLE "${tableName}" RENAME COLUMN "${col}" TO "${newCol}"`);
            }

            if (change.action === 'retype' && change.newType) {
              const t = change.newType.toLowerCase();
              if (!ALLOWED_TYPES.has(t)) continue;
              await client.query(
                `ALTER TABLE "${tableName}" ALTER COLUMN "${col}" TYPE ${t} USING "${col}"::${t}`
              );
            }
          }

          const columns = Object.keys(row).filter((k) => k !== 'id' && k !== 'created_at');
          if (columns.length === 0) return null;

          const values = columns.map((k) => row[k]);
          const placeholders = columns.map((_, i) => `$${i + 1}`);
          const insertSql = `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(', ')})
                             VALUES (${placeholders.join(', ')})
                             RETURNING *`;
          const insertResult = await client.query(insertSql, values);
          return insertResult.rows[0];
        });

        return reply.status(201).send({ row: result, ok: true });
      } catch (err) {
        fastify.log.error(err);
        const msg = err instanceof Error ? err.message : 'Schema modification failed';
        return reply.status(400).send({ error: msg });
      }
    }
  );
}
