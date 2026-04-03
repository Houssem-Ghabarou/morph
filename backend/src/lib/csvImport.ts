import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';

type Provider = 'groq' | 'claude';
const provider: Provider = (process.env.LLM_PROVIDER as Provider) ?? 'groq';

const getGroq = () => new Groq({ apiKey: process.env.GROQ_API_KEY });
const getClaude = () => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ColumnSuggestion {
  csvHeader: string;
  pgName: string;
  pgType: string;
}

export interface ColumnMapping {
  csvHeader: string;
  tableColumn: string | null;
}

export type AnalyzeResult =
  | { flow: 'new'; tableName: string; columns: ColumnSuggestion[] }
  | { flow: 'existing'; tableName: string; mapping: ColumnMapping[] };

async function callLLM(prompt: string): Promise<string> {
  if (provider === 'claude') {
    const claude = getClaude();
    const response = await claude.messages.create({
      model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = response.content[0];
    if (block.type !== 'text') throw new Error('Unexpected response type from Claude');
    return block.text.trim();
  }

  const groq = getGroq();
  const response = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
    max_tokens: 1024,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'You are a database schema analyst. You ONLY output valid JSON. Never output explanations, markdown, or backticks.',
      },
      { role: 'user', content: prompt },
    ],
  });
  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('Empty response from Groq');
  return text.trim();
}

function parseJSON(raw: string): Record<string, unknown> {
  // Strip accidental markdown fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  // Extract first {...} block in case the model prepends text
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in LLM response');
  return JSON.parse(match[0]);
}

// ─── Flow 1: suggest schema for a brand-new table ────────────────────────────

async function suggestNewTable(
  headers: string[],
  sampleRows: string[][],
  projectDescription: string
): Promise<{ tableName: string; columns: ColumnSuggestion[] }> {
  const context = projectDescription
    ? `Business context: ${projectDescription}\n\n`
    : '';

  const prompt = `${context}Given these CSV headers and sample data rows, suggest a PostgreSQL table schema.

CSV Headers: ${JSON.stringify(headers)}
Sample rows (up to 5):
${sampleRows.map((r) => JSON.stringify(r)).join('\n')}

Return ONLY this JSON shape:
{
  "tableName": "snake_case_table_name",
  "columns": [
    {"csvHeader": "original header", "pgName": "snake_case_name", "pgType": "TEXT"}
  ]
}

Rules:
- tableName must be snake_case and describe the data (e.g. "products", "employees", "orders")
- pgName must be snake_case
- pgType must be one of: TEXT, INTEGER, NUMERIC, BOOLEAN, DATE, TIMESTAMP
- Infer the most appropriate type from the sample values`;

  const raw = await callLLM(prompt);
  const json = parseJSON(raw);
  return { tableName: json.tableName as string, columns: json.columns as ColumnSuggestion[] };
}

// ─── Flow 2: match CSV to existing table ─────────────────────────────────────

async function matchExistingTable(
  headers: string[],
  sampleRows: string[][],
  existingTables: Array<{ tableName: string; columns: Array<{ column_name: string; data_type: string }> }>
): Promise<{ matched: false } | { matched: true; tableName: string; mapping: ColumnMapping[] }> {
  const tableDesc = existingTables
    .map(
      (t) =>
        `"${t.tableName}": columns [${t.columns
          .map((c) => `${c.column_name} (${c.data_type})`)
          .join(', ')}]`
    )
    .join('\n');

  const prompt = `I have a CSV file and some existing database tables. Decide if the CSV belongs in one of the existing tables or if it needs a new table.

CSV Headers: ${JSON.stringify(headers)}
Sample row: ${JSON.stringify(sampleRows[0] ?? [])}

Existing tables:
${tableDesc}

If the CSV is clearly a good fit for one of the existing tables (same domain, most columns match), return:
{
  "matched": true,
  "tableName": "exact_existing_table_name",
  "mapping": [
    {"csvHeader": "original header", "tableColumn": "column_name_or_null"}
  ]
}
Set "tableColumn" to null for CSV columns that have no matching table column.

If the CSV does NOT match any existing table well (different domain, most columns don't map), return:
{
  "matched": false
}

Return ONLY the JSON, nothing else.`;

  const raw = await callLLM(prompt);
  const json = parseJSON(raw);

  if (!json.matched) return { matched: false };

  // Validate that the returned tableName is actually in our list
  const tableNames = existingTables.map((t) => t.tableName);
  if (!tableNames.includes(json.tableName as string)) return { matched: false };

  return {
    matched: true,
    tableName: json.tableName as string,
    mapping: json.mapping as ColumnMapping[],
  };
}

// ─── Public entrypoint ────────────────────────────────────────────────────────

export async function analyzeCSV(
  headers: string[],
  sampleRows: string[][],
  existingTables: Array<{ tableName: string; columns: Array<{ column_name: string; data_type: string }> }>,
  projectDescription = ''
): Promise<AnalyzeResult> {
  // No existing tables → always create new
  if (existingTables.length === 0) {
    const result = await suggestNewTable(headers, sampleRows, projectDescription);
    return { flow: 'new', ...result };
  }

  // Try to match an existing table first
  const match = await matchExistingTable(headers, sampleRows, existingTables);

  if (match.matched) {
    return { flow: 'existing', tableName: match.tableName, mapping: match.mapping };
  }

  // No good match found — fall back to creating a new table
  const result = await suggestNewTable(headers, sampleRows, projectDescription);
  return { flow: 'new', ...result };
}
