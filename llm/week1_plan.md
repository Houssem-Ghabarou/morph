# Morph — Week 1 Plan
> April 1–7, 2025 | First week, start from zero

---

## Goal This Week

By end of Sunday: **type a sentence in Next.js → Fastify calls Claude → SQL executes on PostgreSQL → table renders on screen.**

One working pipeline across both frontend and backend.

---

## Day 1 — Project Setup

**Tasks:**

Initialize the frontend:
```bash
npx create-next-app@latest frontend --typescript --tailwind --app
```

Initialize the backend:
```bash
mkdir backend && cd backend
npm init -y
npm install fastify @fastify/cors
npm install --save-dev typescript ts-node @types/node
```

Set up PostgreSQL locally (or on Supabase free tier).

Create `backend/.env`:
```
DATABASE_URL=postgresql://localhost:5432/morph
ANTHROPIC_API_KEY=sk-ant-...
```

Create `frontend/.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:3001
```

Test DB connection — run a simple `SELECT 1` query from Fastify.

**End of day goal:** Both projects run locally, DB is connected ✓

---

## Day 2 — Claude API Connected in Fastify

**Tasks:**
- Install Anthropic SDK in backend
  ```bash
  npm install @anthropic-ai/sdk
  ```
- Create `backend/src/lib/claude.ts` — simple wrapper around the Claude API
- Write a hardcoded test prompt:
  > "I run a furniture shop, I need to track wood inventory"
- Log the Claude response to the console
- Verify the response contains valid SQL

**End of day goal:** Claude returns a CREATE TABLE statement from Fastify ✓

---

## Day 3 — Execute SQL Live in Fastify

**Tasks:**
- Install `pg` in backend
  ```bash
  npm install pg && npm install --save-dev @types/pg
  ```
- Create `backend/src/lib/postgres.ts` — raw `pg` client
- Create `backend/src/routes/schema.ts`
- Take the SQL from Claude → execute it with `pg.query(sql)`
- Verify the table was created in PostgreSQL
- Test with `\dt` in psql to confirm

**End of day goal:** Table created in DB from Claude output ✓

---

## Day 4 — Wire the Full Fastify Pipeline

**Tasks:**
- Create `backend/src/routes/chat.ts`
  - Receives user message
  - Calls Claude API
  - Executes returned SQL on PostgreSQL
  - Returns the schema (table name + columns) as JSON
- Register routes in `backend/src/index.ts`
- Enable CORS so Next.js can call Fastify
- Test with curl:
  ```bash
  curl -X POST http://localhost:3001/api/chat \
    -H "Content-Type: application/json" \
    -d '{"message": "I run a furniture shop, I need inventory tracking"}'
  ```

**End of day goal:** Fastify returns a schema JSON from a user message ✓

---

## Day 5 — Render the Table in Next.js

**Tasks:**
- Create `frontend/components/TableComponent.tsx`
  - Takes columns + rows as props
  - Renders a clean HTML table with Tailwind
- Create `frontend/app/page.tsx` — main canvas
  - Text input for user message
  - Button to send → calls `http://localhost:3001/api/chat`
  - Renders TableComponent when schema comes back

**End of day goal:** Table renders on screen from user input ✓

---

## Day 6 — End-to-End Test

**Tasks:**
- Test the full flow manually:
  1. Type: "I run a furniture shop, I need inventory tracking"
  2. Table appears with correct columns
  3. Type: "Add a column for drying time"
  4. ALTER TABLE runs, column appears in the table
- Fix any bugs in both frontend and backend
- Handle basic errors (Claude returns invalid SQL, DB fails, Fastify crashes)

**End of day goal:** Demo 1 partially working end-to-end ✓

---

## Day 7 — Buffer + Cleanup

**Tasks:**
- Fix anything that broke during Day 6 testing
- Clean up code on both frontend and backend
- Write a short note on what worked and what was hard (useful for the report later)
- Plan Week 2 tasks

**End of day goal:** Pipeline stable, code clean ✓

---

## Files to Create This Week

```
morph/
├── frontend/
│   ├── app/
│   │   └── page.tsx                  ← Day 5
│   └── components/
│       └── TableComponent.tsx        ← Day 5
│
├── backend/
│   └── src/
│       ├── routes/
│       │   ├── chat.ts               ← Day 4
│       │   └── schema.ts             ← Day 3
│       ├── lib/
│       │   ├── claude.ts             ← Day 2
│       │   └── postgres.ts           ← Day 3
│       └── index.ts                  ← Day 4
```

---

## Week 1 Success Criteria

- [ ] Next.js frontend running locally
- [ ] Fastify backend running on port 3001
- [ ] PostgreSQL connected to Fastify
- [ ] Claude API returning valid SQL from Fastify
- [ ] SQL executing live on the DB
- [ ] Table rendering in Next.js from Fastify response
- [ ] ALTER TABLE working (add a column from a message)
