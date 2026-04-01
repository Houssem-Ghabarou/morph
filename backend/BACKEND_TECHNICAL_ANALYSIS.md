# Morph Backend Technical Analysis

This document explains how the backend works end-to-end so you can confidently continue development.

---

## 1) High-level architecture

The backend is a Fastify + PostgreSQL service that turns natural language into SQL and executes it against session-scoped tables.

- **Runtime**: Node.js + TypeScript
- **HTTP framework**: Fastify
- **DB**: PostgreSQL via `pg` pool
- **LLM layer**: Groq or Anthropic (provider chosen by env)
- **Main behavior**: `/api/chat` drives schema creation, data querying, and prefill insert flows

Core folders:

- `src/index.ts`: bootstrap + route registration
- `src/routes/*`: HTTP API handlers
- `src/lib/postgres.ts`: DB helpers
- `src/lib/migrations.ts`: bootstrap SQL migrations
- `src/lib/claude.ts`: LLM prompts and model calls
- `src/types/index.ts`: shared API/response types

---

## 2) Startup lifecycle (request-serving boot path)

File: `src/index.ts`

Startup sequence:

1. Load env via `dotenv/config`
2. Create Fastify with pretty logger
3. Register CORS
4. Register routes: sessions, chat, schema, data
5. Register `/health`
6. Start listening on `PORT` (default `3001`)
7. Test DB connection
8. Run migrations

Important operational note:

- The app listens **before** DB check and migrations. That means a client can hit endpoints while migrations are still running or before a failing DB check aborts startup.

---

## 3) Data model created by migrations

File: `src/lib/migrations.ts`

### `morph_sessions`

- `id SERIAL PRIMARY KEY`
- `name TEXT DEFAULT 'New Chat'`
- `created_at`, `updated_at`

Represents a chat workspace/session.

### `morph_messages`

- `session_id` references `morph_sessions(id)` with cascade delete
- `role` in `('user', 'system')`
- `text`, `warning`, `created_at`

Stores conversation transcript and warnings.

### `morph_session_tables`

- map of session -> table names
- has table card positions (`pos_x`, `pos_y`)
- unique `(session_id, table_name)`

Tracks what user tables belong to each session and where to render cards in UI.

---

## 4) Database access layer

File: `src/lib/postgres.ts`

Exports:

- `query(sql, params?)`: acquires a client, executes query, releases client
- `runInTransaction(fn)`: `BEGIN` -> callback -> `COMMIT` / `ROLLBACK`
- `getTableSchema(tableName)`: reads columns from `information_schema.columns`
- `testConnection()`: `SELECT 1`

Design observations:

- This layer is intentionally thin.
- Most validation/safety decisions happen in route handlers.
- `pool.on('error')` currently exits process immediately on pool error.

---

## 5) API routes overview

### 5.1 Sessions routes (`src/routes/sessions.ts`)

Endpoints:

- `GET /api/sessions`: list sessions ordered by `updated_at desc`
- `POST /api/sessions`: create a new session
- `GET /api/sessions/:id`: return session + messages + tables + derived relations
- `DELETE /api/sessions/:id`: drop all session-owned tables, then delete session
- `GET /api/sessions/:id/relations`: return derived relations for all session tables
- `PATCH /api/sessions/:id/tables/:tableName/position`: update table card XY position

Relation strategy here:

- Not DB foreign keys.
- Relations are inferred by matching text/varchar column names to other table names (singular/plural tolerant).

### 5.2 Schema routes (`src/routes/schema.ts`)

Endpoints:

- `GET /api/schema`: all `public` base tables except `morph_%`
- `GET /api/schema/:tableName`: column metadata for one table

Note:

- Session tables (`s{sessionId}_...`) are included because they are not `morph_%`.

### 5.3 Data routes (`src/routes/data.ts`)

Endpoints:

