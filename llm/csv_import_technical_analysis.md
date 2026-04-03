# CSV Import — Full Technical Analysis
**How the system works, how the LLM reads your data, and how it understands your business**

---

## 1. Bird's Eye View

```
User drops CSV
      │
      ▼
[Frontend: ImportModal]
  • reads file locally
  • optionally collects business description (first import only)
      │
      ▼  POST /api/import/analyze?sessionId=X&description=...
         multipart/form-data  { csv: <file> }
[Backend: routes/import.ts]
  • parses CSV with csv-parse
  • queries morph_session_tables for this session
  • fetches column schema for each existing table
      │
      ▼
[Backend: lib/csvImport.ts  ←  the AI brain]
  • decides: new table or existing?
  • calls LLM (Groq or Claude)
  • returns structured suggestion
      │
      ▼  JSON response back to frontend
[Frontend: ImportModal — confirm step]
  • user reviews + edits table name / column types / mapping
      │
      ▼  POST /api/import/confirm  (plain JSON)
[Backend: routes/import.ts]
  • CREATE TABLE + INSERT  (Flow 1)
  • INSERT with column mapping  (Flow 2)
  • registers table in morph_session_tables
      │
      ▼
Canvas reloads — new table card appears
```

---

## 2. Step 1 — Parsing the CSV (no AI involved yet)

File: `backend/src/routes/import.ts`

```
csv-parse options:
  skip_empty_lines: true   → ignores blank rows
  relax_column_count: true → tolerates rows with fewer/more columns than header
  trim: true               → strips whitespace from every cell
```

From `sample_products.csv` the parser produces:

```
headers  = ["Product Name", "Category", "Price", "Stock", "SKU", "Supplier"]

dataRows = [
  ["Wireless Headphones", "Electronics", "89.99", "120", "WH-1042", "SoundGear"],
  ["Mechanical Keyboard",  "Electronics", "149.00", "45",  "MK-0388", "KeyMaster"],
  ...  (all 15 rows)
]
```

**Important:** every value arrives as a `string` at this stage. The LLM has to infer which strings are numbers, dates, booleans. This is why sample rows are critical — the LLM can't guess `"89.99"` is `NUMERIC` from the header name alone but CAN when it sees five rows of it.

Only the first 5 rows are sent to the LLM (cost and token control). All rows are sent back to the frontend as-is and stay in memory until confirm.

---

## 3. Step 2 — Flow Decision (the routing logic)

File: `backend/src/lib/csvImport.ts`, function `analyzeCSV()`

```
existingTables = tables registered in morph_session_tables for this session
                 each with their full column list from information_schema

if existingTables.length === 0:
    → go straight to Flow 1  (no LLM decision call needed)

else:
    → call matchExistingTable()   (LLM call #1)
        if matched === true  → Flow 2
        if matched === false → Flow 1  (fallback, LLM call #2)
```

This two-step approach solves the biggest original bug: the system was previously
forcing the LLM into Flow 2 even when the CSV had nothing to do with existing tables.
Now the LLM can explicitly say "no match" and the system creates a new table instead.

---

## 4. Step 3a — Flow 1: Creating a New Table

### What the LLM receives

```
Business context: I run an office supply store        ← from user input (optional)

Given these CSV headers and sample data rows, suggest a PostgreSQL table schema.

CSV Headers: ["Product Name","Category","Price","Stock","SKU","Supplier"]
Sample rows (up to 5):
["Wireless Headphones","Electronics","89.99","120","WH-1042","SoundGear"]
["Mechanical Keyboard","Electronics","149.00","45","MK-0388","KeyMaster"]
["Standing Desk Mat","Office","34.50","200","SDM-773","ComfortCo"]
["USB-C Hub 7-in-1","Electronics","49.99","88","UC-2211","TechLink"]
["Ergonomic Mouse","Electronics","62.00","60","EM-4490","KeyMaster"]

Return ONLY this JSON shape:
{
  "tableName": "snake_case_table_name",
  "columns": [
    {"csvHeader": "original header", "pgName": "snake_case_name", "pgType": "TEXT"}
  ]
}

Rules:
- tableName must be snake_case and describe the data
- pgType must be one of: TEXT, INTEGER, NUMERIC, BOOLEAN, DATE, TIMESTAMP
- Infer the most appropriate type from the sample values
```

