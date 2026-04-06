import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parse } from 'csv-parse/sync';
import { query, runInTransaction, getTableSchema } from '../lib/postgres';
import { analyzeCSV, ColumnSuggestion, ColumnMapping } from '../lib/csvImport';

function coerceValue(value: string | null | undefined, pgType: string): unknown {
  if (value === undefined || value === null || value === '') return null;
  const type = pgType.toUpperCase();

  if (type === 'INTEGER') {
    const cleaned = value.replace(/,/g, '').trim();
    const n = parseInt(cleaned, 10);
    return isNaN(n) ? null : n;
  }
  if (type === 'NUMERIC') {
    const cleaned = value.replace(/,/g, '').trim();
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
  if (type === 'BOOLEAN') {
    const v = value.trim().toLowerCase();
    if (['true', 'yes', '1', 't'].includes(v)) return true;
    if (['false', 'no', '0', 'f'].includes(v)) return false;
    return null;
  }
  if (type === 'DATE' || type === 'TIMESTAMP') {
    const v = value.trim();
    // Must look like an actual date: YYYY-MM-DD, MM/DD/YYYY, "Jan 15 2024", etc.
    const looksLikeDate = /^\d{4}-\d{2}-\d{2}/.test(v) ||
      /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(v) ||
      /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(v);
    if (!looksLikeDate) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : v;
  }
  return value;
}

interface ConfirmNewBody {
  flow: 'new';
  sessionId: number;
  tableName: string;
  columns: ColumnSuggestion[];
  headers: string[];
  rows: string[][];
}

interface ConfirmExistingBody {
  flow: 'existing';
  tableName: string;
  mapping: ColumnMapping[];
  headers: string[];
  rows: string[][];
}

export default async function importRoutes(fastify: FastifyInstance) {
  // POST /api/import/analyze
  // Accepts multipart form-data: field "csv" (file), field "sessionId" (text)
  fastify.post<{ Querystring: { sessionId: string; description?: string } }>(
    '/api/import/analyze',
    async (request: FastifyRequest<{ Querystring: { sessionId: string; description?: string } }>, reply: FastifyReply) => {
      const sessionId = parseInt(request.query.sessionId, 10);
      const projectDescription = request.query.description ?? '';
      if (isNaN(sessionId)) {
        return reply.status(400).send({ error: 'sessionId query param is required' });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const file = await (request as any).file();
      if (!file) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      const { filename, mimetype } = file;
      const isCSV =
        filename?.toLowerCase().endsWith('.csv') ||
        mimetype === 'text/csv' ||
        mimetype === 'application/csv' ||
        mimetype === 'application/vnd.ms-excel';

      if (!isCSV) {
        return reply.status(400).send({ error: 'Only CSV files are accepted (.csv)' });
      }

      const buffer: Buffer = await file.toBuffer();
      const csvText = buffer.toString('utf-8');

      let records: string[][];
      try {
        records = parse(csvText, {
          skip_empty_lines: true,
          relax_column_count: true,
          trim: true,
        }) as string[][];
      } catch {
        return reply.status(400).send({ error: 'Invalid or malformed CSV' });
      }

      if (records.length < 2) {
        return reply.status(400).send({ error: 'CSV must have a header row and at least one data row' });
      }

      const [headers, ...dataRows] = records;

      if (headers.length === 0) {
        return reply.status(400).send({ error: 'CSV has no columns' });
      }

      // Get session tables
      const sessionTablesResult = await query(
        `SELECT table_name FROM morph_session_tables WHERE session_id = $1`,
        [sessionId]
      );
      const sessionTableNames: string[] = sessionTablesResult.rows.map((r) => r.table_name as string);

      // Fetch schemas for existing tables
      const existingTables = await Promise.all(
        sessionTableNames.map(async (tableName) => {
          const columns = await getTableSchema(tableName);
          return { tableName, columns };
        })
      );

      const suggestion = await analyzeCSV(headers, dataRows.slice(0, 5), existingTables, projectDescription);

      return reply.send({
        ...suggestion,
        headers,
        rows: dataRows,
      });
    }
  );

  // POST /api/import/confirm
  // JSON body with confirmed mapping + full rows
  fastify.post(
    '/api/import/confirm',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as ConfirmNewBody | ConfirmExistingBody;
      const { flow, rows, headers } = body as { flow: string; rows: string[][]; headers: string[] };

      if (!rows || rows.length === 0) {
        return reply.status(400).send({ error: 'No rows to import' });
      }

      if (flow === 'new') {
        const { sessionId, tableName, columns } = body as ConfirmNewBody;
        const fullTableName = `s${sessionId}_${tableName}`;

        const colDefs = columns.map((c) => `"${c.pgName}" ${c.pgType}`).join(',\n          ');
        const createSQL = `CREATE TABLE "${fullTableName}" (
          id SERIAL PRIMARY KEY,
          ${colDefs},
          created_at TIMESTAMP DEFAULT NOW()
        )`;

        try {
          await runInTransaction(async (client) => {
            await client.query(createSQL);

            await client.query(
              `INSERT INTO morph_session_tables (session_id, table_name)
               VALUES ($1, $2)
               ON CONFLICT (session_id, table_name) DO NOTHING`,
              [sessionId, fullTableName]
            );

            for (const row of rows) {
              const vals = columns.map((c, i) => {
                return coerceValue(row[i], c.pgType);
              });
              const colList = columns.map((c) => `"${c.pgName}"`).join(', ');
              const placeholders = columns.map((_c, i) => `$${i + 1}`).join(', ');
              await client.query(
                `INSERT INTO "${fullTableName}" (${colList}) VALUES (${placeholders})`,
                vals
              );
            }
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.status(500).send({ error: 'Import failed', details: msg });
        }

        return reply.send({ rowsImported: rows.length, tableName: fullTableName });
      }

      if (flow === 'existing') {
        const { tableName, mapping } = body as ConfirmExistingBody;
        const activeMappings = mapping.filter((m) => m.tableColumn !== null);

        if (activeMappings.length === 0) {
          return reply.status(400).send({ error: 'No columns are mapped — nothing to import' });
        }

        const tableSchema = await getTableSchema(tableName);
        const colTypeMap: Record<string, string> = {};
        for (const col of tableSchema) {
          colTypeMap[col.column_name] = col.data_type.toUpperCase();
        }

        try {
          await runInTransaction(async (client) => {
            for (const row of rows) {
              const vals = activeMappings.map((m) => {
                const idx = headers.indexOf(m.csvHeader);
                const v = idx >= 0 ? row[idx] : null;
                const pgType = m.tableColumn ? (colTypeMap[m.tableColumn] ?? 'TEXT') : 'TEXT';
                return coerceValue(v, pgType);
              });
              const colList = activeMappings.map((m) => `"${m.tableColumn}"`).join(', ');
              const placeholders = activeMappings.map((_m, i) => `$${i + 1}`).join(', ');
              await client.query(
                `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders})`,
                vals
              );
            }
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.status(500).send({ error: 'Import failed', details: msg });
        }

        return reply.send({ rowsImported: rows.length, tableName });
      }

      return reply.status(400).send({ error: 'Invalid flow — must be "new" or "existing"' });
    }
  );
}