- `GET /api/data/:tableName`: `SELECT * ORDER BY created_at DESC`
- `POST /api/data/:tableName`: parameterized insert of JSON body
- `PATCH /api/data/:tableName/schema`: transactional schema changes + insert

`PATCH /schema` request shape:

- `changes: SchemaChange[]` where each item is:
  - `add` + `newType`
  - `rename` + `newName`
  - `retype` + `newType`
- `row: Record<string, unknown>` to insert after schema updates

Safety controls in this route:

- `ALLOWED_TYPES` whitelist
- `sanitizeIdentifier()` for columns
- transaction to keep ALTER + INSERT atomic

---

## 6) Chat route deep dive (the core of backend behavior)

File: `src/routes/chat.ts`

`POST /api/chat` powers most product logic.

Request type:

- `{ message: string; sessionId: number }`

Response type:

- `ChatResponse` with `action`, generated SQL, optional schema, optional rows/chart metadata, etc.

### 6.1 End-to-end flow

1. Validate `message` and `sessionId`
2. Compute session table prefix via `sessionPrefix(sessionId)` -> `s{sessionId}_`
3. Load session tables from `morph_session_tables`
4. Build LLM session context:
   - each table and its columns
   - small row sample
   - inferred table relations
5. Ask LLM to generate SQL (`generateSQL`)
6. Sanitize SQL (`sanitizeSQL`)
7. Handle multi-statement (`---`) or single statement path
8. Rewrite table names for session isolation (`rewriteSQLForSession`)
9. Execute one of several action branches:
   - `PREFILL` branch
   - `INSERT` -> converted to prefill confirmation branch
   - `SELECT` branch (query + interpretation)
   - DDL/DML branch (`CREATE`, `ALTER`, etc.)
10. Persist chat messages and session metadata in transactions

### 6.2 Why session table rewrite exists

Users and LLM think in display names (`orders`), but DB uses session names (`s12_orders`).

`rewriteSQLForSession()` maps display names -> actual table names to isolate data per session.

### 6.3 Multi-table creation mode

If LLM emits SQL with `---` separators:

- backend splits statements
- rewrites each statement to session-prefixed table names
- executes create statements
- registers created tables in `morph_session_tables`
- derives relations from resulting schemas
- returns action `create_many`

### 6.4 Prefill insert strategy

The backend intentionally avoids directly executing freeform LLM inserts from chat path.

Two ways prefill happens:

1. LLM emits `PREFILL|table|{json}`
2. LLM emits `INSERT ...`; backend intercepts and converts to prefill data

Result:

- frontend gets a form-ready payload
- user confirms before actual insert

This is a key safety and UX design choice.

### 6.5 SELECT flow

For query-like prompts:

- `makeSelectCaseInsensitive()` rewrites `= 'x'` to `ILIKE 'x'` in SELECTs
- SQL executes
- chart type is inferred (`stat`, `bar`, `table`)
- backend optionally gathers broader session rows
- second LLM pass (`interpretQueryResult`) converts row data to natural language

If interpretation fails, a fallback text message is returned.

### 6.6 CREATE / ALTER / other statement flow

For non-select, non-prefill actions:

- run SQL
- if duplicate table (`42P07`), mark `alreadyExisted=true`
- fetch schema of target table if discoverable
- compose system message via `buildMessage()`
- optionally generate suggestion text for new table
- persist everything transactionally

---

## 7) LLM integration and prompting

File: `src/lib/claude.ts`

Major functions:

- `generateSQL(...)`: natural language -> SQL/PREFILL
- `interpretQueryResult(...)`: rows -> human answer
- `generateSuggestion(...)`: post-create quick next-step suggestion

Provider selection:

- `LLM_PROVIDER=claude` -> Anthropic
- otherwise defaults to Groq

Prompt architecture:

- SQL-generation system prompt includes:
  - naming rules (snake_case)
  - intent classification (create/insert/query)
  - prefill protocol format
  - multi-table `---` separators
  - linking rules for related tables
- interpretation prompt includes strict anti-hallucination instructions

