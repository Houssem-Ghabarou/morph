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

COLUMN EXTRACTION (critical — revised):
- Extract columns DIRECTLY from what the user describes.
- Do NOT invent unrelated or unnecessary columns.
- You MAY infer columns ONLY when:
  - The context strongly implies them
  - They are essential to represent the data

Examples:
- "track clients with name and age" → name, age
- "track meals with calories" → food, calories

- Prefer fewer columns over guessing.
- NEVER add generic columns like "email" unless explicitly mentioned.

DATA TYPES:
- TEXT for names/descriptions
- INTEGER for counts/whole numbers
- NUMERIC for measurements (weight, height, price)
- DATE for dates
- BOOLEAN for yes/no

LINKING RULE (mandatory — no exceptions):

- If multiple tables are created in the same request, you MUST create logical relationships between them.

- If one entity clearly belongs to another (e.g., meals belong to clients, orders belong to users):
  → Add a TEXT column in the child table referencing the parent.

- Column naming:
  - Use singular form of the parent table name
  - Example:
    clients → meals must include: client TEXT
    users → orders must include: user TEXT

- This rule is NOT optional:
  - NEVER create related tables without linking them
  - If a relationship can reasonably exist, you MUST include it

- If unsure:
  → Assume the first/main entity is the parent and link others to it

- For multiple relationships:
  → Add multiple TEXT link columns if needed

Examples:
- clients + meals → meals.client TEXT
- clients + training_programs → training_programs.client TEXT
- products + orders → orders.product TEXT

MULTI-TABLE RULE:
- If multiple entities are requested:
  - Output ALL CREATE TABLE statements separated by:
    ---
- Existing session tables are already created — do NOT re-create them.
- Only create tables for entities explicitly mentioned.

INTENT CLASSIFICATION:
1. CREATE intent → user describes a new entity/type
2. INSERT intent → user provides real values
3. QUERY intent → user asks about data

When unsure between CREATE and INSERT:
- If no concrete values → CREATE TABLE

PREFILL RULE (only for INSERT intent):
- Output exactly:
  PREFILL|<table_name>|<json>

- Rules:
  - Use an existing table
  - Include ALL non-system columns (exclude id, created_at)
  - Map values by meaning, not position
  - Missing values → ""

Examples:
- "Ahmed, 30 years old, 78kg" → {"name":"Ahmed","age":30,"weight":78}
- "Log lunch for houssem: grilled chicken with rice, 650 calories" → {"client":"houssem","food":"grilled chicken with rice","calories":650}

SELECT RULES:
- Use SELECT for queries
- Allowed: JOIN, GROUP BY, ORDER BY, LIMIT, aggregates
- Always alias aggregates: SUM(x) AS total_x
- Always use ILIKE for text filters (case-insensitive)
- For joins:
  JOIN using TEXT link columns
  Example:
    JOIN clients ON meals.client ILIKE clients.name
- For comparisons:
  Return rows for ALL compared entities`;

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
You are given the user's question, the SQL query result, and the full session data from all tables.

CRITICAL RULES — follow these exactly:
- ONLY reference data that literally appears in the provided dataset. NEVER invent names, numbers, or values.
- If the query returned no rows or null values, say so honestly. Do NOT fabricate results.
- If the full session data is empty or has no rows, say "No data has been added yet."
- Be concise (1-3 sentences max).
- Be specific — use the EXACT values from the data (copy names and numbers directly).
- If the question is health/fitness related, give a simple assessment using the actual numbers from the data.
- If comparing entities, include the actual values for ALL compared entities from the data.
- No markdown, no bullet points, no code.
- Never mention SQL, databases, tables, columns, or queries.
- Never say "based on the data" — just give the answer directly.`;

export async function interpretQueryResult(
  userMessage: string,
  rows: Record<string, unknown>[],
  sessionContext: string,
  fullSessionData?: string
): Promise<string> {
  const rowSummary = rows.length === 0
    ? 'The query returned 0 rows — no matching data exists.'
    : `${rows.length} row(s):\n${rows.slice(0, 20).map((r) => JSON.stringify(r)).join('\n')}`;

  const dataSection = fullSessionData
    ? `Full session data (this is all the data that exists — do not reference anything not listed here):\n${fullSessionData}\n\nSQL query results:\n${rowSummary}`
    : `SQL query results:\n${rowSummary}`;

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
