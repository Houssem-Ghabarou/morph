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
- Output exactly one SQL statement per response.
- Never invent table names. If asked to add/insert data and session tables exist, always INSERT into an existing table.`;

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