### What the LLM returns

```json
{
  "tableName": "products",
  "columns": [
    {"csvHeader": "Product Name", "pgName": "product_name", "pgType": "TEXT"},
    {"csvHeader": "Category",     "pgName": "category",     "pgType": "TEXT"},
    {"csvHeader": "Price",        "pgName": "price",        "pgType": "NUMERIC"},
    {"csvHeader": "Stock",        "pgName": "stock",        "pgType": "INTEGER"},
    {"csvHeader": "SKU",          "pgName": "sku",          "pgType": "TEXT"},
    {"csvHeader": "Supplier",     "pgName": "supplier",     "pgType": "TEXT"}
  ]
}
```

### How type inference works

The LLM inspects the actual sample values, not just the header name:

| CSV header | Sample values seen | Inferred type | Reasoning |
|---|---|---|---|
| `Price` | `89.99`, `149.00`, `34.50` | `NUMERIC` | decimal point → not integer |
| `Stock` | `120`, `45`, `200` | `INTEGER` | whole numbers, inventory count |
| `SKU` | `WH-1042`, `MK-0388` | `TEXT` | alphanumeric codes |
| `Category` | `Electronics`, `Office` | `TEXT` | categorical string |
| `Start Date` | `2021-03-15` | `DATE` | ISO 8601 pattern |
| `Status` | `Active`, `Inactive` | `TEXT` | not boolean (more than 2 values possible) |
| `Is Active` | `true`, `false` | `BOOLEAN` | binary string values |

### How business context changes the result

**Without description:**
```
CSV: ["Full Name","Department","Job Title","Salary","Start Date"]
→ tableName: "employees"      (generic guess from headers)
→ pgName for "Full Name": "full_name"
```

**With description:** `"I run a SaaS company and track my engineering team"`
```
→ tableName: "team_members"   (domain-aware name)
→ pgName for "Full Name": "name"   (shorter, domain-appropriate)
→ salary pgType: NUMERIC           (same inference, but now the model
                                    knows this is a salary not a score)
```

The description does not change the columns — it changes the *naming convention*
and *semantic interpretation* of what the data means.

---

## 5. Step 3b — Flow 2: Matching an Existing Table

### LLM call #1 — the match decision

This is the most semantically demanding call. The LLM must reason about whether
two schemas are talking about the same real-world entity.

**Input to LLM:**

```
I have a CSV file and some existing database tables.
Decide if the CSV belongs in one of the existing tables or if it needs a new table.

CSV Headers: ["Order ID","Customer","Product","Quantity","Unit Price","Total","Status","Order Date"]
Sample row: ["ORD-0001","Alice Moreau","Wireless Headphones","2","89.99","179.98","Delivered","2024-01-08"]

Existing tables:
"s1_products": columns [id (integer), product_name (text), category (text), price (numeric), stock (integer), sku (text), supplier (text), created_at (timestamp)]
"s1_employees": columns [id (integer), name (text), department (text), job_title (text), salary (numeric), start_date (date), email (text), status (text), created_at (timestamp)]

If the CSV is clearly a good fit for one of the existing tables, return:
{ "matched": true, "tableName": "...", "mapping": [...] }

If it does NOT match any existing table well, return:
{ "matched": false }
```

**LLM reasons:**
- `Order ID`, `Quantity`, `Total`, `Order Date` → these columns do not exist in `s1_products` or `s1_employees`
- The domain (orders/transactions) is distinct from products (catalog) and employees (HR)
- Decision: `{ "matched": false }`

→ System falls back to Flow 1 and creates a new `orders` table.

**Different scenario** — uploading more product data to an existing products table:

