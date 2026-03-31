# Morph — Monthly Breakdown
> April → June 2025

---

## April — Build the Engine

**Theme:** Get the core pipeline working. Nothing else matters this month.

**Goal by end of month:** Type a sentence → table appears on screen.

### Week 1
- Initialize Next.js frontend project
- Initialize Fastify backend project
- Connect PostgreSQL with raw `pg` in Fastify
- Connect Claude API in Fastify
- Send a prompt → get SQL back → execute on DB
- Render a hardcoded table in Next.js UI

### Week 2
- Wire the full pipeline end-to-end (Next.js → Fastify → Claude → PostgreSQL → back to Next.js)
- Handle CREATE TABLE from natural language
- Basic canvas layout in Next.js
- Demo 1 (Furniture Workshop) partially working

### Week 3
- Handle ALTER TABLE (add columns live from user message)
- Table component renders dynamically from schema
- Demo 1 fully working end-to-end
- Basic error handling (invalid SQL, DB errors, Fastify errors)

### Week 4
- Clean up and stabilize both frontend and backend
- Test with various prompts and edge cases
- Document the engine architecture (for the report)
- Buffer for anything that slipped

**April deliverable:** Demo 1 fully working ✓

---

## May — Frontend + All 3 Demos

**Theme:** Build on top of the engine. Make it look real.

**Goal by end of month:** 3 demos working, UI presentable to anyone.

### Week 5
- Polish canvas UI (layout, spacing, colors)
- Add form component (INSERT rows via form)
- New Fastify route for data insertion
- Demo 2 (Student Dashboard) started

### Week 6
- Demo 2 (Student Dashboard) fully working
- Multiple linked tables from one conversation
- Improve prompt engineering for complex schemas

### Week 7
- Demo 3 (Nutritionist) started and working
- Add basic chart component (bar chart for calories)
- Link tables together (client → meal log)

### Week 8
- All 3 demos stable and polished
- Full end-to-end test of all scenarios
- Start writing the report (architecture section)
- Record a rough demo video

**May deliverable:** 3 demos running, UI clean ✓

---

## June — Report + Delivery

**Theme:** Stop building. Start documenting and presenting.

**Goal by end of month:** Project submitted and presented.

### Week 9
- Write report: introduction + problem statement + related work
- Write report: architecture and technical decisions
- Fix any bugs found during report writing

### Week 10
- Write report: implementation details + challenges
- Write report: results + demo description
- Final UI polish

### Week 11
- Write report: conclusion + future work
- Record final demo video (2–3 min, clean walkthrough)
- Prepare presentation slides

### Week 12
- Final review of report
- Deploy frontend to Vercel, backend to Railway
- Submit everything
- Present

**June deliverable:** Full project submitted and presented ✓

---

## Summary

| Month | Theme | End State |
|---|---|---|
| April | Engine | 1 demo working, pipeline stable |
| May | Demos + UI | 3 demos working, UI polished |
| June | Report + Delivery | Submitted and presented |
