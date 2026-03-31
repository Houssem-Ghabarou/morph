import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateSQL, generateSuggestion } from '../lib/claude';
import { query, getTableSchema, runInTransaction } from '../lib/postgres';
import { ChatRequest, ChatResponse, TableSchema } from '../types';

const PG_DUPLICATE_TABLE = '42P07';

function detectChartType(sql: string, rows: Record<string, unknown>[]): 'bar' | 'stat' | 'table' {
  const upper = sql.toUpperCase();
  const hasGroupBy = upper.includes('GROUP BY');
  const hasAggregate = /\b(COUNT|SUM|AVG|MAX|MIN)\s*\(/.test(upper);
  if (rows.length === 1 && Object.keys(rows[0]).length <= 2 && !hasGroupBy) return 'stat';
  if (hasGroupBy && hasAggregate) return 'bar';
  return 'table';
}

function buildQueryMessage(chartType: 'bar' | 'stat' | 'table', rows: Record<string, unknown>[], _userMessage: string): string {
  if (rows.length === 0) return 'The query returned no results.';
  if (chartType === 'stat') {
    const val = Object.values(rows[0])[0];
    const label = Object.keys(rows[0])[0].replace(/_/g, ' ');
    return `${label}: **${val}**`;
  }
  if (chartType === 'bar') return `Here's the breakdown — ${rows.length} group${rows.length !== 1 ? 's' : ''}.`;
  return `Query returned ${rows.length} row${rows.length !== 1 ? 's' : ''}.`;
}

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

function buildMessage(
  action: ChatResponse['action'],
  schema: TableSchema | null,
  alreadyExisted: boolean
): string {
  const name = schema?.tableName ?? 'table';
  const cols = schema?.columns
    .filter((c) => c.name !== 'id' && c.name !== 'created_at')
    .map((c) => c.name) ?? [];

  if (action === 'create') {
    if (alreadyExisted) {
      return `Table \`${name}\` already exists — here it is. Columns: ${cols.join(', ')}.`;
    }
    return `Table \`${name}\` created with ${cols.length} column${cols.length !== 1 ? 's' : ''}: ${cols.join(', ')}.`;
  }
  if (action === 'alter') {
    return `Table \`${name}\` updated. Current columns: ${cols.join(', ')}.`;
  }
  if (action === 'insert') {
    return `Done — row added to \`${name}\`.`;
  }
  return 'Done.';
}

export default async function chatRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: ChatRequest }>(
    '/api/chat',
    async (request: FastifyRequest<{ Body: ChatRequest }>, reply: FastifyReply) => {
      const { message, sessionId } = request.body;

      if (!message || message.trim() === '') {
        return reply.status(400).send({ error: 'Message is required' });
      }
      if (!sessionId) {
        return reply.status(400).send({ error: 'sessionId is required' });
      }

      // Build session context so the LLM knows which tables exist and their schemas
      let sessionContext = '';
      try {
        const sessionTables = await query(
          `SELECT table_name FROM morph_session_tables WHERE session_id = $1`,
          [sessionId]
        );
        if (sessionTables.rows.length > 0) {
          const schemaLines = await Promise.all(
            sessionTables.rows.map(async (row: { table_name: string }) => {
              const cols = await getTableSchema(row.table_name);
              const colDefs = cols
                .filter((c) => c.column_name !== 'id' && c.column_name !== 'created_at')
                .map((c) => `${c.column_name} (${c.data_type})`)
                .join(', ');
              return `- ${row.table_name}: ${colDefs}`;
            })
          );
          sessionContext = `Tables already in this session:\n${schemaLines.join('\n')}`;
        }
      } catch {
        // Context is best-effort — don't block the request
      }

      let sql: string;
      try {
        sql = await generateSQL(message, sessionContext);
      } catch (err) {
        fastify.log.error(err);
        return reply.status(502).send({ error: 'Could not reach the LLM. Check your API key.' });
      }

      // Handle PREFILL response from LLM
      if (sql.startsWith('PREFILL|')) {
        const parts = sql.split('|');
        const prefillTableName = parts[1];
        let prefillValues: Record<string, unknown> = {};
        try {
          prefillValues = JSON.parse(parts.slice(2).join('|'));
        } catch {
          fastify.log.warn('Failed to parse PREFILL JSON, using empty values');
        }

        let prefillSchema: TableSchema | null = null;
        try {
          const columns = await getTableSchema(prefillTableName);
          prefillSchema = {
            tableName: prefillTableName,
            columns: columns.map((col) => ({
              name: col.column_name,
              type: col.data_type,
              nullable: col.is_nullable === 'YES',
            })),
          };
        } catch {
          fastify.log.error('Failed to get schema for prefill table: ' + prefillTableName);
          return reply.status(500).send({ error: 'Could not fetch table schema for prefill' });
        }

        // Save only the user message for prefill — no system response yet
        let sessionName: string | undefined;
        await runInTransaction(async (client) => {
          await client.query(
            `INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'user', $2)`,
            [sessionId, message]
          );
          const nameResult = await client.query(
            `UPDATE morph_sessions
             SET name = LEFT($2, 45), updated_at = NOW()
             WHERE id = $1 AND name = 'New Chat'
             RETURNING name`,
            [sessionId, message]
          );
          if (nameResult.rows.length > 0) {
            sessionName = nameResult.rows[0].name;
          } else {
            await client.query(
              `UPDATE morph_sessions SET updated_at = NOW() WHERE id = $1`,
              [sessionId]
            );
          }
        });

        const prefillResponse: ChatResponse = {
          sql,
          message: `Ready to insert into \`${prefillTableName}\`. Review the form below.`,
          schema: prefillSchema,
          action: 'prefill',
          alreadyExisted: false,
          values: prefillValues,
          ...(sessionName ? { sessionName } : {}),
        };
        return reply.send(prefillResponse);
      }

      const action = detectAction(sql);

      if (action === 'select') {
        let rows: Record<string, unknown>[] = [];
        try {
          const result = await query(sql);
          rows = result.rows;
        } catch (err) {
          fastify.log.error(err);
          return reply.status(500).send({ error: 'Query execution failed', details: String(err) });
        }

        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        const chartType = detectChartType(sql, rows);
        const queryMessage = buildQueryMessage(chartType, rows, message);

        await runInTransaction(async (client) => {
          await client.query(
            `INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'user', $2)`,
            [sessionId, message]
          );
          await client.query(
            `INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'system', $2)`,
            [sessionId, queryMessage]
          );
          await client.query(
            `UPDATE morph_sessions SET updated_at = NOW() WHERE id = $1`,
            [sessionId]
          );
        });

        return reply.send({
          sql,
          message: queryMessage,
          schema: null,
          action: 'query',
          rows,
          columns,
          chartType,
        } satisfies ChatResponse);
      }

      const tableName = extractTableName(sql);
      let alreadyExisted = false;

      try {
        await query(sql);
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === PG_DUPLICATE_TABLE) {
          alreadyExisted = true;
        } else {
          fastify.log.error(err);
          return reply.status(500).send({ error: 'SQL execution failed', details: String(err) });
        }
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

      const responseMessage = buildMessage(action, schema, alreadyExisted);

      // Generate insert suggestion for new tables (non-blocking on failure)
      let suggestion: string | undefined;
      if (action === 'create' && schema && !alreadyExisted) {
        const userCols = schema.columns
          .filter((c) => c.name !== 'id' && c.name !== 'created_at')
          .map((c) => c.name);
        suggestion = await generateSuggestion(message, schema.tableName, userCols);
      }

      // Persist messages + register table + touch session — all in one transaction
      let sessionName: string | undefined;
      await runInTransaction(async (client) => {
        // Save user message
        await client.query(
          `INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'user', $2)`,
          [sessionId, message]
        );

        // Save system response
        await client.query(
          `INSERT INTO morph_messages (session_id, role, text, warning) VALUES ($1, 'system', $2, $3)`,
          [sessionId, responseMessage, alreadyExisted ?? false]
        );

        // Save suggestion as a separate follow-up message
        if (suggestion) {
          await client.query(
            `INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'system', $2)`,
            [sessionId, suggestion]
          );
        }

        // Register table in session (for CREATE and ALTER)
        if ((action === 'create' || action === 'alter') && tableName) {
          await client.query(
            `INSERT INTO morph_session_tables (session_id, table_name)
             VALUES ($1, $2)
             ON CONFLICT (session_id, table_name) DO NOTHING`,
            [sessionId, tableName]
          );
        }

        // Auto-name session from first user message (only if still default)
        const nameResult = await client.query(
          `UPDATE morph_sessions
           SET name = LEFT($2, 45), updated_at = NOW()
           WHERE id = $1 AND name = 'New Chat'
           RETURNING name`,
          [sessionId, message]
        );
        if (nameResult.rows.length > 0) {
          sessionName = nameResult.rows[0].name;
        } else {
          await client.query(
            `UPDATE morph_sessions SET updated_at = NOW() WHERE id = $1`,
            [sessionId]
          );
        }
      });

      const response: ChatResponse = {
        sql,
        message: responseMessage,
        schema,
        action,
        alreadyExisted,
        ...(sessionName ? { sessionName } : {}),
        ...(suggestion ? { suggestion } : {}),
      };
      return reply.send(response);
    }
  );
}