```
CSV Headers: ["Item", "Type", "Cost", "Units In Stock", "Code"]
Existing: "s1_products": [product_name, category, price, stock, sku, ...]

LLM reasons:
  "Item"         ≈ product_name  (same concept, different word)
  "Type"         ≈ category      (synonym)
  "Cost"         ≈ price         (same concept)
  "Units In Stock" ≈ stock       (same concept, verbose header)
  "Code"         ≈ sku           (product code = SKU)

→ { "matched": true, "tableName": "s1_products", "mapping": [
    {"csvHeader": "Item",             "tableColumn": "product_name"},
    {"csvHeader": "Type",             "tableColumn": "category"},
    {"csvHeader": "Cost",             "tableColumn": "price"},
    {"csvHeader": "Units In Stock",   "tableColumn": "stock"},
    {"csvHeader": "Code",             "tableColumn": "sku"}
  ]}
```

Columns with no match get `"tableColumn": null` and are shown in amber in the UI.

### Validation after the LLM call

The code does one hardcoded check the LLM cannot fake:

```typescript
const tableNames = existingTables.map((t) => t.tableName);
if (!tableNames.includes(json.tableName as string)) return { matched: false };
```

If the LLM hallucinates a table name that doesn't exist in the database,
the system treats it as no match and creates a new table. This prevents
phantom inserts into non-existent tables.

---

## 6. Step 4 — Confirm: Writing to PostgreSQL

File: `backend/src/routes/import.ts`, endpoint `POST /api/import/confirm`

### Flow 1 SQL generated

```sql
-- Table name is prefixed with session ID for isolation
CREATE TABLE "s1_products" (
  id          SERIAL PRIMARY KEY,
  product_name TEXT,
  category    TEXT,
  price       NUMERIC,
  stock       INTEGER,
  sku         TEXT,
  supplier    TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Parameterized insert per row (prevents SQL injection)
INSERT INTO "s1_products" (product_name, category, price, stock, sku, supplier)
VALUES ($1, $2, $3, $4, $5, $6);
-- × 15 rows, all inside a single transaction
```

Empty cells in the CSV become `NULL` (not empty string):
```typescript
return v === undefined || v === '' ? null : v;
```

### Flow 2 SQL generated

Only the mapped columns are inserted. Unmapped columns (`tableColumn: null`) are silently skipped.

```sql
-- Only active mappings (tableColumn !== null)
INSERT INTO "s1_products" (product_name, category, price, stock, sku)
VALUES ($1, $2, $3, $4, $5);
-- "Supplier" column had no match → not inserted, no error
```

### Session registration

After `CREATE TABLE`, the new table is immediately registered:

```sql
INSERT INTO morph_session_tables (session_id, table_name)
VALUES (1, 's1_products')
ON CONFLICT (session_id, table_name) DO NOTHING;
```

This makes the table card appear on the canvas after `session.switchSession()` is called.
Without this, the table exists in PostgreSQL but is invisible to the UI.

---

## 7. The Session Isolation Model

Every user table is prefixed: `s{sessionId}_{tableName}`

```
Session 1: s1_products, s1_employees, s1_orders
Session 2: s2_clients,  s2_invoices
```

This means:
- Two sessions can both have a `products` table without collision
- Deleting a session drops all its `s{id}_*` tables via CASCADE
- The LLM only ever sees tables from the current session
  (it can't accidentally map a CSV to another session's table)

---

## 8. LLM Provider Switching

The system supports two providers, set via `LLM_PROVIDER` env var:

| | Groq (default) | Claude |
|---|---|---|
| Env var | `LLM_PROVIDER=groq` | `LLM_PROVIDER=claude` |
| Model | `GROQ_MODEL` (llama-3.3-70b) | `CLAUDE_MODEL` (claude-opus-4-6) |
| API style | OpenAI-compatible chat | Anthropic messages API |
| Temperature | `0` (deterministic) | default |
| System prompt | separate `system` role | inline in user message |

For Groq, the system prompt is explicit:
```
"You are a database schema analyst. You ONLY output valid JSON.
Never output explanations, markdown, or backticks."
```

