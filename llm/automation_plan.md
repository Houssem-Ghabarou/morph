# Morph — Automation Engine Plan
> Phase E+ : From Awareness to Action

---

## Vision

Morph already lets users *understand* their data through natural language queries and canvas visualizations.  
The next evolution: the data **acts on behalf of the user**.

A user who tracks clients, orders, inventory, or appointments should be able to say:

> "Email me every Monday with a summary of last week's orders"  
> "Alert me when inventory drops below 20 units"  
> "Send a reminder to clients whose contract expires in 7 days"  
> "Notify me when a new row is added to the leads table"

Morph interprets this, stores the rule, and runs it — forever, without the user doing anything again.

This turns Morph from a passive data canvas into a **living, proactive operating system**.

---

## What Can the System Do With the Data?

### Category 1 — Alerting & Monitoring
| Trigger | Example |
|---|---|
| Threshold crossed | Stock of product X < 10 → email alert |
| Anomaly | Sales today 60% below 30-day average → notify |
| New record | New lead added → notify sales manager |
| Status change | Order status changed to "cancelled" → alert |
| Inactivity | No orders from client X in 30 days → flag |

### Category 2 — Scheduled Reporting
| Schedule | Example |
|---|---|
| Daily digest | Every 8am: summary of yesterday's orders |
| Weekly KPI | Every Monday: top 5 products, revenue, open tickets |
| Monthly report | 1st of each month: full business summary as email |
| End-of-day | 6pm: tasks still open, overdue items |

### Category 3 — Date-Proximity Reminders
| Trigger | Example |
|---|---|
| N days before date column | Contract expires in 7 days → remind user |
| On exact date | Appointment today → send reminder |
| N days after date | Order shipped 5 days ago, no delivery → follow-up |
| Birthday / anniversary | Client birthday this week → prompt action |

### Category 4 — Event-Driven Workflows
| Event | Action Chain |
|---|---|
| New client added | Send welcome email → assign onboarding task |
| Invoice overdue | Wait 3 days → reminder email → wait 7 days → escalation email |
| Project status = "blocked" | Immediate alert to manager |
| Payment received | Update balance → send receipt email |

### Category 5 — Bulk / Batch Actions
| Scenario | Example |
|---|---|
| Campaign blast | Email all clients with status = "active" and city = "Paris" |
| Renewal campaign | All clients whose subscription expires next month |
| Re-engagement | Clients with no purchase in 90 days |
| Announcement | All users → product update email |

### Category 6 — Data Transformation Automation
| Type | Example |
|---|---|
| Auto-compute | When a row is inserted: calculate total = qty * price |
| Auto-tag | LLM classifies new records by content |
| Auto-clean | Normalize phone numbers, trim whitespace, fix casing |
| Auto-archive | Move rows older than 1 year to archive table |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  MORPH AUTOMATION ENGINE                                  │
│                                                           │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────┐ │
│  │  Trigger    │   │   Condition  │   │   Action      │ │
│  │  Evaluator  │──▶│   Checker    │──▶│   Executor    │ │
│  └─────────────┘   └──────────────┘   └───────────────┘ │
│         │                                     │          │
│   ┌─────▼──────┐                    ┌─────────▼──────┐  │
│   │ Cron       │                    │ Email Service  │  │
│   │ Scheduler  │                    │ (Nodemailer /  │  │
│   │ (node-cron)│                    │  Resend)       │  │
│   └────────────┘                    └────────────────┘  │
│                                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  morph_automations  (definitions)                │   │
│  │  morph_automation_runs  (execution log)          │   │
│  │  morph_smtp_settings  (per-user email config)    │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Core Concept: Automation = Trigger + Condition + Action

Every automation definition has three parts:

```
Trigger   → WHEN does it run?
           • schedule (cron: "every Monday 9am")
           • threshold (when column X < value)
           • date_proximity (N days before date column)
           • new_record (row inserted in table)
           • value_change (column changed)

Condition → WHAT data does it act on?
           • A SQL SELECT query (LLM-generated or user-confirmed)
           • Filter expression (e.g., status = 'active')
           • Row count condition (e.g., results.length > 0)

Action    → WHAT does it do?
           • send_email (report, alert, reminder, bulk)
           • send_sms    (future)
           • webhook     (call external URL with data)
           • transform   (modify data in DB)
```

---

## Database Schema

