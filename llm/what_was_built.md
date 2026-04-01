# Morph — What Was Actually Built
> Updated: April 2026 · Phases A, B, C complete + session isolation + relations + query intelligence

---

## Stack Running

| Layer | Tech | Port |
|---|---|---|
| Frontend | Next.js 16, TypeScript, Tailwind CSS | 3000 |
| Backend | Fastify, TypeScript | 3001 |
| LLM | Claude or Groq (switch via `LLM_PROVIDER` env) | — |
| Database | PostgreSQL (raw `pg`) | 5432 |

```bash
cd backend && npm run dev
cd morphfront && npm run dev
```

---

## Backend — Routes

| Method | Path | What it does |
|---|---|---|
| GET | `/api/sessions` | List all sessions, ordered by last activity |
| POST | `/api/sessions` | Create a new empty session |
| GET | `/api/sessions/:id` | Full session detail: messages + table positions + relations |
| DELETE | `/api/sessions/:id` | Deletes session + drops all its user tables |
| GET | `/api/sessions/:id/relations` | FK relations for all tables in a session |
| PATCH | `/api/sessions/:id/tables/:tableName/position` | Save card drag position |
| POST | `/api/chat` | Main pipeline: NL → LLM → SQL/PREFILL/SELECT → DB |
| GET | `/api/data/:tableName` | Fetch all rows (validated against information_schema) |
| POST | `/api/data/:tableName` | Insert a row |
| GET | `/api/schema/:tableName` | Get column schema |
| GET | `/api/schema` | List all user tables (morph_ system tables excluded) |
| GET | `/health` | Health check |

---

## Backend — `/api/chat` Pipeline

Input: `{ message: string, sessionId: number }`

**Flow:**
1. Build session context (existing tables + schemas + sample row + existing relations — all injected into LLM prompt, display names only, no prefix)
2. Call LLM (Claude or Groq)
3. Sanitize SQL (`sanitizeSQL` — fixes spaced table names → snake_case, strips backticks)
4. Rewrite SQL table names for session isolation (`wood_inventory` → `s3_wood_inventory`)
5. Parse LLM output — one of these paths:

| LLM output | Action | What happens |
|---|---|---|
| `CREATE TABLE ...` | `create` | Execute DDL, register table in session, return schema |
| `CREATE TABLE ...\n---\nCREATE TABLE ...` | `create_many` | Execute all DDLs, derive FK relations, return schemas + relations |
| `ALTER TABLE ...` | `alter` | Execute DDL, dispatch `morph:refresh` event — card updates live |
| `PREFILL\|table\|{json}` | `prefill` | Parse values, fetch schema, return form data — no SQL executed |
| `INSERT INTO ...` | `insert` | Execute DML, fire `morph:refresh` |
| `SELECT ...` | `query` | Execute, apply ILIKE rewrite, detect chart type, interpret with full data |

6. Save messages to `morph_messages` for history
7. Auto-name session from first message

**Response actions:**
```
'create'       → new TableCard spawned on canvas
'create_many'  → all TableCards spawned in a row; FK arrows drawn between related tables
'alter'        → TableCard refreshes columns live (morph:refresh event, no page reload)
'insert'       → morph:refresh event fires, TableCard refetches rows
'prefill'      → SlidePanel slides in pre-filled
'query'        → VisualCard (stat / bar / table) spawned on canvas + LLM natural language answer
```

**Session isolation:**
- Every user table is prefixed with `s{sessionId}_` in PostgreSQL (e.g. `s3_wood_inventory`)
- The LLM sees and generates clean display names; the backend rewrites them before execution
- `rewriteSQLForSession()` handles CREATE, ALTER, INSERT, SELECT, and PREFILL cases
- Deleting a session drops its prefixed tables via `DROP TABLE ... CASCADE`
- Frontend strips the prefix before displaying card titles

**SQL resilience:**
- `sanitizeSQL()` — fixes `CREATE TABLE foo bar` → `CREATE TABLE foo_bar`, strips MySQL backticks
- `makeSelectCaseInsensitive()` — rewrites `= 'value'` → `ILIKE 'value'` in all SELECT queries so name lookups work case-insensitively (`houssem`, `HOUSSEM`, `Houssem` all match)
- SQL errors return 200 with a friendly chat message instead of crashing with 500

**FK relations (no REFERENCES constraints):**
- Relations detected by column name ↔ table name heuristic: `client` column + `clients` table = relation
- Handles singular/plural: `client` matches `clients`, `meal` matches `meals`
- `deriveRelations(schemas, prefix)` runs after every create and on session load
- Relations stored in frontend state, refreshed from `/api/sessions/:id/relations` after every create
- Persists across session switches (loaded with `GET /api/sessions/:id`)
- No PostgreSQL REFERENCES constraints used — avoids FK errors entirely

**Session context sent to LLM (includes everything):**
```
Tables already in this session:
- clients: name (text), age (integer), weight (numeric), goal (text)
  sample: {"name":"Houssem","age":28,"weight":82,"goal":"fat loss"}
- meals: client (text), food (text), calories (integer)
  sample: {"client":"Houssem","food":"grilled chicken","calories":650}

Existing relations:
- meals.client → clients
- training_programs.client → clients
```
This means adding a new table days later automatically links it correctly.

**Intent classification (3-way, in LLM system prompt):**
- `CREATE`: "I want to track X", "add a X table", "I need to manage X" → `CREATE TABLE`
- `INSERT`: specific values mentioned ("add John, 85kg", "log pasta 300 calories") → `PREFILL`
- `QUERY`: question words ("how many", "show me", "total", "is X doing Y") → `SELECT`