Temperature `0` is critical for JSON reliability — at higher temperatures
the model is more likely to add commentary around the JSON object.

---

## 9. JSON Robustness

LLMs sometimes wrap JSON in markdown code fences or prepend a sentence.
The `parseJSON()` function handles this defensively:

```typescript
function parseJSON(raw: string): Record<string, unknown> {
  // 1. Strip ```json ... ``` fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  // 2. Extract the first {...} block even if text appears before/after
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in LLM response');

  // 3. Parse
  return JSON.parse(match[0]);
}
```

This handles the four most common LLM JSON failure modes:
- `Sure! Here is the JSON: { ... }` → regex extracts `{...}`
- ` ```json\n{ ... }\n``` ` → fence stripping
- Trailing comma in last array element → JSON.parse throws, error propagates to user
- Wrong tableName (hallucinated) → post-parse validation catches it

---

## 10. What the System Cannot Do (Current Limits)

| Limitation | Why | Workaround |
|---|---|---|
| No type coercion on insert | All values inserted as strings; PostgreSQL coerces (e.g. `"89.99"` → NUMERIC) | Works for standard types; breaks for custom formats |
| Max 10 MB CSV | `@fastify/multipart` file size limit | Adjust `limits.fileSize` in `index.ts` |
| 5-row sample only | Reduces LLM cost and latency | LLM might miss rare values (e.g. a date that only appears in row 50) |
| Flow 2 only maps to one table | Single best-match table per upload | Upload twice if data spans two tables |
| No duplicate detection | Re-importing the same CSV creates duplicate rows | Add a unique constraint on a natural key manually |

---

## 11. Full Data Flow Trace — `sample_products.csv` on empty session

```
1.  User opens ImportModal on empty canvas
2.  User types: "I run an office supply store"       ← stored in descriptionRef
3.  User drops sample_products.csv

4.  Frontend: processFile() called
    → api.analyzeCSV(file, sessionId=1, "I run an office supply store")
    → FormData { csv: <file> }
    → GET /api/import/analyze?sessionId=1&description=I+run+an+office+supply+store

5.  Backend: multipart parsed, file.toBuffer() → Buffer
    csv-parse → headers=[6], dataRows=[15 rows]

6.  morph_session_tables WHERE session_id=1 → [] (empty)
    existingTables = []

7.  analyzeCSV() → existingTables.length === 0 → skip match call
    → suggestNewTable(headers, first5rows, "I run an office supply store")

8.  LLM prompt built (see Section 4)
    → Groq API call: llama-3.3-70b-versatile, temperature=0, max_tokens=1024

9.  LLM response (≈ 400ms):
    {"tableName":"products","columns":[...6 columns with inferred types...]}

10. parseJSON() → validated object
    → return { flow:'new', tableName:'products', columns:[...] }

11. Backend response to frontend:
    {
      flow: 'new',
      tableName: 'products',
      columns: [...],
      headers: [...],
      rows: [[...], ...15 rows total...]   ← full data, not just sample
    }

12. Frontend: step → 'confirm'
    Shows: editable table name "products"
            table with 6 rows (one per column)
            each row: CSV header | editable pg name | PG type dropdown

13. User clicks "Confirm import"
    → api.confirmImport({
        flow: 'new',
        sessionId: 1,
        tableName: 'products',     ← possibly user-edited
        columns: [...],
        headers: [...],
        rows: [[...15 rows...]]
      })

14. Backend: runInTransaction()
    → CREATE TABLE "s1_products" (id SERIAL PRIMARY KEY, product_name TEXT, ...)
    → INSERT INTO morph_session_tables (1, 's1_products')
    → 15× INSERT INTO "s1_products" (...) VALUES ($1...$6)
    → COMMIT

15. Response: { rowsImported: 15, tableName: 's1_products' }

16. Frontend: onSuccess() called
    → session.switchSession(1)  → reloads session → new table card on canvas
    → toast: "15 rows imported into products"
    → modal closes
```

Total time: ~600–900ms (dominated by LLM call).
Zero LLM calls if the user edits and confirms without re-uploading.
