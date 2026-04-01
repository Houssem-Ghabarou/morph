# Morph — Full Working Example
> Scenario: **Gym Coach & Nutritionist**
> Run these prompts in order in a single fresh session.

---

## Step 1 — Build the full data model (1 prompt)

```
I'm a gym coach and nutritionist. I need to track my clients, their meals with calories, and their training programs with exercises.
```

**What happens:**
- Creates 3 linked tables: `clients`, `meals`, `training_programs`
- `meals` gets a `client TEXT` column linked to clients
- `training_programs` gets a `client TEXT` column linked to clients
- FK arrows appear on canvas between all 3 cards
- Relations toggle appears top-right

---

## Step 2 — Add clients (real names, use the slide panel)

```
New client: Houssem, 28 years old, 82kg, 178cm, goal is fat loss
```
```
New client: Sara, 24 years old, 61kg, 165cm, goal is muscle gain
```
```
New client: Karim, 35 years old, 95kg, 180cm, goal is endurance
```

**What happens:**
- Slide panel opens pre-filled with extracted values
- Confirm each one — rows appear in the clients card

---

## Step 3 — Log meals (tricky: lowercase names should still work)

```
Log lunch for houssem: grilled chicken with rice, 650 calories
```
```
Log breakfast for sara: oats with banana and protein shake, 480 calories
```
```
Log dinner for KARIM: pasta carbonara, 920 calories
```
```
Log snack for houssem: almonds and an apple, 310 calories
```

**What to check:**
- `houssem` (lowercase) and `KARIM` (uppercase) both find the right client — ILIKE matching
- Slide panel shows client dropdown populated with Houssem, Sara, Karim
- Total 2 meals for Houssem, 1 for Sara, 1 for Karim

---

## Step 4 — Add training programs

```
Add training program for Houssem: Fat Burn HIIT, 3 sessions per week, starts today, 8 weeks duration
```
```
Add program for Sara: Hypertrophy Split, 4 sessions per week, starts today, 12 weeks
```
```
Add program for Karim: Marathon Prep, 5 sessions per week, starts today, 16 weeks
```

**What to check:**
- Client dropdown in slide panel shows all 3 clients
- Each program links back to the right client

---

## Step 5 — Stat queries (should return KPI cards)

```
What is the total calories logged today?
```
```
How many clients do I have?
```
```
What is the average weight of my clients?
```

**What happens:** Single-number stat cards appear on canvas (violet accent, large number)

---

## Step 6 — Bar chart queries

```
Show me total calories per client
```
```
How many meals per client?
```
```
Show sessions per week by program
```

**What happens:** Bar chart cards appear — violet bars, labels below, values above

---

## Step 7 — Insight questions (tricky — LLM interprets the data)

```
Is houssem eating healthy?
```
**Expected:** LLM sees 650 + 310 = 960 cal total, says something like "Houssem consumed 960 calories across 2 meals. For a fat loss goal this could be too low — a typical deficit is around 1500-1800 kcal."

```
Which client has the highest calorie intake?
```
**Expected:** Karim (920 cal from pasta carbonara)

```
Who is training the most sessions per week?
```
**Expected:** Karim (5 sessions — marathon prep)

```
Is Sara on track for muscle gain based on her nutrition?
```
**Expected:** LLM sees 480 cal breakfast, notes it's too low for hypertrophy goals, suggests she needs more protein/calories

```
Compare houssem and karim calorie intake
```
**Expected:** Returns a table or bar comparing both — Houssem 960 cal vs Karim 920 cal

---

## Step 8 — Cross-table query (JOIN)

```
Show me each client with their total calories and their training program
```
**Expected:** Table card with columns: client name, total calories, program name — requires a JOIN across 3 tables

```
Which clients have a training program but no meals logged?
```
**Expected:** If Sara has no second meal, system finds the gap

---

## Step 9 — Schema evolution (ALTER)

```
Add a notes column to the clients table
```
**What happens:** `clients` card refreshes immediately showing the new column — no page reload needed

