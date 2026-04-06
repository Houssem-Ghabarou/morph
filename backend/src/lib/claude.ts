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

COLUMN EXTRACTION:
- Start with columns the user explicitly mentions.
- Then infer the ESSENTIAL columns that the domain requires to be useful, even if not explicitly stated.
- The goal: the table should be immediately usable without the user having to add missing obvious columns.

Inference guideline:
- "track clients" for a gym → name, age, weight, goal (a gym client without weight/goal is useless)
- "track meals with calories" → food, calories (a meal row without the food name is useless)
- "track orders" → quantity, total, status, date (an order without status/date is useless)
- "track products with price" → name, price, category (a product without a name is useless)

Rules:
- Every table MUST have at least one descriptive TEXT column (name, title, description, food, etc.)
- Add columns that the domain clearly needs, but stop at 4-6 user columns max — don't bloat.
- Do NOT add generic filler columns like "email", "phone", "notes" unless the user mentions them.
- When in doubt, include the column — a table missing an obvious column is worse than having one extra.
- Use short, simple column names: "food" not "meal_name", "program" not "program_name", "exercise" not "exercise_name".
- The descriptive column for a table should NOT repeat the table name: meals table → "food" column (not "meal_name").

DATA TYPES:
- TEXT for names/descriptions
- INTEGER for counts/whole numbers
- NUMERIC for measurements (weight, height, price)
- DATE for dates
- BOOLEAN for yes/no

RESERVED WORD RULE (critical — no exceptions):
- NEVER use a raw SQL reserved word as a column name.
- Common reserved words to avoid as column names: order, user, group, check, primary, column, table, select, default, key, role, grant, limit, offset, references, constraint, desc, asc, create, alter, drop, insert, update, delete, from, where, join, on, in, and, or, not, null, true, false, case, when, then, else, end, all, any, with, for, do, to, is, as, by, set, values, into, having, union, except, distinct, exists, between, like, fetch, only, both, leading, trailing, similar, some, cross, full, inner, outer, left, right, natural, using, window
- If a FK column name would be a reserved word, add _ref suffix:
    orders table → order_ref TEXT (not "order")
    users table  → user_ref TEXT (not "user")
    groups table → group_ref TEXT (not "group")
- Non-reserved words keep the normal convention: client TEXT, fabric TEXT, product TEXT

LINKING RULE (mandatory — no exceptions):

- If multiple tables are created in the same request, you MUST create logical relationships between them.

- If one entity clearly belongs to another (e.g., meals belong to clients, orders belong to users):
  → Add a TEXT column in the child table referencing the parent.

- Column naming:
  - Use singular form of the parent table name
  - If that singular form is a SQL reserved word, add _ref suffix (see RESERVED WORD RULE)
  - Example:
    clients → meals must include: client TEXT
    users → orders must include: user_ref TEXT  (because "user" is reserved)

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

MANY-TO-MANY RULE (junction tables):
- When one entity can contain MULTIPLE of another (e.g. "an order can have multiple fabrics", "a course has multiple students", "a playlist has multiple songs"):
  → You MUST create a junction/items table to represent the relationship.
  → The junction table has: FK to parent A (text), FK to parent B (text), plus any per-line data (quantity, price at time of order, etc.)
  → Remember: if a FK column name is a SQL reserved word, add _ref suffix.
  → Naming: order + items = order_items, course + students = enrollments, etc.
  → Example for "orders contain multiple fabrics":
     order_items: order_ref (text), fabric (text), meters (numeric), unit_price (numeric)
  → NEVER flatten a many-to-many into a single row — always use a junction table.

TABLE vs COLUMN RULE (critical — avoid over-creating tables):
- "X with Y" = Y is a COLUMN of X, not a separate table.
  "training programs with exercises" → training_programs table has an exercises TEXT column.
  "meals with calories" → meals table has a calories column.
  "orders with status" → orders table has a status column.
