import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateSQL, generateSuggestion, interpretQueryResult } from '../lib/claude';
import { query, getTableSchema, runInTransaction } from '../lib/postgres';
import { ChatRequest, ChatResponse, TableSchema, Relation } from '../types';

const PG_DUPLICATE_TABLE = '42P07';

function sessionPrefix(sessionId: number): string {
  return `s${sessionId}_`;
}

function stripPrefix(name: string, prefix: string): string {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * Rewrites SQL table names for session isolation.
 * - CREATE TABLE wood_inventory → CREATE TABLE s3_wood_inventory (and adds to tableMap)
 * - INSERT/ALTER/SELECT → replaces known display names with their actual DB names
 * - PREFILL|tableName|... → replaces tableName with actual DB name
 */
/**
 * Fix common LLM SQL mistakes before execution:
 * - Table/column names with spaces → snake_case
 * - Stray backtick quoting (MySQL style) → remove
 */
function sanitizeSQL(sql: string): string {
  sql = sql.replace(/`(\w+)`/g, '$1');
  sql = sql.replace(
    /(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)([a-z][a-z0-9]*(?:\s+[a-z][a-z0-9]*)+)(\s*\()/gi,
    (_m, pre, name, paren) => pre + name.trim().replace(/\s+/g, '_') + paren
  );
  // Strip markdown code fences that LLMs sometimes emit
  sql = sql.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```\s*$/, '');
  // Remove leading/trailing whitespace and stray semicolons at the end
  sql = sql.trim().replace(/;\s*$/, '');
  return sql;
}

/** Convert = 'value' → ILIKE 'value' in SELECT queries so name lookups are case-insensitive. */
function makeSelectCaseInsensitive(sql: string): string {
  // Only apply to SELECT statements
  if (!sql.trimStart().toUpperCase().startsWith('SELECT')) return sql;
  // Replace col = 'value' with col ILIKE 'value' (not col != or col >= etc.)
  return sql.replace(/(?<![!<>])=\s*'([^']*)'/g, "ILIKE '$1'");
}

function rewriteSQLForSession(
  sql: string,
  tableMap: Map<string, string>,
  prefix: string
): string {
  if (sql.startsWith('PREFILL|')) {
    const parts = sql.split('|');
    const display = parts[1];
    const actual = tableMap.get(display) ?? (prefix + display);
    return `PREFILL|${actual}|${parts.slice(2).join('|')}`;
  }

  const createMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i);
  if (createMatch) {
    const raw = createMatch[1];
    let result = sql;
    const sorted = [...tableMap.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [display, actual] of sorted) {
      result = result.replace(new RegExp(`\\b${display}\\b`, 'g'), actual);
    }
    // Prefix the new table name itself
    if (!raw.startsWith(prefix)) {
      const actual = prefix + raw;
      tableMap.set(raw, actual);
      result = result.replace(new RegExp(`\\b${raw}\\b`, 'g'), actual);
    }
    return result;
  }

  let result = sql;
  const sorted = [...tableMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [display, actual] of sorted) {
    result = result.replace(new RegExp(`\\b${display}\\b`, 'g'), actual);
  }
  return result;
}

/** Parse INSERT INTO table (col1, col2) VALUES (val1, val2) into { col1: val1, col2: val2 } */
function parseInsertValues(sql: string, schema: TableSchema): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const userCols = schema.columns.filter((c) => c.name !== 'id' && c.name !== 'created_at' && c.name !== 'updated_at');

  // Initialize all columns with empty strings
  for (const col of userCols) values[col.name] = '';

  try {
    const colMatch = sql.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)/i);
    const valMatch = sql.match(/VALUES\s*\(([^)]+)\)/i);
    if (!colMatch || !valMatch) return values;

    const cols = colMatch[1].split(',').map((c) => c.trim().replace(/"/g, ''));
    const rawVals = valMatch[1];

    // Parse values respecting quoted strings
    const parsedVals: string[] = [];
    let current = '';
    let inQuote = false;
    for (const char of rawVals) {
      if (char === "'" && !inQuote) { inQuote = true; continue; }
      if (char === "'" && inQuote) { inQuote = false; continue; }
      if (char === ',' && !inQuote) { parsedVals.push(current.trim()); current = ''; continue; }
      current += char;
    }
    parsedVals.push(current.trim());

    for (let i = 0; i < cols.length && i < parsedVals.length; i++) {
      const colName = cols[i];
      let val: unknown = parsedVals[i];
      if (val === 'NULL' || val === 'null') val = '';
      else if (val === 'NOW()' || val === 'CURRENT_DATE') val = new Date().toISOString().split('T')[0];
      else if (!isNaN(Number(val)) && val !== '') val = Number(val);
      const schemaCol = userCols.find((c) => c.name === colName);
      if (schemaCol) values[colName] = val;
    }
  } catch {
    // Best-effort parsing — return whatever we got
  }

  return values;
}

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
  alreadyExisted: boolean,
  prefix: string = ''
): string {
  const name = stripPrefix(schema?.tableName ?? 'table', prefix);
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

/** Derive relations by matching text column names against known session table names. */
function deriveRelations(schemas: TableSchema[], prefix: string): Relation[] {
  const relations: Relation[] = [];
  const tableNames = schemas.map((s) => s.tableName);

  for (const schema of schemas) {
    for (const col of schema.columns) {
      if (['id', 'created_at', 'updated_at'].includes(col.name)) continue;
      if (col.type !== 'text' && !col.type.includes('char')) continue;

      const colNorm = col.name.toLowerCase();
      for (const other of tableNames) {
        if (other === schema.tableName) continue;
        const otherBase = other.replace(new RegExp(`^${prefix.replace(/\d/, '\\d')}`), '').toLowerCase();
        if (colNorm === otherBase || colNorm + 's' === otherBase || colNorm === otherBase + 's') {
          relations.push({ from: schema.tableName, to: other, on: col.name });
          break;
        }
      }
    }
  }
  return relations;
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
      const prefix = sessionPrefix(sessionId);
      // display_name -> actual_db_name (actual names are prefixed with session prefix)
      const tableMap = new Map<string, string>();
      let sessionContext = '';
      try {
        const sessionTables = await query(
          `SELECT table_name FROM morph_session_tables WHERE session_id = $1`,
          [sessionId]
        );
        if (sessionTables.rows.length > 0) {
          const allSchemas: TableSchema[] = [];

          const schemaLines = await Promise.all(
            sessionTables.rows.map(async (row: { table_name: string }) => {
              const actual = row.table_name;
              const display = stripPrefix(actual, prefix);
              tableMap.set(display, actual);
              const cols = await getTableSchema(actual);

              allSchemas.push({
                tableName: actual,
                columns: cols.map((c) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES' })),
              });

              const colDefs = cols
                .filter((c) => c.column_name !== 'id' && c.column_name !== 'created_at')
                .map((c) => `${c.column_name} (${c.data_type})`)
                .join(', ');

              let sampleLine = '';
              try {
                const countRes = await query(`SELECT COUNT(*) AS cnt FROM "${actual}"`);
                const rowCount = countRes.rows[0]?.cnt ?? 0;
                const sample = await query(
                  `SELECT * FROM "${actual}" ORDER BY id DESC LIMIT 3`
                );
                if (sample.rows.length > 0) {
                  const previews = sample.rows.map((sRow) => {
                    const preview = Object.fromEntries(
                      Object.entries(sRow as Record<string, unknown>).filter(([k]) => k !== 'id' && k !== 'created_at')
                    );
                    return JSON.stringify(preview);
                  });
                  sampleLine = `\n  rows (${rowCount} total): ${previews.join(', ')}`;
                } else {
                  sampleLine = `\n  rows: 0 (empty table)`;
                }
              } catch {
                // Sample is best-effort
              }

              return `- ${display}: ${colDefs}${sampleLine}`;
            })
          );

          // Derive and include existing relations so LLM knows how tables are linked
          const existingRelations = deriveRelations(allSchemas, prefix);
          let relSection = '';
          if (existingRelations.length > 0) {
            const relLines = existingRelations.map((r) => {
              const fromDisplay = stripPrefix(r.from, prefix);
              const toDisplay = stripPrefix(r.to, prefix);
              return `- ${fromDisplay}.${r.on} → ${toDisplay}`;
            });
            relSection = `\n\nExisting relations:\n${relLines.join('\n')}`;
          }

          sessionContext = `Tables already in this session:\n${schemaLines.join('\n')}${relSection}`;
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

      // Sanitize common LLM SQL mistakes
      sql = sanitizeSQL(sql);

      // Detect multi-table response (statements separated by ---)
      const rawStatements = sql.split(/^\s*---\s*$/m).map((s) => s.trim()).filter(Boolean);

      if (rawStatements.length > 1) {
        // Rewrite each statement in order (tableMap accumulates across statements)
        const statements = rawStatements.map((s) => rewriteSQLForSession(s, tableMap, prefix));

        const schemas: TableSchema[] = [];
        const relations: Relation[] = [];

        for (const stmt of statements) {
          if (!detectAction(stmt).startsWith('create') && detectAction(stmt) !== 'create') continue;
          try {
            await query(stmt);
          } catch (err: unknown) {
            const pgErr = err as { code?: string };
            if (pgErr.code !== PG_DUPLICATE_TABLE) {
              fastify.log.error(err); // skip bad statement, continue with others
              continue;
            }
          }
          const tName = extractTableName(stmt);
          if (tName) {
            const cols = await getTableSchema(tName);
            schemas.push({
              tableName: tName,
              columns: cols.map((c) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES' })),
            });
          }
        }

        // Derive relations from column name ↔ table name matching (no FK constraints needed)
        relations.push(...deriveRelations(schemas, prefix));

        const tableNames = schemas.map((s) => s.tableName);
        const displayNames = tableNames.map((n) => stripPrefix(n, prefix));
        const responseMessage = `Created ${schemas.length} linked tables: ${displayNames.map((n) => `\`${n}\``).join(', ')}.`;

        let sessionName: string | undefined;
        await runInTransaction(async (client) => {
          await client.query(
            `INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'user', $2)`,
            [sessionId, message]
          );
          await client.query(
            `INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'system', $2)`,
            [sessionId, responseMessage]
          );
          for (const tName of tableNames) {
            await client.query(
              `INSERT INTO morph_session_tables (session_id, table_name)
               VALUES ($1, $2) ON CONFLICT (session_id, table_name) DO NOTHING`,
              [sessionId, tName]
            );
          }
          const nameResult = await client.query(
            `UPDATE morph_sessions SET name = LEFT($2, 45), updated_at = NOW()
             WHERE id = $1 AND name = 'New Chat' RETURNING name`,
            [sessionId, message]
          );
          if (nameResult.rows.length > 0) {
            sessionName = nameResult.rows[0].name;
          } else {
            await client.query(`UPDATE morph_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);
          }
        });

        return reply.send({
          sql: statements.join('\n---\n'),
          message: responseMessage,
          schema: null,
          action: 'create_many',
          schemas,
          relations,
          ...(sessionName ? { sessionName } : {}),
        } satisfies ChatResponse);
      }

      // Single-statement path: rewrite table names
      sql = rewriteSQLForSession(sql, tableMap, prefix);

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
          message: `Ready to insert into \`${stripPrefix(prefillTableName, prefix)}\`. Review the form below.`,
          schema: prefillSchema,
          action: 'prefill',
          alreadyExisted: false,
          values: prefillValues,
          ...(sessionName ? { sessionName } : {}),
        };
        return reply.send(prefillResponse);
      }

      const action = detectAction(sql);

      // Intercept INSERT: convert to PREFILL so the user always gets a confirmation panel
      if (action === 'insert') {
        const insertTableName = extractTableName(sql);
        if (insertTableName) {
          let insertSchema: TableSchema | null = null;
          try {
            const cols = await getTableSchema(insertTableName);
            insertSchema = {
              tableName: insertTableName,
              columns: cols.map((c) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES' })),
            };
          } catch {
            fastify.log.warn('Could not fetch schema for INSERT table: ' + insertTableName);
          }

          if (insertSchema) {
            const extractedValues = parseInsertValues(sql, insertSchema);

            let sessionName: string | undefined;
            await runInTransaction(async (client) => {
              await client.query(
                `INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'user', $2)`,
                [sessionId, message]
              );
              const nameResult = await client.query(
                `UPDATE morph_sessions SET name = LEFT($2, 45), updated_at = NOW()
                 WHERE id = $1 AND name = 'New Chat' RETURNING name`,
                [sessionId, message]
              );
              if (nameResult.rows.length > 0) {
                sessionName = nameResult.rows[0].name;
              } else {
                await client.query(`UPDATE morph_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);
              }
            });

            return reply.send({
              sql,
              message: `Ready to insert into \`${stripPrefix(insertTableName, prefix)}\`. Review the form below.`,
              schema: insertSchema,
              action: 'prefill',
              alreadyExisted: false,
              values: extractedValues,
              ...(sessionName ? { sessionName } : {}),
            } satisfies ChatResponse);
          }
        }
      }

      if (action === 'select') {
        sql = makeSelectCaseInsensitive(sql);
        let rows: Record<string, unknown>[] = [];
        try {
          const result = await query(sql);
          rows = result.rows;
        } catch (err) {
          fastify.log.error(err);
          const errMsg = 'I couldn\'t run that query. Try rephrasing — for example, "show me all [table]" or "total [column] by [group]".';
          await runInTransaction(async (client) => {
            await client.query(`INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'user', $2)`, [sessionId, message]);
            await client.query(`INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'system', $2)`, [sessionId, errMsg]);
            await client.query(`UPDATE morph_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);
          });
          return reply.send({ sql, message: errMsg, schema: null, action: 'unknown' } satisfies ChatResponse);
        }

        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        const chartType = detectChartType(sql, rows);

        // Fetch all session table data for accurate interpretation
        let fullSessionData: string | undefined;
        try {
          const tableEntries = await Promise.all(
            Array.from(tableMap.entries()).map(async ([display, actual]) => {
              const res = await query(`SELECT * FROM "${actual}" ORDER BY id ASC LIMIT 100`);
              if (res.rows.length === 0) return `=== ${display} (0 rows) ===\n(empty)`;
              const cleaned = res.rows.map((r) => {
                const { id: _id, created_at: _ca, ...rest } = r as Record<string, unknown> & { id: unknown; created_at: unknown };
                return rest;
              });
              return `=== ${display} (${res.rows.length} rows) ===\n${cleaned.map((r) => JSON.stringify(r)).join('\n')}`;
            })
          );
          fullSessionData = tableEntries.join('\n\n');
        } catch {
          // Best-effort — don't block
        }

        // Get a natural-language interpretation of the results
        const interpretation = await interpretQueryResult(message, rows, sessionContext, fullSessionData);
        const queryMessage = interpretation || buildQueryMessage(chartType, rows, message);

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
          const errMsg = 'I couldn\'t apply that change. Try rephrasing with more detail — be explicit about what you want to create or modify and what columns it should have.';
          await runInTransaction(async (client) => {
            await client.query(`INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'user', $2)`, [sessionId, message]);
            await client.query(`INSERT INTO morph_messages (session_id, role, text) VALUES ($1, 'system', $2)`, [sessionId, errMsg]);
            await client.query(`UPDATE morph_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);
          });
          return reply.send({ sql, message: errMsg, schema: null, action: 'unknown' } satisfies ChatResponse);
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

      const responseMessage = buildMessage(action, schema, alreadyExisted, prefix);

      // Generate insert suggestion for new tables (non-blocking on failure)
      let suggestion: string | undefined;
      if (action === 'create' && schema && !alreadyExisted) {
        const userCols = schema.columns
          .filter((c) => c.name !== 'id' && c.name !== 'created_at')
          .map((c) => c.name);
        suggestion = await generateSuggestion(message, stripPrefix(schema.tableName, prefix), userCols);
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
