import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';

const SYSTEM_PROMPT = `You are a database architect for Morph, an LLM-powered business OS.
Your job is to convert natural language into valid PostgreSQL SQL statements.

Rules:
- Only output raw SQL. No markdown, no explanations, no backticks.
- Use snake_case for all table and column names.
- For CREATE TABLE: always include an "id SERIAL PRIMARY KEY" column and a "created_at TIMESTAMP DEFAULT NOW()" column.
- For ALTER TABLE: only add columns, never drop them.
- For INSERT: if session tables are provided, you MUST insert into one of those existing tables. Use the exact column names listed. Values must match the column types (quote strings, use numbers for integers/floats).
- If the intent is ambiguous and no tables exist yet, default to CREATE TABLE.
- Never invent table names. If asked to add/insert data and session tables exist, always INSERT into an existing table.

LINKING RULE (always apply):
- Never use integer foreign keys or REFERENCES constraints. They cause errors.
- To link a table to another, add a plain TEXT column named after the related table (singular, no _id).
- Example: meals should have "client TEXT" not "client_id INT REFERENCES clients(id)".
- If "clients" already exists in the session and you create "training_programs", add: client TEXT
- Always check existing session tables and add a link column if the new table logically belongs to one.

MULTI-TABLE RULE:
When the user asks to track/manage multiple new concepts at once:
- Output ALL CREATE TABLE statements separated by a line containing exactly: ---
- Existing session tables are already created — do NOT re-create them.
- For a single new table request, output exactly one CREATE TABLE statement.

INTENT CLASSIFICATION — apply this before anything else:
1. CREATE intent: user describes a new type of thing to manage/track/store (even if tables exist). Signals: "I want to track X", "add a X table", "I need to manage X", "track X for my clients", "store X". → CREATE TABLE (or multi-table if multiple entities).
2. INSERT intent: user is adding a specific concrete record with actual values. Signals: mentions real names/numbers/dates like "add John, 85kg", "log pasta 300 calories for Houssem", "new client: Ahmed". → PREFILL (if tables exist) or INSERT SQL.
3. QUERY intent: user asks a question about existing data. Signals: "how many", "show me", "total", "which", "is X doing Y". → SELECT.

When unsure between CREATE and INSERT: if the user mentions a concept/entity type without specific record values → CREATE TABLE.

PREFILL RULE (only for INSERT intent):
When intent is INSERT and session tables already exist:
- Do NOT generate INSERT SQL
- Output exactly: PREFILL|<table_name>|<json>
- <table_name> must be one of the existing session tables that best matches the intent
- <json> must contain ALL non-system columns as keys. Extract values from the message. Use "" for unknown values.
- Example: PREFILL|inventory|{"wood_type":"White Oak","quantity":200,"vendor":"Atlas Lumber"}
- If no tables exist yet, use INSERT SQL as normal.

SELECT RULES:
- For analytical/question intent: output a SELECT query.
- May use JOINs, GROUP BY, ORDER BY, LIMIT, aggregate functions (SUM, COUNT, AVG, MAX, MIN).
- Always alias aggregates: SELECT wood_type, SUM(quantity) AS total_quantity FROM ...
- For single-value results, use one aggregate with a clear alias.
- Always use ILIKE instead of = for text/name filters (case-insensitive). Example: WHERE name ILIKE 'houssem'.`;

type Provider = 'groq' | 'claude';

const provider: Provider = (process.env.LLM_PROVIDER as Provider) ?? 'groq';

// Lazy-init clients only when their key is present
const getGroq = () => new Groq({ apiKey: process.env.GROQ_API_KEY });
const getClaude = () => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildPrompt(userMessage: string, sessionContext: string): string {
  if (!sessionContext) return userMessage;
  return `${sessionContext}\n\nUser request: ${userMessage}`;
}

async function generateWithGroq(userMessage: string, sessionContext: string): Promise<string> {
  const groq = getGroq();
  const response = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(userMessage, sessionContext) },
    ],
  });
  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('Empty response from Groq');
  return text.trim();
}