- "X and Y" or "X, Y, and Z" = separate tables.
  "clients, meals, and training programs" → 3 separate tables.
- Only create a separate table when the user clearly names it as an independent entity to track.
- When in doubt, make it a column — users can always ask for a separate table later.

MULTI-TABLE RULE:
- If multiple entities are requested:
  - Output ALL CREATE TABLE statements separated by a line containing only:
    ---
  - You MUST use --- on its own line between each CREATE TABLE statement.
  - Do NOT combine multiple CREATE TABLE statements in a single block.
- Existing session tables are already created — do NOT re-create them.
- Only create tables for entities the user explicitly names as things to track.

FULL MULTI-TABLE EXAMPLE:
User: "I run a fabric shop. Track clients with name, phone, address. Track fabrics with name, color, price per meter, stock. Create orders for clients with date, total, status. Each order has multiple fabrics with meters and unit price."

Output:
CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  name TEXT,
  phone TEXT,
  address TEXT,
  created_at TIMESTAMP DEFAULT NOW()
)
---
CREATE TABLE fabrics (
  id SERIAL PRIMARY KEY,
  name TEXT,
  color TEXT,
  price_per_meter NUMERIC,
  stock_meters NUMERIC,
  created_at TIMESTAMP DEFAULT NOW()
)
---
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  client TEXT,
  order_date DATE,
  total_price NUMERIC,
  status TEXT,
  created_at TIMESTAMP DEFAULT NOW()
)
---
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_ref TEXT,
  fabric TEXT,
  meters NUMERIC,
  unit_price NUMERIC,
  created_at TIMESTAMP DEFAULT NOW()
)

Note: "client" is not reserved so it stays as-is. "order" IS reserved so it becomes "order_ref".

INTENT CLASSIFICATION:
1. CREATE intent → user describes a new entity/type ("I need to track...", "create a table for...")
2. INSERT intent → user provides concrete data values ("New client: Ahmed, 30...", "Add order: 5 pizzas...")
3. QUERY intent → user asks a question about existing data ("how many...", "show me...", "what is...")

INSERT vs ALTER — this is critical:
- If the user provides concrete values (names, numbers, dates) and a matching table exists → ALWAYS use PREFILL/INSERT.
- "New client: Ahmed, 30 years old, 78kg, goal is muscle gain" → this is INSERT, not ALTER.
- Only use ALTER when the user explicitly asks to add/change a column: "add a notes column to clients".
- If some values don't match existing columns, still use PREFILL with the columns that exist. Do NOT alter the table to add the missing columns.

When unsure between CREATE and INSERT:
- If concrete values are present and an existing table can hold them → INSERT/PREFILL
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

PERSON / NAME FILTER RULE (critical for accuracy):
- When the user refers to a person by name in a WHERE clause, ALWAYS use partial matching:
    WHERE column ILIKE '%value%'
  NOT: WHERE column = 'value'  ← wrong, misses "Houssem Ghabarou" when asking for "Houssem"
  NOT: WHERE column ILIKE 'value' ← wrong, still exact match
- For multiple people: WHERE (column ILIKE '%name1%' OR column ILIKE '%name2%')
- Never mix data between people — each person's filter must be independent.
- For non-person text filters (status, type, category): keep exact ILIKE without wildcards.

- For table joins, use exact case-insensitive match (no wildcards):
    JOIN clients ON meals.client ILIKE clients.name
- For comparisons between people:
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
    max_tokens: 2048,
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
    max_tokens: 2048,
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

