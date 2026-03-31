# Morph — What's Remaining
> Updated: March 2026

---

## Phase A — Multi-table Relational Creation
*"I need inventory, suppliers and orders with proper relationships"*
**→ 3 linked tables appear at once with FK arrows on canvas**

### Backend
- LLM returns multiple SQL statements separated by `---`
- Backend splits, executes each in order
- Detects `REFERENCES` clauses → extracts FK relationships
- New response field: `relations: [{ from, to, on }]`
- New action: `'create_many'`

### Frontend
- `Canvas.tsx`: render SVG lines between related TableCards
- Cards spawn in a smart layout (related tables positioned near each other)
- `ChatPanel`: handle `action: 'create_many'` → spawn all cards at once

### Example prompts to enable
```
I run a furniture shop. I need inventory, suppliers, and orders with proper relationships.
Create a school database: students, courses, and enrollments linked together.
```

---

## Phase D — Inline Editing & Row Actions

### What to build
- **Inline cell edit**: click any cell in a TableCard → becomes an input → blur fires `UPDATE` query
- **Delete row**: trash icon appears on row hover → fires `DELETE FROM table WHERE id = $1`
- **New backend route**: `PATCH /api/data/:tableName/:id` → UPDATE single row
- **New backend route**: `DELETE /api/data/:tableName/:id` → DELETE single row
- **CSV export**: download button on TableCard header → client-side CSV from current rows
- **Column sort**: click column header in TableCard → re-fetches with `ORDER BY col ASC/DESC`
- **Row search/filter**: search input above table → client-side filter on displayed rows

### Why it matters
Right now data can only be added. Users need to fix mistakes, update statuses, delete test rows.

---

## Phase E — Kanban View

*When a table has a `status` column, offer a Kanban toggle on the TableCard*

### What to build
- Button in TableCard header: `≡ Table | ⬜ Kanban`
- Kanban renders columns from distinct `status` values
- Cards show other non-system columns as content
- Drag a card between columns → `PATCH /api/data/:tableName/:id` with new status
- Smooth drag with drop zones

### Example tables it works on
```
orders (status: pending / confirmed / delivered)
tasks (status: todo / in_progress / done)
products (status: available / out_of_stock / discontinued)
```

---

## Phase F — Proactive Insights (Alerts)

*Morph notices things in your data and tells you*

### What to build
- After every `INSERT` or `ALTER`, run a background check:
  - Low stock detection: `SELECT * FROM inventory WHERE quantity < 20`
  - Overdue orders: `SELECT * FROM orders WHERE delivery_date < NOW() AND status != 'delivered'`
- If results found → show a subtle alert banner above the canvas
- LLM generates the check query based on the table schema automatically

### Backend
- New route: `POST /api/sessions/:id/insights` → runs LLM-generated checks
- Called client-side after each successful insert

### Frontend
- `InsightBanner.tsx` — dismissible top bar: "⚠ Pine stock is below 20 units"

---

## Phase G — Deployment

### Frontend → Vercel
```bash
cd frontend && npx vercel --prod
# Set env: NEXT_PUBLIC_API_URL=https://your-backend.railway.app
```

### Backend → Railway
```bash
# railway.toml already needed
# Set env: DATABASE_URL, ANTHROPIC_API_KEY or GROQ_API_KEY, LLM_PROVIDER
```

### Things to fix before deploy
- `CORS` in `backend/src/index.ts`: add Vercel production URL to allowed origins
- `NEXT_PUBLIC_API_URL` in `frontend/lib/api.ts`: currently hardcoded to `localhost:3001`
- Add `railway.toml` or `Procfile` for backend start command

---

## Nice-to-haves (Report / Future Work section)

These are worth mentioning in the report as future directions but NOT building for the POC:

| Feature | Why cut |
|---|---|
| WebSocket real-time sync | Polling is enough for single-user POC |
| JWT / OAuth auth | Hardcoded user is fine for demo |
| Multi-user support | Out of scope |
| Chart type picker (pie, line) | Bar covers 90% of demo needs |
| Natural language → dashboard layout | Complex UX, not needed for POC |
| Undo last action | Nice but not critical |

---

## Priority Order

| # | Phase | Impact | Effort | Status |
|---|---|---|---|---|
| 1 | **A — Multi-table creation** | Very high | High | Not started |
| 2 | **D — Inline edit + row delete** | High | Medium | Not started |
| 3 | **G — Deployment** | High (demo day) | Low | Not started |
| 4 | **E — Kanban view** | Medium | High | Not started |
| 5 | **F — Proactive insights** | Medium | Medium | Not started |