```
Add a meal_time column to meals (breakfast, lunch, dinner, snack)
```

---

## Step 10 — Add a new linked table mid-session

```
I also want to track weekly weight measurements for each client
```
**Expected:**
- Creates `weight_measurements` table with `client TEXT`, `weight NUMERIC`, `date DATE`, `notes TEXT`
- FK arrow appears connecting it to `clients`
- Client dropdown in the insert form shows existing clients

Add measurements:
```
Log weight for Houssem: 81.2kg this week
```
```
Log weight for Sara: 60.5kg this week
```
```
Log weight for Karim: 94.1kg this week
```

---

## Step 11 — Add a second-level linked table (relation to a relation)

This tests whether the system remembers existing relations when adding a new table days later.

```
I want to log individual workout sessions for each training program — track the date, exercises done, and duration in minutes
```

**Expected:**
- System sees existing relations: `meals.client → clients`, `training_programs.client → clients`, `weight_measurements.client → clients`
- Creates `workout_sessions` with `training_program TEXT`, `date DATE`, `exercises TEXT`, `duration_minutes INTEGER`
- FK arrow appears from `workout_sessions` → `training_programs`
- Training program dropdown in insert form shows Fat Burn HIIT, Hypertrophy Split, Marathon Prep

Add sessions:
```
Log a workout session for Fat Burn HIIT: ran intervals and jump rope, 45 minutes, today
```
```
Log a session for Hypertrophy Split: chest and triceps, 60 minutes, today
```

**What to check:**
- `training_program` dropdown is pre-populated from existing `training_programs` rows
- Two FK arrows on canvas: `workout_sessions → training_programs` and `training_programs → clients`

---

## Step 12 — Cross-relation insight queries

```
How many workout sessions has each training program logged?
```
**Expected:** Bar chart — Fat Burn HIIT: 1, Hypertrophy Split: 1

```
Which client is working out the most based on session duration?
```
**Expected:** LLM joins workout_sessions → training_programs → client name, returns Hypertrophy Split (Sara, 60 min) or Fat Burn HIIT (Houssem, 45 min)

```
Show me Houssem's weight trend
```
**Expected:** Table or stat with his weight_measurements rows

```
Is Karim losing weight?
```
**Expected:** LLM looks at weight_measurements for Karim, gives assessment based on single or multiple readings

---

## Tricky edge cases to test

| Prompt | Expected behaviour |
|---|---|
| `houssem` (lowercase) in any query | ILIKE matching — works |
| `SARA` (all caps) | works |
| `total calories of houssem` | Stat card + LLM interpretation |
| `show me all meals` | Table result card |
| `delete houssem` | LLM should generate SELECT or say it can't — no DELETE allowed |
| `what tables do i have?` | LLM lists them from session context |
| `add a program details table for each program` | Creates `program_details` with `training_program TEXT` linked to `training_programs` |
| Coming back after days and adding `workout_sessions` | LLM sees existing relations in context, links correctly to `training_programs` |

---

## What the canvas should look like after all steps

```
[clients]──────────────[meals]
    │
    └──────────────[training_programs]──────[workout_sessions]
    │
    └──────────────[weight_measurements]
```

- 5 TableCards on canvas, all draggable
- Dashed violet FK arrows between them
- "Relations on" toggle button top-right
- Stat cards, bar charts, result tables scattered on canvas from queries
- Hover any arrow → tooltip: "Each meal is linked to a client via 'client'."

---

## Common failure modes and what they mean

| Error | Cause | Fix |
|---|---|---|
| "I couldn't apply that change" | LLM generated bad SQL | Rephrase more explicitly, use snake_case names |
| Slide panel shows empty dropdown | Table has no rows yet | Add rows to the referenced table first |
| Relations arrows missing | Column name doesn't match table name | Name the column exactly after the table (singular): `client` for `clients` |
| Stat card instead of bar chart | Only 1 row returned | Add more data rows first |
| "Houssem calories not found" | Old session before ILIKE fix | Start a new session |
