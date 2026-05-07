import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, runInTransaction, getTableSchema } from '../lib/postgres';
import { requireAuth } from '../lib/requireAuth';
import {
  testConnection,
  discoverSchemas,
  importTableData,
  mapTypeToPg,
  ConnectionConfig,
  ConnectionType,
} from '../lib/dbConnector';

interface ConnectionBody {
  type: ConnectionType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
  name?: string;
}

function parseConfig(body: ConnectionBody): ConnectionConfig {
  return {
    type: body.type,
    host: body.host,
    port: Number(body.port),
    database: body.database,
    username: body.username,
    password: body.password,
    ssl: body.ssl ?? false,
  };
}

function coerceForPg(value: unknown, pgType: string): unknown {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value);
  const t = pgType.toUpperCase();

  if (t === 'INTEGER') {
    const n = parseInt(str.replace(/,/g, ''), 10);
    return isNaN(n) ? null : n;
  }
  if (t === 'NUMERIC') {
    const n = parseFloat(str.replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }
  if (t === 'BOOLEAN') {
    const v = str.toLowerCase();
    if (['true', 'yes', '1', 't'].includes(v)) return true;
    if (['false', 'no', '0', 'f'].includes(v)) return false;
    return null;
  }
  if (t === 'DATE' || t === 'TIMESTAMP') {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : str;
  }
  return str;
}