```sql
-- User's email config (SMTP credentials)
CREATE TABLE morph_smtp_settings (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES morph_users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL DEFAULT 'smtp',  -- 'smtp' | 'resend' | 'sendgrid'
  host         TEXT,           -- SMTP host (e.g. smtp.gmail.com)
  port         INTEGER,        -- 587 / 465
  secure       BOOLEAN DEFAULT FALSE,
  smtp_user    TEXT,
  smtp_pass    TEXT,           -- encrypted in production
  from_name    TEXT,
  from_email   TEXT NOT NULL,
  api_key      TEXT,           -- for Resend/SendGrid
  created_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Automation definitions
CREATE TABLE morph_automations (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES morph_users(id) ON DELETE CASCADE,
  session_id     INTEGER REFERENCES morph_sessions(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  enabled        BOOLEAN DEFAULT TRUE,

  -- Trigger
  trigger_type   TEXT NOT NULL,  -- 'schedule' | 'threshold' | 'date_proximity' | 'new_record' | 'value_change'
  trigger_config JSONB NOT NULL, -- type-specific config (see below)

  -- Condition / Data Query
  source_table   TEXT,           -- which table to query
  query_sql      TEXT,           -- SQL to run when triggered (LLM-generated)
  condition_expr TEXT,           -- optional filter: "COUNT > 0", "rows.length > 0"

  -- Action
  action_type    TEXT NOT NULL,  -- 'send_email' | 'webhook' | 'transform'
  action_config  JSONB NOT NULL, -- type-specific config (see below)

  -- Metadata
  last_run_at    TIMESTAMP,
  next_run_at    TIMESTAMP,      -- computed for schedule triggers
  run_count      INTEGER DEFAULT 0,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW()
);

-- Execution log
CREATE TABLE morph_automation_runs (
  id             SERIAL PRIMARY KEY,
  automation_id  INTEGER NOT NULL REFERENCES morph_automations(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,  -- 'success' | 'failed' | 'skipped' | 'no_data'
  trigger_reason TEXT,           -- what caused this run
  rows_affected  INTEGER,        -- how many data rows were found
  action_result  TEXT,           -- e.g. "email sent to 3 recipients"
  error_message  TEXT,
  duration_ms    INTEGER,
  executed_at    TIMESTAMP DEFAULT NOW()
);
```

### trigger_config examples:
```json
// Schedule trigger
{ "cron": "0 9 * * 1", "timezone": "Europe/Paris" }

// Threshold trigger
{ "table": "s5_inventory", "column": "stock", "operator": "<", "value": 10 }

// Date proximity trigger
{ "table": "s5_clients", "column": "contract_end", "days_before": 7 }

// New record trigger
{ "table": "s5_leads" }

// Value change trigger
{ "table": "s5_orders", "column": "status", "watch_value": "cancelled" }
```

### action_config examples:
```json
// Send email report
{
  "to": ["boss@company.com"],
  "subject": "Weekly Orders Summary",
  "template": "report",
  "include_table": true,
  "include_summary": true,   // LLM generates a 2-3 sentence summary
  "max_rows": 50
}

// Send alert email
{
  "to": ["stock@company.com"],
  "subject": "⚠️ Low Stock Alert",
  "template": "alert",
  "message_template": "{{count}} products are below the minimum stock threshold."
}

// Send bulk email (one email per row)
{
  "to_column": "email",         // get recipient from row data
  "subject_template": "Hi {{name}}, your contract expires in 7 days",
  "template": "reminder",
  "personalize": true           // LLM personalizes each email
}

// Webhook
{
  "url": "https://hooks.slack.com/...",
  "method": "POST",
  "body_template": { "text": "New lead: {{name}} from {{company}}" }
}
```

---

## Email Service Design

### Provider Support
```
Priority 1: Resend (https://resend.com) — best DX, free tier 3k/month
Priority 2: SMTP (Gmail, Outlook, custom) — user brings own
Priority 3: SendGrid — enterprise

The user configures their provider once in Settings → Email.
All automations share that config.
```

### Email Templates
Four base templates, all rendered as clean HTML:

| Template | Use Case | Content |
|---|---|---|
| `report` | Scheduled digests | Header + LLM summary paragraph + data table |
| `alert` | Threshold / anomaly | Warning banner + trigger context + action items |
| `reminder` | Date proximity | Friendly reminder + relevant record details |
| `notification` | Event-driven | Brief what happened + link to Morph session |

### LLM Role in Email Generation
The LLM does **two things** in every email:
1. **Summarize** the query results into 2-3 human sentences ("This week you had 34 orders, up 12% from last week. Your top product was...")
2. **Suggest next actions** ("Consider restocking Oak inventory which is at 8 units, below your 20-unit threshold.")

---

## New API Routes

```
# SMTP Settings
GET    /api/email/settings          — get user's SMTP config (passwords masked)
POST   /api/email/settings          — save / update SMTP config
POST   /api/email/test              — send a test email to verify config

# Automations CRUD
GET    /api/automations?sessionId=X — list automations for session
POST   /api/automations             — create automation
GET    /api/automations/:id         — get single automation
PATCH  /api/automations/:id         — update (enable/disable, edit)
DELETE /api/automations/:id         — delete

# Execution
POST   /api/automations/:id/run     — manual trigger (test run)
GET    /api/automations/:id/runs    — execution history
GET    /api/automations/runs/recent — recent runs across all automations

# LLM assist
POST   /api/automations/parse       — parse natural language → automation definition
                                       input: "email me every Monday with orders summary"
                                       output: { trigger_config, query_sql, action_config, name }
```

