# Morph — Project Overview
> Final Year Internship | 2025

---

## What is Morph?

Morph is an LLM-powered business operating system that starts as a completely blank canvas. The user simply describes what they need in natural language, and Morph dynamically generates the database schema, UI components, and workflows in real time.

Think of it as an empty whiteboard that understands your business and instantly builds the right tools on the spot.

---

## The Problem

Traditional tools force users into rigid structures:

- **ERPs (SAP, Odoo)** → days/weeks of setup, fixed modules, IT teams required
- **Productivity tools (Notion, Airtable)** → hours of manual configuration, no automation

Nobody built a tool that just *understands what you need* and builds it for you.

---

## The Solution

Morph interprets your intent in natural language and materializes fully functional interfaces — tables, forms, dashboards — directly on a canvas. No setup. No configuration. Just talk.

**The key innovation: Dynamic Schema Migration**

Database tables are created and altered in real time by the LLM based on user intent. The schema is never frozen — users can reshape it anytime by simply talking.

---

## How It Works

```
User types a sentence (Next.js frontend)
        ↓
HTTP request sent to Fastify backend
        ↓
Claude API generates SQL (CREATE TABLE / ALTER TABLE / INSERT)
        ↓
raw pg executes SQL live on PostgreSQL
        ↓
Fastify returns schema to frontend
        ↓
Next.js renders UI component on the canvas (table, form, chart)
```

**Example:**

> User: "I run a furniture shop, I need to track wood inventory"

Morph creates an `inventory` table with columns: Wood Type, Quantity, Vendor — and renders it instantly on the canvas.

> User: "Add a column for drying time"

Morph runs `ALTER TABLE inventory ADD COLUMN drying_time INTEGER` live. The column appears. No reload, no migration files.

---

## Why It's Different

| | Morph | Odoo / SAP | Notion / Airtable |
|---|---|---|---|
| Setup | Instant (just talk) | Days – Weeks | Hours of config |
| Schema | Dynamic, unlimited | Fixed per module | Manual / templates |
| Natural language | Full control | None | AI assist only |
| Auto-generated UI | Yes | No | No |
| Target user | Anyone | IT teams | Power users |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js + TypeScript + Tailwind CSS |
| Backend | Node.js + Fastify |
| LLM | Claude API (Anthropic) |
| Database | PostgreSQL + raw `pg` |
| Auth | None (hardcoded user for POC) |
| Deploy | Vercel (frontend) + Railway (backend) |

---

## The 3 Demos (POC Scope)

The POC demonstrates Morph working across 3 different domains using the same engine:

1. **Furniture Workshop** — inventory tracking, live ALTER TABLE
2. **Student Dashboard** — multiple linked tables, courses + tasks + grades
3. **Freelance Nutritionist** — clients + meal log, linked tables + chart

These are not 3 separate apps. They are 3 different conversations fed into the same pipeline.

---

## Expected Deliverables

- Working POC across 3 domains
- Dynamic Schema Migration Engine
- Dynamic canvas UI (tables, forms, basic charts)
- Full technical report
- Demo video (2–3 min walkthrough)
- Deployment on Vercel + Railway