export default async function connectionRoutes(fastify: FastifyInstance) {
  // POST /api/connections/test  — no auth required, just test connectivity
  fastify.post('/api/connections/test', async (
    request: FastifyRequest<{ Body: ConnectionBody }>,
    reply: FastifyReply
  ) => {
    const body = request.body as ConnectionBody;
    try {
      await testConnection(parseConfig(body));
      return reply.send({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: msg });
    }
  });

  // POST /api/connections/discover  — discover schemas (no save)
  fastify.post('/api/connections/discover', async (
    request: FastifyRequest<{ Body: ConnectionBody }>,
    reply: FastifyReply
  ) => {
    const body = request.body as ConnectionBody;
    try {
      const tables = await discoverSchemas(parseConfig(body));
      return reply.send({ tables });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  // POST /api/connections/import  — import selected tables into a session
  fastify.post('/api/connections/import', async (
    request: FastifyRequest<{
      Body: ConnectionBody & { sessionId: number; tables: string[] };
    }>,
    reply: FastifyReply
  ) => {
    const body = request.body as ConnectionBody & { sessionId: number; tables: string[] };
    const { sessionId, tables: tableNames } = body;

    if (!sessionId || !tableNames?.length) {
      return reply.status(400).send({ error: 'sessionId and tables are required' });
    }

    const config = parseConfig(body);
    const results: Array<{ tableName: string; rowsImported: number; error?: string }> = [];

    for (const srcTable of tableNames) {
      try {
        const { columns, rows } = await importTableData(config, srcTable);

        // Only import columns that can be mapped to a PG type
        const pgCols = columns.map((c) => ({ name: c.name, pgType: mapTypeToPg(c.type) }));

        const destTable = `s${sessionId}_${srcTable.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;

        // Fetch existing session tables to check if this table already exists
        const existingRes = await query(
          `SELECT table_name FROM morph_session_tables WHERE session_id = $1 AND table_name = $2`,
          [sessionId, destTable]
        );

        await runInTransaction(async (client) => {
          if (existingRes.rows.length === 0) {
            const colDefs = pgCols.map((c) => `"${c.name}" ${c.pgType}`).join(',\n  ');
            await client.query(`
              CREATE TABLE IF NOT EXISTS "${destTable}" (
                id SERIAL PRIMARY KEY,
                ${colDefs},
                created_at TIMESTAMP DEFAULT NOW()
              )
            `);
            await client.query(
              `INSERT INTO morph_session_tables (session_id, table_name)
               VALUES ($1, $2) ON CONFLICT (session_id, table_name) DO NOTHING`,
              [sessionId, destTable]
            );
          }

          // Insert rows in batches of 500
          const BATCH = 500;
          for (let i = 0; i < rows.length; i += BATCH) {
            const batch = rows.slice(i, i + BATCH);
            for (const row of batch) {
              const vals = pgCols.map((c) => coerceForPg(row[c.name], c.pgType));
              const colList = pgCols.map((c) => `"${c.name}"`).join(', ');
              const placeholders = pgCols.map((_, idx) => `$${idx + 1}`).join(', ');
              await client.query(
                `INSERT INTO "${destTable}" (${colList}) VALUES (${placeholders})`,
                vals
              );
            }
          }
        });

        results.push({ tableName: destTable, rowsImported: rows.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ tableName: srcTable, rowsImported: 0, error: msg });
      }
    }

    return reply.send({ results });
  });

  // GET /api/connections  — list saved connections for auth'd user
  fastify.get('/api/connections', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAuth(request, reply);
    if (!user) return;

    const res = await query(
      `SELECT id, name, type, host, port, database_name, username, ssl, created_at
       FROM morph_connections WHERE user_id = $1 ORDER BY created_at DESC`,
      [user.userId]
    );
    return reply.send({ connections: res.rows });
  });

  // POST /api/connections  — save a connection
  fastify.post('/api/connections', async (
    request: FastifyRequest<{ Body: ConnectionBody & { name: string } }>,
    reply: FastifyReply
  ) => {
    const user = await requireAuth(request, reply);
    if (!user) return;

    const body = request.body as ConnectionBody & { name: string };

    // Test before saving
    try {
      await testConnection(parseConfig(body));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: `Connection failed: ${msg}` });
    }

    const res = await query(
      `INSERT INTO morph_connections (user_id, name, type, host, port, database_name, username, password, ssl)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, name, type, host, port, database_name, username, ssl`,
      [user.userId, body.name || `${body.type}@${body.host}`, body.type, body.host, body.port,
       body.database, body.username, body.password, body.ssl ?? false]
    );
    return reply.status(201).send({ connection: res.rows[0] });
  });

  // DELETE /api/connections/:id
  fastify.delete<{ Params: { id: string } }>(
    '/api/connections/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(request, reply);
      if (!user) return;

      await query(
        `DELETE FROM morph_connections WHERE id = $1 AND user_id = $2`,
        [request.params.id, user.userId]
      );
      return reply.send({ ok: true });
    }
  );

  // POST /api/connections/:id/discover  — discover schemas for a saved connection
  fastify.post<{ Params: { id: string } }>(
    '/api/connections/:id/discover',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(request, reply);
      if (!user) return;

      const res = await query(
        `SELECT * FROM morph_connections WHERE id = $1 AND user_id = $2`,
        [request.params.id, user.userId]
      );
      if (res.rows.length === 0) return reply.status(404).send({ error: 'Connection not found' });

      const row = res.rows[0];
      const config: ConnectionConfig = {
        type: row.type as ConnectionType,
        host: row.host,
        port: row.port,
        database: row.database_name,
        username: row.username,
        password: row.password,
        ssl: row.ssl,
      };

      try {
        const tables = await discoverSchemas(config);
        return reply.send({ tables });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    }
  );

  // POST /api/connections/:id/import  — import from saved connection
  fastify.post<{ Params: { id: string }; Body: { sessionId: number; tables: string[] } }>(
    '/api/connections/:id/import',
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: { sessionId: number; tables: string[] } }>,
      reply: FastifyReply
    ) => {
      const user = await requireAuth(request, reply);
      if (!user) return;

      const res = await query(
        `SELECT * FROM morph_connections WHERE id = $1 AND user_id = $2`,
        [request.params.id, user.userId]
      );
      if (res.rows.length === 0) return reply.status(404).send({ error: 'Connection not found' });

      const row = res.rows[0];
      const config: ConnectionConfig = {
        type: row.type as ConnectionType,
        host: row.host,
        port: row.port,
        database: row.database_name,
        username: row.username,
        password: row.password,
        ssl: row.ssl,
      };

      const { sessionId, tables: tableNames } = request.body;
      const results: Array<{ tableName: string; rowsImported: number; error?: string }> = [];

      for (const srcTable of tableNames) {
        try {
          const { columns, rows: dataRows } = await importTableData(config, srcTable);
          const pgCols = columns.map((c) => ({ name: c.name, pgType: mapTypeToPg(c.type) }));
          const destTable = `s${sessionId}_${srcTable.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;

          const existingRes = await query(
            `SELECT table_name FROM morph_session_tables WHERE session_id = $1 AND table_name = $2`,
            [sessionId, destTable]
          );

          await runInTransaction(async (client) => {
            if (existingRes.rows.length === 0) {
              const colDefs = pgCols.map((c) => `"${c.name}" ${c.pgType}`).join(',\n  ');
              await client.query(`
                CREATE TABLE IF NOT EXISTS "${destTable}" (
                  id SERIAL PRIMARY KEY,
                  ${colDefs},
                  created_at TIMESTAMP DEFAULT NOW()
                )
              `);
              await client.query(
                `INSERT INTO morph_session_tables (session_id, table_name)
                 VALUES ($1, $2) ON CONFLICT (session_id, table_name) DO NOTHING`,
                [sessionId, destTable]
              );
            }

            const BATCH = 500;
            for (let i = 0; i < dataRows.length; i += BATCH) {
              const batch = dataRows.slice(i, i + BATCH);
              for (const dataRow of batch) {
                const vals = pgCols.map((c) => coerceForPg(dataRow[c.name], c.pgType));
                const colList = pgCols.map((c) => `"${c.name}"`).join(', ');
                const placeholders = pgCols.map((_, idx) => `$${idx + 1}`).join(', ');
                await client.query(
                  `INSERT INTO "${destTable}" (${colList}) VALUES (${placeholders})`,
                  vals
                );
              }
            }
          });

          results.push({ tableName: destTable, rowsImported: dataRows.length });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ tableName: srcTable, rowsImported: 0, error: msg });
        }
      }

      return reply.send({ results });
    }
  );
}
