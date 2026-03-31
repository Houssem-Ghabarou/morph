# Morph — What Was Actually Built
> Updated: March 2026 · Phases A-engine, B, C complete

---

## Stack Running

| Layer | Tech | Port |
|---|---|---|
| Frontend | Next.js 16, TypeScript, Tailwind CSS | 3000 |
| Backend | Fastify, TypeScript | 3001 |
| LLM | Claude or Groq (switch via `LLM_PROVIDER` env) | — |
| Database | PostgreSQL (raw `pg`) | 5432 |

```bash
cd morph/backend && npm run dev
cd morph/frontend && npm run dev
```

---

## Backend — Routes

| Method | Path | What it does |
|---|---|---|
| GET | `/api/sessions` | List all sessions, ordered by last activity |
| POST | `/api/sessions` | Create a new empty session |
| GET | `/api/sessions/:id` | Full session detail: messages + table positions |
| DELETE | `/api/sessions/:id` | Deletes session + drops all its user tables |
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
1. Build session context (existing tables + schemas injected into LLM prompt)
2. Call LLM (Claude or Groq)
3. Parse LLM output — one of four paths:

| LLM output | Action | What happens |
|---|---|---|
| `CREATE TABLE ...` | `create` | Execute DDL, register table in session, return schema |
| `ALTER TABLE ...` | `alter` | Execute DDL, return updated schema |
| `PREFILL\|table\|{json}` | `prefill` | Parse values, fetch schema, return form data — no SQL executed |
| `INSERT INTO ...` | `insert` | Execute DML, return table name |
| `SELECT ...` | `query` | Execute, detect chart type, return rows + chartType |

4. Save messages to `morph_messages` for history
5. Auto-name session from first message

**Response actions:**
```
'create'  → new TableCard spawned on canvas
'alter'   → TableCard refreshes columns
'insert'  → morph:refresh event fires, TableCard refetches rows
'prefill' → SlidePanel slides in pre-filled
'query'   → VisualCard (stat / bar / table) spawned on canvas
```

**Chart type detection (for SELECT):**
- Single row, ≤2 columns, no GROUP BY → `stat`
- Has GROUP BY + aggregate (SUM/COUNT/AVG/MAX/MIN) → `bar`
- Everything else → `table`

**Internal DB tables:**
```
morph_sessions        → session list (id, name, created_at, updated_at)
morph_messages        → full chat history per session
morph_session_tables  → which tables belong to which session + canvas x/y positions
```

**Security:**
- `tableName` in `/api/data/:tableName` validated against `information_schema` before any query
- `morph_` tables hidden from `/api/schema` listing

---

## Frontend — File Structure

```
frontend/
├── app/
│   ├── layout.tsx              Root layout, Geist font, dark theme
│   ├── page.tsx                Orchestration — wires all components + state
│   └── globals.css             Dark theme, dot-grid canvas, animations
├── components/
│   ├── Sidebar.tsx             Session history (left panel)
│   ├── Canvas.tsx              Infinite canvas, pan, renders all card types
│   ├── TableCard.tsx           Draggable live data table card
│   ├── ChatPanel.tsx           Chat input + message history (bottom)
│   ├── SlidePanel.tsx          Pre-filled insert form (slides from right)
│   ├── FormModal.tsx           Manual "+ Add Row" modal
│   ├── StatCard.tsx            KPI number card (from SELECT queries)
│   ├── BarChartCard.tsx        Bar chart card (from GROUP BY queries)
│   └── QueryResultCard.tsx     Read-only result table card (from SELECT)
├── hooks/
│   └── useSession.ts           Central state: sessions, messages, tables, visualCards
├── lib/
│   └── api.ts                  Typed API client
└── types/
    └── index.ts                All TypeScript interfaces
```

---

## Frontend — Component Behaviours

**Sidebar**
- Lists sessions ordered by `updated_at` DESC
- Click to switch — restores messages + table positions from DB
- "New Chat" creates a fresh session
- Delete on hover — removes session and drops its DB tables
- Auto-updates session name when backend renames it

**Canvas**
- Infinite, dot-grid background
- Pan: middle-click or Space + left-click drag
- Renders TableCards, StatCards, BarChartCards, QueryResultCards
- New TableCards animate in (`cardAppear` keyframe)
- Empty state shows a prompt suggestion

**TableCard**
- Draggable (saves position to backend on drag end, supports `canvasScale` prop)
- Live rows via `GET /api/data/:tableName`
- Refreshes via `morph:refresh` custom event (insert from chat)
- "+ Add Row" opens FormModal

**ChatPanel**
- Fixed bottom, expandable
- Enter to send, Shift+Enter for newline
- Typing indicator (3 animated dots)
- Typewriter animation on latest assistant message
- Backtick-wrapped names styled as `code`
- Dispatches to canvas: create/alter → TableCard, prefill → SlidePanel, query → VisualCard, insert → morph:refresh event

**SlidePanel** *(Phase B)*
- `position: fixed`, slides from right (380px)
- Pre-filled from LLM-extracted values
- Type-aware inputs: text / number / checkbox / date / datetime
- FK detection (`_id` suffix → note shown)
- Confirm → POST to `/api/data/:tableName` → `morph:refresh` fires

**StatCard** *(Phase C)*
- 200px, violet top border accent
- Large KPI value + label
- Draggable, closeable (×)
- `animate-card-appear` on mount

**BarChartCard** *(Phase C)*
- 320px, auto-detects label vs. value column by JS type
- Up to 8 vertical violet bars, scaled to max value
- Value labels above bars, category labels below
- Draggable, closeable

**QueryResultCard** *(Phase C)*
- 360px, cyan accent (visually distinct from data tables)
- Read-only scrollable table (max 300px height)
- Draggable, closeable

---

## Example Prompts That Work Right Now

### Create & alter
```
I run a furniture shop. Track wood inventory.
Add columns for unit price and wood grade.
Add a suppliers table with company name, email, phone, country, payment terms.
Create a products table: name, wood type, labor hours, selling price, stock, status.
Create a customer orders table with customer, product, quantity, order date, delivery date, status.
Add an employees table: name, role, hourly rate, hire date, active.
```

### Insert via slide panel
```
Log a shipment: 200 White Oak boards from Atlas Lumber.
New supplier: WoodCo, sales@woodco.eu, +44-20-7946, UK, NET-60.
Add product: Oak Dining Table, White Oak, 14 hours, $1200, 3 in stock, available.
New order: Martin Dupont, 2 Oak Dining Tables, today, delivery April 20, pending.
```

### Query → stat cards
```
What is the total value of my inventory?
How many orders do I have?
What is the average selling price of my products?
```

### Query → bar charts
```
Show me inventory quantity by wood type.
Show me orders by status.
How many products per status?
```

### Query → result tables
```
Which orders are still pending?
Show me all products with more than 3 in stock.
Which suppliers are from the USA?
Show me all orders sorted by delivery date.
```
