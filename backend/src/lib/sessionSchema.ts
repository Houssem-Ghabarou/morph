import { query, getTableSchema } from './postgres';

/**
 * Build an LLM context string describing a session's tables using their EXACT
 * database names (with the s{id}_ prefix). Automations run query_sql directly
 * against the DB with no rewriting, so the LLM must see the real names.
 */
export async function buildAutomationContext(
  sessionId: number
): Promise<{ context: string; tableNames: string[] }> {
  const tablesRes = await query(
    `SELECT table_name FROM morph_session_tables WHERE session_id = $1 ORDER BY created_at ASC`,
    [sessionId]
  );
  const tableNames: string[] = tablesRes.rows.map((r: { table_name: string }) => r.table_name);
  if (tableNames.length === 0) {
    return { context: 'This session has no tables yet.', tableNames };
  }

  const lines = await Promise.all(
    tableNames.map(async (name) => {
      const cols = await getTableSchema(name);
      const colDefs = cols
        .filter((c) => c.column_name !== 'id' && c.column_name !== 'created_at')
        .map((c) => `${c.column_name} (${c.data_type})`)
        .join(', ');
      let count = 0;
      try {
        const c = await query(`SELECT COUNT(*) AS cnt FROM "${name}"`);
        count = Number(c.rows[0]?.cnt ?? 0);
      } catch {
        /* best-effort */
      }
      return `- ${name} [${count} rows]: ${colDefs}`;
    })
  );

  return {
    context: `Tables in this session (use these EXACT names in SQL):\n${lines.join('\n')}`,
    tableNames,
  };
}