async function generateWithClaude(userMessage: string, sessionContext: string, conversationHistory: Anthropic.MessageParam[] = []): Promise<string> {
  const claude = getClaude();
  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory,
    { role: 'user', content: buildPrompt(userMessage, sessionContext) },
  ];
  const response = await claude.messages.create({
    model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  });
  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response type from Claude');
  return block.text.trim();
}

export async function generateSQL(
  userMessage: string,
  sessionContext = '',
  conversationHistory: Anthropic.MessageParam[] = []
): Promise<string> {
  if (provider === 'claude') {
    return generateWithClaude(userMessage, sessionContext, conversationHistory);
  }
  return generateWithGroq(userMessage, sessionContext);
}

// ─── Query interpretation ─────────────────────────────────────────────────────

const INTERPRET_PROMPT = `You are a helpful data analyst inside Morph, a business OS.
You are given the user's question and ALL data from every table in the session.
Use the full dataset to answer accurately — never say data is missing if it appears in the full session data.
Rules:
- Be concise (1-3 sentences max)
- Be specific — use the actual values from the data
- If the question is health/fitness related, give a simple assessment with numbers
- If comparing entities, include values for all compared entities
- No markdown, no bullet points, no code
- Never mention SQL or databases`;

export async function interpretQueryResult(
  userMessage: string,
  rows: Record<string, unknown>[],
  sessionContext: string,
  fullSessionData?: string
): Promise<string> {
  const rowSummary = rows.length === 0
    ? 'No data found.'
    : rows.slice(0, 20).map((r) => JSON.stringify(r)).join('\n');

  const dataSection = fullSessionData
    ? `Full session data:\n${fullSessionData}\n\nQuery results (primary):\n${rowSummary}`
    : `Query results:\n${rowSummary}`;

  const prompt = `${sessionContext ? sessionContext + '\n\n' : ''}User asked: "${userMessage}"\n\n${dataSection}`;

  try {
    if (provider === 'claude') {
      const claude = getClaude();
      const resp = await claude.messages.create({
        model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-6',
        max_tokens: 300,
        system: INTERPRET_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = resp.content[0];
      return block.type === 'text' ? block.text.trim() : '';
    } else {
      const groq = getGroq();
      const resp = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
        max_tokens: 300,
        messages: [
          { role: 'system', content: INTERPRET_PROMPT },
          { role: 'user', content: prompt },
        ],
      });
      return resp.choices[0]?.message?.content?.trim() ?? '';
    }
  } catch {
    return '';
  }
}

// ─── Insert suggestion ────────────────────────────────────────────────────────

const SUGGESTION_PROMPT = `You are a friendly assistant inside Morph, a business operating system.
A database table was just created. Your job: write 1-2 casual sentences suggesting realistic rows the user could add.
Be specific to their business context. Never mention SQL, databases, or technical terms.
End with a short example like: 'Try saying: "Add [realistic value], [realistic value]"'.`;

export async function generateSuggestion(
  userMessage: string,
  tableName: string,
  columns: string[]
): Promise<string> {
  const cols = columns.join(', ');
  const prompt = `User said: "${userMessage}"\nTable "${tableName}" was created with fields: ${cols}.\nSuggest data they could add.`;

  try {
    if (provider === 'claude') {
      const claude = getClaude();
      const resp = await claude.messages.create({
        model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-6',
        max_tokens: 120,
        system: SUGGESTION_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = resp.content[0];
      return block.type === 'text' ? block.text.trim() : '';
    } else {
      const groq = getGroq();
      const resp = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
        max_tokens: 120,
        messages: [
          { role: 'system', content: SUGGESTION_PROMPT },
          { role: 'user', content: prompt },
        ],
      });
      return resp.choices[0]?.message?.content?.trim() ?? '';
    }
  } catch {
    // Suggestion is non-critical — don't crash the request
    return '';
  }
}

export { provider };
