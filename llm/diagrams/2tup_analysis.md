# 2TUP Applied to Morph — Analysis

## What is 2TUP?

**2TUP (Two-Track Unified Process)** is a software engineering methodology developed by Pascal Roques and Franck Vallée. It is an adaptation of the Rational Unified Process (RUP) designed to be lighter, more pragmatic, and better suited for academic and mid-scale projects.

The central idea is to split development into **two parallel tracks** that eventually merge:

```
Branche Fonctionnelle          Branche Technique
(Functional Branch)            (Technical Branch)
        |                              |
  Besoins fonctionnels          Contraintes techniques
  Use cases, domain model       Architecture, frameworks, infra
        |                              |
        └──────────┬───────────────────┘
                   ▼
          Branche de Conception
          (Design Branch — merge)
                   |
            Implémentation
                   |
                  Tests
```

### The Six Phases

| Phase | Branch | Key Artifacts |
|---|---|---|
| 1. Capture des besoins fonctionnels | Functional | Use case diagram, domain class diagram |
| 2. Capture des besoins techniques | Technical | Component diagram, deployment diagram, tech choices |
| 3. Analyse | Functional | Sequence diagrams, refined class diagram |
| 4. Conception préliminaire | Technical | Architecture skeleton, frameworks |
| 5. Conception détaillée (merge) | Both | Full class diagram, component wiring |
| 6. Implémentation + Tests | Both | Source code, test plans |

---

## 2TUP Applied to Morph

### Functional Branch → Morph's Features

The functional requirements of Morph are clear and well-scoped:

| Use Case Group | Use Cases |
|---|---|
| Authentication | Register, Sign In, Sign Out |
| Session Management | Create, Rename, Delete, Switch sessions |
| LLM Interaction | Send natural language message, Create/alter table, Insert data, Seed data, Analyze data |
| Data Import | Upload CSV, Preview schema suggestion, Confirm import |
| Canvas Visualization | View tables, drag/reposition cards, view analytics cards |

These map **naturally** onto 2TUP's functional branch: well-defined actors, clear use cases, a stable domain model (User → Session → Message → Table).

### Technical Branch → Morph's Architecture

Morph has **strong technical constraints** that justify a dedicated technical branch:

| Constraint | Detail |
|---|---|
| LLM Integration | Claude API (Anthropic) called with structured prompts and session context |
| Dynamic SQL Execution | Raw PostgreSQL queries generated at runtime — no ORM, no migration files |
| Real-time UI | Next.js App Router with client components, canvas drag-and-drop |
| Authentication | JWT stored in httpOnly cookies, bcrypt hashing |
| Session isolation | Tables prefixed `s{id}_tableName` — no cross-session leakage |
| Deployment | Vercel (frontend) + Railway (backend) |

---

## Why 2TUP is a GOOD Choice for Morph

### 1. Clear separation of functional and technical concerns
Morph has a genuine split: the *what* (chat, sessions, tables) is independent from the *how* (Fastify, Claude API, PostgreSQL, JWT). 2TUP's two-branch structure maps directly onto this split.

### 2. Well-defined use cases → natural use of UML
Morph's features are concrete and bounded. Use case diagrams, sequence diagrams, and class diagrams can be drawn precisely from the actual code — they are not speculative.

### 3. Iterative nature fits a POC context
2TUP is iterative like RUP but lighter. A POC (Proof of Concept) across 3 domains (furniture shop, student dashboard, nutritionist) is exactly the kind of scoped iteration 2TUP handles well.

### 4. Technical architecture is non-trivial
The LLM-to-SQL pipeline, dynamic schema migration, and session-scoped table isolation are genuinely architectural decisions. 2TUP's technical branch forces you to document and justify them — which strengthens the report.

### 5. Standard in French engineering schools
2TUP was popularized in France and is widely used in *mémoires de stage*. Reviewers will be familiar with it.

---

## Why 2TUP is NOT Ideal for Morph

### 1. Designed for teams — Morph is a solo project
2TUP assumes parallel work across functional and technical tracks by different people or sub-teams. For a solo developer, this parallelism is artificial.

### 2. LLM behavior is non-deterministic — hard to pre-model
The core of Morph is an AI that generates SQL dynamically. 2TUP assumes you can model behavior upfront in sequence diagrams. But the exact SQL Claude generates is not predictable — the "sequence" changes every run. This makes precise sequence diagrams partially aspirational rather than descriptive.

### 3. Dynamic schema migration defies traditional class modeling
The "dynamic table" concept (tables created at runtime by the LLM) doesn't fit neatly into a static class diagram. The schema is intentionally *never frozen* — which is the opposite of what class diagrams assume.

### 4. Requirements evolved significantly during development
2TUP works best when requirements are captured once and then refined. Morph's requirements (e.g., adding authentication, adding analytics cards, CSV import) emerged during development. An agile method like Scrum/XP would fit better for this kind of exploratory iteration.

### 5. No explicit guidance for AI/LLM components
2TUP was designed in the pre-LLM era. It has no standard notation or process for modeling prompt engineering, context windows, or non-deterministic AI responses.

---

## Verdict

**2TUP is acceptable and defensible for this report** because:
- The project has clear use cases and a real domain model
- The technical architecture is non-trivial and worth documenting
- 2TUP is expected in French engineering school reports

**The honest limitation to state in your report:** 2TUP was applied *retrospectively* (after development) to document a project that was built more iteratively. The LLM component introduces non-determinism that static UML diagrams can only approximate.

---

## Diagram Files Included

| File | Diagram Type | 2TUP Phase |
|---|---|---|
| `use_case_global.puml` | Use Case Diagram | Phase 1 — Functional Requirements |
| `class_diagram.puml` | Class Diagram | Phase 1 + 5 — Domain Model + Design |
| `sequence_auth.puml` | Sequence Diagram | Phase 3 — Analysis |
| `sequence_chat_create.puml` | Sequence Diagram | Phase 3 — Analysis |
| `sequence_csv_import.puml` | Sequence Diagram | Phase 3 — Analysis |
| `sequence_session.puml` | Sequence Diagram | Phase 3 — Analysis |
| `component_diagram.puml` | Component Diagram | Phase 2 — Technical Requirements |
| `deployment_diagram.puml` | Deployment Diagram | Phase 2 + 4 — Technical + Preliminary Design |