const INTERPRET_PROMPT = `You are a helpful data analyst inside Morph, a business OS that works for any domain.
You are given the user's question, the SQL query results, and the full session data for context.

ACCURACY RULES — follow these exactly, no exceptions:
- The SQL query result rows are the ONLY source of truth for your answer. Answer strictly from those rows.
- The full session data is background context only — use it to understand the domain, but NEVER extract numbers from it.
- If the query returned 0 rows: say "No data found for that." Do NOT make up an answer.
- NEVER invent, estimate, or assume values not in the query results.
- Be concise (1-3 sentences max).
- Be specific — use EXACT names and numbers copied directly from the query result rows.
- Give a practical, helpful answer that a business owner would find useful.
- When the user asks a subjective question ("is X doing well?", "is this healthy?", "is Y profitable?"), use the numbers from the query results to give a clear opinion — don't just repeat the numbers.
- If comparing items/people, list the actual values for EACH from the results. If one is missing, say so.
- No markdown, no bullet points, no code blocks.
- Never mention SQL, databases, tables, columns, or queries.
- Never say "based on the data" — just give the direct answer.
- Speak naturally as a knowledgeable assistant who understands the user's business.`;

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

// ─── Analysis generation ──────────────────────────────────────────────────────

const ANALYZE_PROMPT = `You are a data analyst inside Morph, a business OS.
Given the session tables (with schemas, row counts, sample data, and relations), generate a set of useful SQL SELECT queries that produce meaningful statistics, KPIs, and insights.

RULES:
- Output ONLY a JSON array of objects. No markdown, no explanations, no code fences.
- Each object: { "title": "Short human-readable title", "sql": "SELECT ..." }
- Generate 6-10 queries depending on what's available.
- Use the EXACT table names as they appear in the context (e.g. "clients", "meals", "training_programs"). Do NOT add any prefix — just use the plain names.
- Use the EXACT column names as listed in the schemas.
- Prioritize:
  1. Total count per table (e.g. "Total Clients")
  2. Aggregates on numeric columns (SUM, AVG, MAX, MIN)
  3. GROUP BY breakdowns on text columns (e.g. status distribution, category breakdown)
  4. Cross-table stats using JOINs if relations exist (use the relation column for joins, e.g. meals.client = clients.name)
  5. Top/bottom rankings (ORDER BY ... DESC/ASC LIMIT 5)
  6. Combined metrics (e.g. client with highest total calories)
- Use clear aliases: COUNT(*) AS total, SUM(x) AS total_x, etc.
- Keep titles short and business-friendly (no SQL jargon).
- If a table is empty (0 rows), skip complex queries on it — just include the count.
- NEVER use markdown. Output ONLY valid JSON.
- NEVER add table prefixes like "s1_" or "s88_" — just use the bare table names from context.

Example output:
[{"title":"Total Clients","sql":"SELECT COUNT(*) AS total FROM clients"},{"title":"Meals by Client","sql":"SELECT client, COUNT(*) AS meals FROM meals GROUP BY client ORDER BY meals DESC"}]`;

export async function generateAnalysisQueries(
  sessionContext: string
): Promise<Array<{ title: string; sql: string }>> {
  const prompt = `${sessionContext}\n\nGenerate useful analytics queries for this business data.`;

  try {
    let text: string;
    if (provider === 'claude') {
      const claude = getClaude();
      const resp = await claude.messages.create({
        model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-6',
        max_tokens: 2048,
        system: ANALYZE_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = resp.content[0];
      text = block.type === 'text' ? block.text.trim() : '[]';
    } else {
      const groq = getGroq();
      const resp = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
        max_tokens: 2048,
        messages: [
          { role: 'system', content: ANALYZE_PROMPT },
          { role: 'user', content: prompt },
        ],
      });
      text = resp.choices[0]?.message?.content?.trim() ?? '[]';
    }

    // Strip markdown fences if LLM wraps them
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    return JSON.parse(text);
  } catch (err) {
    console.error('Failed to generate analysis queries:', err);
    return [];
  }
}

// ─── Seed data generation ─────────────────────────────────────────────────────