**Query interpretation (two-step LLM for SELECT):**
1. First LLM call: generates SQL
2. Execute SQL → get rows
3. Fetch ALL rows from ALL session tables (up to 100 per table)
4. Second LLM call: `interpretQueryResult` — answers the user's question conversationally using the full dataset, not just the SQL result
- This allows cross-table insight questions: "Is Houssem eating healthy?", "Compare Houssem and Karim calorie intake"

**Chart type detection (for SELECT):**
- Single row, ≤2 columns, no GROUP BY → `stat`
- Has GROUP BY + aggregate (SUM/COUNT/AVG/MAX/MIN) → `bar`
- Everything else → `table`

**Internal DB tables:**
```
morph_sessions        → session list (id, name, created_at, updated_at)
morph_messages        → full chat history per session (role, text, warning)
morph_session_tables  → which tables belong to which session + canvas x/y positions
```

**Security:**
- `tableName` in `/api/data/:tableName` validated against `information_schema` before any query
- `morph_` tables hidden from `/api/schema` listing

---

## Frontend — File Structure

```
morphfront/
├── app/
│   ├── layout.tsx              Root layout, Geist font, dark theme
│   ├── page.tsx                Orchestration — wires all components + state
│   └── globals.css             Dark theme, dot-grid canvas, animations
├── components/
│   ├── Sidebar.tsx             Session history (left panel)
│   ├── Canvas.tsx              Infinite canvas, pan/zoom, FK arrows, all card types
│   ├── TableCard.tsx           Draggable live data table card
│   ├── ChatPanel.tsx           Chat input + message history (bottom)
│   ├── SlidePanel.tsx          Pre-filled insert form (slides from right)
│   ├── FormModal.tsx           Manual "+ Add Row" modal
│   ├── StatCard.tsx            KPI number card (from SELECT queries)
│   ├── BarChartCard.tsx        Bar chart card (from GROUP BY queries)
│   └── QueryResultCard.tsx     Read-only result table card (from SELECT)
├── hooks/
│   └── useSession.ts           Central state: sessions, messages, tables, visualCards, relations
├── lib/
│   └── api.ts                  Typed API client (incl. getSessionRelations)
└── types/
    └── index.ts                All TypeScript interfaces (incl. Relation)
```

---

## Frontend — Component Behaviours

**Sidebar**
- Lists sessions ordered by `updated_at` DESC
- Click to switch — restores messages + table positions + FK relations from DB
- "New Chat" creates a fresh session
- Delete on hover — removes session and drops its DB tables
- Auto-updates session name when backend renames it

**Canvas**
- Infinite, dot-grid background
- Pan: middle-click or Space + left-click drag
- Zoom: scroll wheel (0.2× – 2.5×), zoom toward cursor
- Renders TableCards, StatCards, BarChartCards, QueryResultCards
- New TableCards animate in (`cardAppear` keyframe)
- Empty state shows a prompt suggestion
- **FK arrows**: dashed violet SVG bezier curves between related TableCards
  - Wide invisible hit area (16px) for easy hover
  - Brightens + thickens on hover
  - Hover tooltip: `meals → clients` / "Each meal is linked to a client via 'client'."
- **Relations toggle**: pill button top-right, shows only when relations exist, smooth on/off animation

**TableCard**
- Draggable (saves position to backend on drag end, supports `canvasScale` prop)
- Live rows via `GET /api/data/:tableName`
- Refreshes via `morph:refresh` custom event (insert from chat or SlidePanel)
- "+ Add Row" opens FormModal
- Strips session prefix from display title

**ChatPanel**
- Fixed bottom, expandable
- Enter to send, Shift+Enter for newline
- Typing indicator (3 animated dots)
- Typewriter animation on latest assistant message
- Backtick-wrapped names styled as `code`
- Dispatches to canvas: create/alter → TableCard, prefill → SlidePanel, query → VisualCard, insert → morph:refresh event

**SlidePanel**
- `position: fixed`, slides from right (380px)
- Pre-filled from LLM-extracted values
- Type-aware inputs: text / number / checkbox / date / datetime
- **FK dropdown**: if a column matches a relation, fetches all rows from the referenced table and renders a `<select>` instead of a free text input
- Empty string → `null` for numeric fields (prevents type errors)
- Confirm → POST to `/api/data/:tableName` → `morph:refresh` fires

**FormModal**
- Same FK dropdown logic as SlidePanel
- `relations` prop passed from Canvas → TableCard → FormModal

**StatCard**
- 200px, violet top border accent
- Large KPI value + label
- Draggable, closeable (×)

**BarChartCard**
- 320px, auto-detects label vs. value column by JS type
- Up to 8 vertical violet bars, scaled to max value
- Value labels above bars, category labels below
- Draggable, closeable

**QueryResultCard**
- 360px, cyan accent (visually distinct from data tables)
- Read-only scrollable table (max 300px height)
- Draggable, closeable

---

## What Works End-to-End

- Describe a business → tables appear on canvas with correct columns and FK arrows
- Add specific records → SlidePanel pre-fills, FK columns show dropdowns with real data
- Ask a question → stat card / bar chart / table card appears + natural language answer
- Ask about a person → LLM reads all session data, gives accurate cross-table insight
- Case-insensitive everywhere: `houssem`, `HOUSSEM`, `Houssem` all work
- Session isolation: each chat has its own independent tables
- Switch sessions → relations, tables, messages all restored correctly
- Add a new linked table days later → LLM sees existing schema, sample data, and relations → links correctly
- ALTER table → card refreshes live, no page reload