---

## Natural Language Interface

The most important design decision: **users never fill forms manually**.

Flow:
1. User opens Automation panel and types:  
   `"Send me an email every Monday morning with a summary of last week's sales"`

2. LLM parses the intent → returns a structured preview:
```json
{
  "name": "Weekly Sales Report",
  "trigger": "Every Monday at 9:00",
  "query": "SELECT * FROM orders WHERE created_at >= NOW() - INTERVAL '7 days'",
  "action": "Email to you with LLM summary + table",
  "confidence": "high"
}
```

3. User sees the preview, can edit any field, then clicks "Activate"

4. Automation is stored and scheduled immediately.

### LLM Parse Prompt Design
The system sends the LLM:
- The user's natural language input
- The session's current table schemas (so it can generate correct SQL)
- The available trigger types and action types
- Examples of automation definitions

Output: a valid JSON automation definition ready to store.

---

## Execution Engine

### Scheduler (node-cron)
```
On server start:
  → Load all enabled automations with trigger_type = 'schedule'
  → For each: register a cron job based on trigger_config.cron
  → When cron fires: run the automation pipeline

When automation is created/updated/deleted:
  → Hot-reload the scheduler (no restart needed)
```

### Automation Pipeline (per run)
```
1. Load automation definition
2. Evaluate trigger condition (threshold check, date check, etc.)
3. If condition not met → log as 'skipped', stop
4. Execute query_sql against the session's tables
5. If no results and condition requires data → log as 'no_data', stop
6. Feed results to LLM → generate email content
7. Send email via configured provider
8. Log result in morph_automation_runs
9. Update automation.last_run_at, run_count
```

### Threshold & Date Checker (runs every 5 minutes)
```
Separate cron job: */5 * * * *
  → Load all enabled automations with trigger_type IN ('threshold', 'date_proximity', 'new_record', 'value_change')
  → For each: evaluate condition
  → If triggered AND (last_run_at is null OR last_run_at < threshold_cooldown):
      run the automation pipeline
      apply cooldown (e.g., don't re-fire threshold alert for 24h)
```

---

## Frontend Components Needed

### 1. AutomationPanel (side panel)
- Accessed from canvas toolbar "Automate" button
- List of all automations for the session (enabled/disabled toggle)
- "New Automation" button → opens AutomationBuilder

### 2. AutomationBuilder (modal)
```
Step 1: Natural language input
  "Describe what you want to automate..."
  [Generate] → shows parsed preview

Step 2: Review & adjust
  Trigger:  [Every Monday at 9am        ▼]
  Query:    [SELECT * FROM orders...    ✏]
  Send to:  [you@email.com              ]
  Subject:  [Weekly Orders Summary      ]
  [Test Run] [Activate]

Step 3: Confirmation
  "Automation activated. First run: Monday 09:00"
```

### 3. EmailSettingsModal
- Provider selector: Resend / SMTP / SendGrid
- SMTP fields: host, port, user, password, from_email
- "Send test email" button
- Inline success/error feedback

### 4. AutomationRunLog (inside AutomationPanel)
- Per-automation: last 10 runs with status, timestamp, rows found, action taken
- Global recent runs view

---

## Implementation Phases

### Phase 1 — Email Foundation (2-3 days)
**Goal:** A user can configure email and receive a manual report.

- [ ] `morph_smtp_settings` migration
- [ ] `morph_automations` + `morph_automation_runs` migration
- [ ] `backend/src/lib/emailService.ts` (Nodemailer, Resend support)
- [ ] `backend/src/routes/email.ts` (settings CRUD + test send)
- [ ] `backend/src/lib/emailTemplates.ts` (HTML templates: report, alert, reminder)
- [ ] Manual "Send Report" button on canvas (no automation, just run now)
- [ ] `EmailSettingsModal` frontend component

### Phase 2 — Scheduled Automations (2 days)
**Goal:** A user can create a "send every Monday" automation.

- [ ] `backend/src/lib/automationScheduler.ts` (node-cron wrapper)
- [ ] `backend/src/routes/automations.ts` (full CRUD)
- [ ] `POST /api/automations/parse` (LLM interprets natural language)
- [ ] Scheduler starts with server, hot-reloads on CRUD
- [ ] `AutomationPanel` + `AutomationBuilder` frontend

### Phase 3 — Threshold & Date Triggers (2 days)
**Goal:** "Alert me when stock < 10" and "remind me 7 days before contract end"

