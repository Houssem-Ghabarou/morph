# LLM Context Optimization Plan

## The Problem

Every LLM call receives a `sessionContext` built by scanning **every table** in the session:
- Schema (columns + types)
- Row count + 3 sample rows
- **All distinct values** for every text column (up to 20/column)

Plus, for query interpretation, a `fullSessionData` dump that fetches **up to 100 rows per table** and serializes all of them as JSON.

With a large project (many tables, many rows, many text columns) this easily hits 15k–20k tokens — blowing past Groq's 8k TPM free tier limit and costing real money on any provider.

Real-world LLM apps **never** send all their data. They send only what's needed for the specific task.

---

## Root Cause Breakdown

| Source | Why it blows up |
|---|---|
| `valuesLine` (distinct text values) | 20 values × N text columns × M tables = unbounded |
| `sampleLine` (3 rows per table) | Each row can be wide; N tables × 3 rows |
| `fullSessionData` (query interpretation) | 100 rows × M tables, serialized as JSON — worst offender |
| `sessionContext` sent to every call | Analysis, SQL gen, seed, createAndFill — all get the full dump |

---

## Industry-Standard Approaches

### 1. Schema-only context for SQL generation (high impact, easy)
NL→SQL only needs **column names and types**. It does NOT need sample rows or distinct values to write a valid SQL query. Strip those for the `generateSQL` call.

### 2. Cap distinct values aggressively (high impact, easy)
If you keep distinct values for WHERE clause accuracy, limit to **5 values per column max** and **only for columns the user's message references** (keyword match).

### 3. Replace `fullSessionData` with query-result-only interpretation (critical, easy)
The `interpretQueryResult` function already receives the SQL query results. That is the only data needed to answer the user's question. Remove the `fullSessionData` dump entirely — it's an anti-pattern that sends irrelevant rows.

### 4. Truncate `sessionContext` to a hard token budget (safety net, easy)
Add a character budget (e.g., 6000 chars ≈ 1500 tokens) on `sessionContext`. If it exceeds the budget, drop sample rows first, then distinct values, then truncate to the first N tables.

### 5. Relevance filtering for large schemas (medium impact, medium effort)
When there are many tables, only include the tables that are likely relevant to the current message. Use simple keyword matching: if the user says "clients", only include tables whose names or columns contain "client". Fall back to all tables if no match.

### 6. Separate context shapes per call type (clean architecture)
Different LLM calls need different context:
- **SQL generation**: schema only (no data)
- **Analysis generation**: schema + row counts only (no data)  
- **Query interpretation**: SQL result rows only (no full dump)
- **Seed generation**: schema + FK relationships only

---

## Implementation Plan

### Phase 1 — Quick wins (1–2 hours, eliminates 80% of token bloat)

**Step 1.1 — Remove `fullSessionData`** (`chat.ts:1048–1068`)
Delete the block that fetches 100 rows per table. Pass `undefined` as `fullSessionData` to `interpretQueryResult`. The function already falls back to just the SQL result rows. This alone eliminates the biggest source of bloat.

**Step 1.2 — Cap distinct values to 5 per column** (`chat.ts:395`)
Change `LIMIT 20` → `LIMIT 5`. This is a simple query change that cuts that section by 4×.

**Step 1.3 — Hard-cap `sessionContext` length** (`chat.ts:426`)
After building `sessionContext`, truncate at 4000 characters. Add a helper:
```ts
function capContext(ctx: string, maxChars = 4000): string {
  if (ctx.length <= maxChars) return ctx;
  return ctx.slice(0, maxChars) + '\n...[context truncated]';
}
```
Apply before every LLM call.

### Phase 2 — Per-call context shapes (2–3 hours, clean architecture)

**Step 2.1 — Schema-only context for SQL generation**
Create a `buildSchemaContext(tableMap, allSchemas): string` helper that only outputs column names/types, no rows, no values. Use this for `generateSQL` calls.

**Step 2.2 — Stats context for analysis generation**
Create a `buildStatsContext(tableMap, allSchemas, rowCounts): string` helper that outputs schema + row counts + relations. No sample rows. Use this for `generateAnalysisQueries`.

**Step 2.3 — No context for interpretation**
Remove `sessionContext` from the `interpretQueryResult` call. The SQL results + user question is all that's needed. The function signature already supports this.

### Phase 3 — Relevance filtering (optional, for very large schemas, 2–3 hours)

**Step 3.1 — Keyword-based table relevance**
```ts
function relevantTables(message: string, tableMap: Map<string, string>): Set<string> {
  const words = message.toLowerCase().split(/\W+/);
  const relevant = new Set<string>();
  for (const [display] of tableMap) {
    if (words.some(w => display.includes(w) || w.includes(display.replace(/_/g, '')))) {
      relevant.add(display);
    }
  }
  return relevant.size > 0 ? relevant : new Set(tableMap.keys()); // fallback: all
}
```
Use this to filter which tables go into `sessionContext` for SQL generation.

---

## Expected Token Reduction

| Scenario | Before | After Phase 1 | After Phase 2 |
|---|---|---|---|
| 3 tables, 50 rows each | ~6k tokens | ~1.5k tokens | ~800 tokens |
| 8 tables, 200 rows each | ~20k tokens | ~3k tokens | ~1.2k tokens |
| 15 tables, 500 rows each | ~50k tokens | ~5k tokens | ~2k tokens |

---

## Files to Modify

- `backend/src/routes/chat.ts` — context building (lines 340–430), fullSessionData block (1048–1068)
- `backend/src/lib/claude.ts` — function signatures for context params

---

## What NOT to Do

- Do not add a vector DB / embeddings for this scale — overkill for a POC
- Do not cache context in Redis yet — premature optimization
- Do not change providers to fix a token bloat problem — the real fix is sending less
