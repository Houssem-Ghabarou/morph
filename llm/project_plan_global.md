# Morph — Global Project Plan
> Final Year Internship | April → June 2025

---

## Timeline Overview

| Phase | Month | Focus | Key Deliverable |
|---|---|---|---|
| 1 | April | Core engine | Pipeline works, Demo 1 functional |
| 2 | May | Frontend + demos | All 3 demos running |
| 3 | June | Report + delivery | Submitted and presented |

---

## What to Build vs What to Cut

### Build (MVP scope)
- Natural language → SQL generation via Claude API
- Live DDL execution on PostgreSQL (CREATE TABLE + ALTER TABLE)
- Table component rendering from schema
- Form component for inserting rows
- Basic chart component (bar chart)
- 3 working demo scenarios

### Cut (show as future work in report)
- WebSockets / real-time sync → use simple polling
- JWT / OAuth authentication → hardcode a user
- Kanban, Calendar views → mockup in report only
- Multi-user support → single user for POC
- User validation with real SMBs → 1 live demo is enough

---

## Phase 1 — April: Build the Engine

**Goal:** One working end-to-end pipeline. Demo 1 functional.

### Tasks
- Initialize Next.js frontend + Fastify backend
- Connect PostgreSQL with raw `pg` in Fastify
- Connect Claude API in Fastify
- Build the chat route: receives message → calls Claude → executes SQL → returns schema
- Render a basic table component in Next.js from schema
- Handle ALTER TABLE (add columns live)
- Demo 1 (Furniture Workshop) working end-to-end

**End of April deliverable:** Type a sentence → table appears on screen ✓

---

## Phase 2 — May: Frontend + All 3 Demos

**Goal:** Canvas UI polished. All 3 demos running.

### Tasks
- Polish canvas UI (layout, spacing, component styling)
- Add form component (INSERT rows via form)
- Add basic chart component (bar chart)
- Demo 2 (Student Dashboard) working
- Demo 3 (Nutritionist) working
- Error handling and edge cases on both frontend and backend

**End of May deliverable:** 3 demos working, UI presentable ✓

---

## Phase 3 — June: Report + Delivery

**Goal:** Clean report, recorded demo, ready to present.

### Tasks
- Final bug fixing and polish
- Record demo video (2–3 min walkthrough)
- Write full technical report
- Prepare presentation slides
- Deploy frontend to Vercel, backend to Railway
- Final delivery

**End of June deliverable:** Full project submitted ✓

---

## Folder Structure

```
morph/
├── frontend/                     # Next.js app
│   ├── app/
│   │   └── page.tsx              # Main canvas UI
│   ├── components/
│   │   ├── Canvas.tsx            # Main canvas container
│   │   ├── TableComponent.tsx    # Renders dynamic tables
│   │   └── FormComponent.tsx     # Renders dynamic forms
│   └── package.json
│
├── backend/                      # Fastify app
│   ├── src/
│   │   ├── routes/
│   │   │   ├── chat.ts           # receives message, calls Claude
│   │   │   ├── schema.ts         # executes DDL on PostgreSQL
│   │   │   └── data.ts           # CRUD on dynamic tables
│   │   ├── lib/
│   │   │   ├── claude.ts         # Claude API wrapper
│   │   │   └── postgres.ts       # raw pg client
│   │   └── index.ts              # Fastify server entry point
│   └── package.json
│
└── README.md
```

---

## The Flow

```
Next.js (user types)
      ↓ HTTP request
Fastify (calls Claude → executes SQL on PostgreSQL)
      ↓ returns schema
Next.js (renders table/form on canvas)
```

---

## Golden Rule

> Build the engine once. The 3 demos are just 3 different conversations fed into the same pipeline.

A clean demo of 1 use case working perfectly is worth 10x more than 5 broken features.