- [ ] Threshold evaluator in scheduler
- [ ] Date proximity evaluator
- [ ] Cooldown system (prevent re-fire spam)
- [ ] Run log with history view
- [ ] Threshold trigger UI in AutomationBuilder

### Phase 4 — Event-Driven Triggers (2 days)
**Goal:** "Notify me when a new lead is added"

- [ ] Hook into data insertion route (after INSERT → check new_record triggers)
- [ ] Hook into data update route (after PATCH → check value_change triggers)
- [ ] Async fire (don't block the insert response)
- [ ] Event triggers UI

### Phase 5 — Bulk & Personalized Emails (2 days)
**Goal:** "Email all clients whose contract expires next month"

- [ ] Per-row email generation (one email per result row)
- [ ] LLM personalizes each email using row data
- [ ] Rate limiting (max N emails per run to avoid spam)
- [ ] Preview mode (see 3 sample emails before sending all)
- [ ] Unsubscribe tracking (morph_email_unsubscribes table)

### Phase 6 — SMS & Webhooks (future)
- [ ] Twilio integration for SMS
- [ ] Webhook actions (POST data to external URL)
- [ ] Slack / Discord message actions
- [ ] WhatsApp Business API

---

## New Packages Required

```json
// Backend
"node-cron": "^3.0.0",           // cron scheduling
"@types/node-cron": "^3.0.0",
"nodemailer": "^6.9.0",          // SMTP email sending
"@types/nodemailer": "^6.4.0",
"resend": "^3.0.0",              // Resend API (better deliverability)
"handlebars": "^4.7.0",          // HTML email templating
"@types/handlebars": "^4.1.0"
```

---

## Key Design Decisions

### 1. No background worker process — embedded in Fastify
Keep it simple: cron jobs run inside the same Node process. For a project at this scale, a separate worker is over-engineering. Use `setInterval` + `node-cron` directly.

### 2. Session-scoped automations
Each automation belongs to a session (and thus a user). Queries reference session-prefixed table names (`s{sessionId}_table`). This keeps data isolation clean.

### 3. LLM generates all SQL for automations
The user never writes SQL. The LLM generates `query_sql` when the automation is created, using the session schema as context — same pattern as the existing chat flow.

### 4. Email credentials stored per user
Each user configures their own SMTP/API key. No shared infrastructure. Simple and privacy-preserving for a multi-tenant setup.

### 5. Cooldown on threshold/event triggers
Without cooldown, a stock alert fires every 5 minutes for as long as stock is low. Default cooldown: 24h for threshold, 1h for events. Configurable per automation.

### 6. Audit-first logging
Every automation run is logged regardless of outcome (success, skipped, no_data, failed). This gives users full visibility into what the system did and why.

---

## Security Considerations

- SMTP passwords: encrypt at rest using AES-256 or store via env-configured secret key
- Recipient validation: only allow emails from verified domains or explicit user confirmation
- SQL injection: automation `query_sql` is LLM-generated against known session tables — but still sanitize table name references
- Rate limiting: max 100 emails/day per user (prevent abuse)
- Unsubscribe handling: every bulk email must include an unsubscribe link

---

## Example: Full Lifecycle of One Automation

```
User types: "Every morning at 8am, email me if any orders are still pending"

1. LLM parses →
   name:         "Daily Pending Orders Alert"
   trigger:      cron "0 8 * * *"
   query_sql:    SELECT * FROM s12_orders WHERE status = 'pending'
   condition:    rows.length > 0           ← only fire if there ARE pending orders
   action:       send_email
   to:           [user's email from profile]
   subject:      "⚠️ You have {{count}} pending orders"
   template:     alert

2. User sees preview → clicks "Activate"

3. Server registers cron job at "0 8 * * *"

4. Next morning at 08:00:
   → Cron fires
   → SELECT * FROM s12_orders WHERE status = 'pending' → 3 rows
   → condition: 3 > 0 → proceed
   → LLM generates: "Good morning. You currently have 3 pending orders totalling €420.
      The oldest is from March 20 (Martin - oak table). Consider following up today."
   → Email sent to user@email.com
   → Run logged: status=success, rows_affected=3, duration=1.2s

5. If no pending orders → run logged: status=no_data, no email sent
```

---

## What This Unlocks for Morph

With the automation engine in place, Morph becomes:

| Before | After |
|---|---|
| User asks questions manually | System proactively surfaces answers |
| User checks dashboards daily | Dashboards email themselves |
| User remembers to follow up | System sends follow-ups automatically |
| Data sits static in tables | Data triggers real-world actions |
| Reactive tool | Proactive operating system |

This is the difference between a spreadsheet and a business system.

---

*Written: 2026-05-07*  
*Author: Claude (planning assistant)*  
*Status: PLAN — pending review and implementation approval*
