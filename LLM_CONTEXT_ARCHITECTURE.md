# LLM Context Architecture — Morph

## The Pattern: Intent-Routed Minimal Context

Morph uses a **schema-first, data-last** pattern for LLM context. The core principle:
the LLM never sees raw table data unless it has already written SQL to retrieve it.
Data lives in PostgreSQL — the LLM's job is to write the right SQL, not to reason over raw rows.

---

## How It Works Today

### 1. Intent Detection (rule-based, free)

Before any LLM call, the backend classifies the user's message using regex:

| Intent | Trigger |
|---|---|
| `isAnalyze` | keywords: analyze, stats, insights, dashboard, KPIs... |
| `isSeed` | keywords: add random data, populate, seed tables... |
| `isCreateAndFill` | create + "based on my data / from my..." |
| `insert` | LLM emits PREFILL or INSERT after SQL gen |
| `select` | LLM emits SELECT after SQL gen |
| `create` | default fallback |

No LLM call is spent on intent classification. This is zero-cost routing.

### 2. Context Building: Schema Only

After intent detection, a single `sessionContext` is built from PostgreSQL metadata only:

```
Tables already in this session:
- clients [12 rows]: name (text), age (integer), weight (numeric), goal (text)
- meals [47 rows]: client (text), food (text), calories (integer)
- training_programs [8 rows]: client (text), program (text), duration (integer)

Existing relations:
- meals.client → clients
- training_programs.client → clients
```

**What's included**: table names, column names + types, row counts, inferred FK relations.
**What's excluded**: actual row data, sample rows, distinct values, any cell content.

This is the same context sent to every LLM call that needs schema awareness.

### 3. Per-Intent Context Rules

| Intent | What the LLM receives | Why |
|---|---|---|
| create / alter | schema context | needs to know existing tables to avoid duplicates |
| analyze | schema context | generates SQL queries — doesn't need data to write them |
| seed | schema context + relations | generates seed JSON — needs column types and FK links |
| createAndFill | schema context + 5 sample rows from existing tables | legitimately needs examples to fill the new table with real-looking data |
| insert (PREFILL) | schema context | user provides values in their message; LLM maps them to columns |
| select (query) | schema context for SQL gen → then SQL result rows for interpretation | two-step: write SQL → run it → interpret results |

### 4. Query Interpretation: Results Only

When the user asks a question (SELECT path):

1. LLM receives schema context → generates SQL
2. Backend runs the SQL against PostgreSQL
3. LLM receives **only the query result rows** to produce a natural-language answer

The LLM never sees raw table data. It sees the answer to the specific question it asked.

### 5. SQL Safety Layer

After LLM output, before execution:
- `sanitizeSQL`: removes markdown fences, fixes backtick quoting, normalizes table names
- `rewriteSQLForSession`: rewrites display names (e.g. `clients`) to actual prefixed names (`s3_clients`) for session isolation
- `makeSelectCaseInsensitive`: wraps WHERE string comparisons in `ILIKE` so exact-value matching isn't needed from context
- `quoteReservedColumnNames`: escapes PostgreSQL reserved words used as column names

---

## Token Budget — Before vs After

| Scenario | Before | After |
|---|---|---|
| 3 tables, 50 rows each | ~6k tokens | ~400 tokens |
| 8 tables, 200 rows each | ~20k tokens | ~900 tokens |
| 15 tables, 500 rows each | ~50k tokens | ~1.5k tokens |

The main removals that achieved this:
- **Sample rows** (3 per table): removed from main context
- **Distinct values** (up to 20 per text column): removed entirely — `ILIKE` + user-provided values handle this
- **`fullSessionData`** (100 rows × all tables for interpretation): removed — SQL result rows are sufficient
- **`existingDataContext`** (50 rows for createAndFill): capped at 5

---

## What Can Be Added Later

### Short term — if token budget grows again

**Relevance filtering**: when there are many tables, only include tables whose names or columns appear in the user's message. Simple keyword match — no embedding needed.

```ts
// rough idea
const words = message.toLowerCase().split(/\W+/);
const relevant = [...tableMap.keys()].filter(name =>
  words.some(w => name.includes(w) || w.includes(name))
);
// fall back to all tables if no match
```

**Context budget cap**: hard-limit `sessionContext` to N characters before sending. Drop tables in reverse relevance order if over budget. Protects against unexpected schema growth.

### Medium term — if schema grows large (20+ tables)

**Embedding-based schema search**: embed each table description once, store in pgvector, retrieve top-K relevant tables per message. Industry standard for large schemas. Adds infra complexity — only worth it at scale.

**Conversation memory compression**: today the backend doesn't send conversation history to the LLM (Groq path is stateless). If multi-turn context is added, compress old turns to a summary after N exchanges.

### Long term — production hardening

**Streaming responses**: pipe LLM output as a stream to the frontend so the user sees the answer token-by-token. Reduces perceived latency on slow queries.

**Query result caching**: cache identical SQL results for the same session for a short TTL (e.g. 30s). Avoids redundant DB queries when the user re-runs the same analysis.

**Per-table row count cache**: the current code runs `SELECT COUNT(*)` for every table on every request. A lightweight in-memory cache with a 10s TTL would eliminate this.

---

## Files

| File | Role |
|---|---|
| `backend/src/routes/chat.ts` | Intent detection, context building, SQL execution, response routing |
| `backend/src/lib/claude.ts` | LLM call wrappers (Groq + Claude), system prompts per intent |
| `backend/src/lib/postgres.ts` | DB connection, `getTableSchema`, query helpers |