---

## 8) Type contracts and response surface

File: `src/types/index.ts`

Critical contracts:

- `ChatRequest`: `{ message, sessionId }`
- `ChatResponse.action` union:
  - `'create' | 'alter' | 'insert' | 'select' | 'unknown' | 'prefill' | 'query' | 'create_many'`
- `TableSchema`, `Column`, `Relation`
- `SessionDetail` (session + messages + card positions + derived relations)

When extending backend behavior, start by updating these shared types first.

---

## 9) Important design choices (why backend behaves this way)

1. **Session isolation by table prefix**  
   Enables multi-user/session separation without separate databases.

2. **Relation inference over hard foreign keys**  
   Faster for dynamic LLM-created schemas, but less strict than DB constraints.

3. **Prefill-first inserts from chat**  
   Reduces accidental writes and gives user confirmation step.

4. **Best-effort context generation**  
   Failures while gathering schema/sample context usually do not block chat request.

---

## 10) Risks / technical debt to know before extending

1. **Startup ordering risk**  
   Server begins listening before DB readiness/migrations.

2. **Raw LLM SQL execution**  
   Non-prefill operations can still execute LLM SQL directly.

3. **No authentication/authorization layer**  
   Current API trusts caller-provided `sessionId`.

4. **`information_schema` lookups are table-name based**  
   Could be ambiguous if additional schemas are introduced.

5. **Public schema listing**  
   `/api/schema` currently exposes all non-`morph_%` tables.

---

## 11) How to continue coding safely (practical guide)

### If you are adding a new API route

1. Add route file under `src/routes/`
2. Register it in `src/index.ts`
3. Define/extend shared types in `src/types/index.ts` if response is reused
4. Keep DB writes in `runInTransaction` when operations must be atomic

### If you are changing chat behavior

Touch these in order:

1. `src/lib/claude.ts` (prompt/model output expectations)
2. `src/routes/chat.ts` (sanitize/rewrite/branch logic)
3. `src/types/index.ts` (response contract updates)

### If you are changing relation behavior

Update both relation derivation paths:

- `src/routes/chat.ts` (`deriveRelations`)
- `src/routes/sessions.ts` (`getRelationsForTables`)

Keep them consistent so live chat and session reload render the same graph.

### If you are changing schema mutation flow

Main file:

- `src/routes/data.ts`

Rules to keep:

- sanitize column names
- type whitelist
- transactional ALTER + INSERT

---

## 12) Suggested immediate improvements (high impact)

1. Move `testConnection()` + `runMigrations()` before `listen()`
2. Add env validation (e.g., with `@fastify/env`, already in dependencies)
3. Add auth/session ownership checks
4. Add stronger SQL guards around LLM execution paths
5. Add integration tests for:
   - multi-table create (`---`)
   - prefill protocol
   - query interpretation fallback
   - schema patch + insert transaction rollback behavior

---

## 13) Quick call-chain map (for debugging)

### Chat request chain

`POST /api/chat`  
-> `routes/chat.ts`  
-> load session tables (`morph_session_tables`)  
-> `getTableSchema()` for context  
-> `generateSQL()`  
-> sanitize + rewrite  
-> action branch:

- create_many / prefill / insert->prefill / select / ddl  
  -> `query()` or `runInTransaction()`  
  -> save messages/session updates  
  -> return `ChatResponse`

### Data insert chain (non-chat)

`POST /api/data/:tableName`  
-> table exists check  
-> parameterized insert  
-> return inserted row

---

## 14) Mental model to keep while coding

Think of this backend as two layers:

1. **Control plane (Morph metadata tables)**  
   sessions, messages, table positions

2. **User data plane (dynamic session tables)**  
   generated/altered by LLM intents and direct data APIs

Most bugs happen at boundaries between:

- natural language intent -> SQL
- display table names -> session-prefixed DB table names
- inferred relationships -> UI expectations

If you protect those boundaries, most changes remain safe.