const SEED_PROMPT = `Output ONLY compact JSON. No markdown/explanations.
Map each table name to an array of 3 row objects. Omit id/created_at.
FK columns MUST match a value from the referenced parent table.
Keep text values short (1-3 words). Use realistic varied data.
Example: {"clients":[{"name":"Sara","age":28}],"meals":[{"client":"Sara","food":"Salmon","calories":520}]}`;

/**
 * Try to salvage truncated JSON by closing any open structures.
 * Strips trailing broken values and closes all open brackets/braces.
 */
function repairTruncatedJSON(raw: string): string {
  // Strip trailing comma, partial key/value, and incomplete strings
  let s = raw.replace(/,\s*"[^"]*$/, '');         // partial key
  s = s.replace(/,\s*"[^"]*":\s*"?[^"}\]]*$/, ''); // partial key:value
  s = s.replace(/,\s*$/, '');                      // trailing comma

  // Count open brackets/braces and close them
  const opens: string[] = [];
  let inStr = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') opens.push(ch);
    if (ch === '}' || ch === ']') opens.pop();
  }
  // If we're inside a string, close it
  if (inStr) s += '"';
  // Close remaining open structures
  while (opens.length > 0) {
    const open = opens.pop();
    s += open === '{' ? '}' : ']';
  }
  return s;
}

export async function generateContextualSeedData(
  userRequest: string,
  existingDataContext: string,
  newTablesContext: string
): Promise<Record<string, Record<string, unknown>[]>> {
  const CONTEXTUAL_SEED_PROMPT = `Output ONLY compact JSON. No markdown/explanations.
Map each new table name to an array of row objects. Omit id/created_at.
Generate realistic, personalized rows derived from the user's actual existing data.
Be specific: use the real values (names, weights, exercises, days) from the existing data.
For nutrition/meal plans: generate one entry per training day and rest day in the schedule.
FK columns must reference values that appear in the user's existing data.`;

  const prompt = `User request: "${userRequest}"

Existing user data:
${existingDataContext || '(none)'}

New tables to fill (generate rows for ONLY these):
${newTablesContext}

Return JSON mapping each new table name to its rows.`;

  try {
    let text: string;
    if (provider === 'claude') {
      const claude = getClaude();
      const resp = await claude.messages.create({
        model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-6',
        max_tokens: 4096,
        system: CONTEXTUAL_SEED_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = resp.content[0];
      text = block.type === 'text' ? block.text.trim() : '{}';
    } else {
      const groq = getGroq();
      const resp = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: CONTEXTUAL_SEED_PROMPT },
          { role: 'user', content: prompt },
        ],
      });
      text = resp.choices[0]?.message?.content?.trim() ?? '{}';
    }

    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    try {
      return JSON.parse(text);
    } catch {
      return JSON.parse(repairTruncatedJSON(text));
    }
  } catch (err) {
    console.error('Failed to generate contextual seed data:', err);
    return {};
  }
}

export async function generateSeedData(
  sessionContext: string
): Promise<Record<string, Record<string, unknown>[]>> {
  const prompt = `${sessionContext}\n\nGenerate 3 rows per table. Compact JSON only.`;

  try {
    let text: string;
    if (provider === 'claude') {
      const claude = getClaude();
      const resp = await claude.messages.create({
        model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-6',
        max_tokens: 4096,
        system: SEED_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = resp.content[0];
      text = block.type === 'text' ? block.text.trim() : '{}';
    } else {
      const groq = getGroq();
      const resp = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: SEED_PROMPT },
          { role: 'user', content: prompt },
        ],
      });
      text = resp.choices[0]?.message?.content?.trim() ?? '{}';
    }

    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

    // Try parsing as-is first
    try {
      return JSON.parse(text);
    } catch {
      console.log('Seed JSON parse failed, attempting repair…');
      console.log('Raw tail:', text.slice(-200));
      const repaired = repairTruncatedJSON(text);
      return JSON.parse(repaired);
    }
  } catch (err) {
    console.error('Failed to generate seed data:', err);
    return {};
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
