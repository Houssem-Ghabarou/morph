# Morph ERP — Hard Stress Test Scenario
# Domain: Textile Manufacturing Company "NordFab"

> Copy each prompt verbatim into the chat panel.  
> Each section builds on the previous — run them in order.  
> Expected behavior is noted after each prompt.

---

## PHASE 1 — Massive Multi-Table Bootstrap (One Prompt)

**Goal:** Force Morph to create 6 interconnected tables in a single message with complex relationships and edge-case column names.

---

### Prompt 1-A
```
I run a mid-sized textile manufacturing company called NordFab. We produce custom fabric rolls and garments for B2B clients across three product lines: raw woven fabrics, dyed fabrics, and finished garments. I need to manage the following completely:

1. Suppliers — who provide raw cotton, thread, dyes, and packaging materials. Each supplier has a company name, a country of origin, a payment terms field (Net30 / Net60 / Prepaid), a reliability score from 0 to 10, and a primary contact person with their phone.

2. Raw Materials — items we buy from suppliers. Each raw material has a name, a category (Cotton / Thread / Dye / Packaging), a unit of measure (kg, liters, rolls, units), current stock quantity, a reorder threshold, a cost per unit, and a reference to which supplier provides it.

3. Machines — our production equipment. Each machine has a name, a type (Loom / Dyeing Vat / Cutting Table / Sewing Station), a factory section (A / B / C), current operational status (Operational / Under Maintenance / Decommissioned), and the year it was purchased.

4. Production Batches — each batch produces one product type. A batch has a batch code (like BATCH-2024-001), the product type being made (Raw Fabric / Dyed Fabric / Garment), planned start date, actual start date, planned end date, actual end date, the quantity planned in meters or units, the quantity actually produced, and the current status (Planned / In Progress / Completed / Failed).

5. Batch Material Usage — a junction table that tracks which raw materials are consumed by which production batch, with the quantity used and any waste quantity recorded.

6. Clients — companies that buy from us. Each client has a company name, country, industry sector (Fashion / Retail / Industrial / Medical), credit limit in euros, payment method (Wire / Letter of Credit / Factoring), and an account manager name.

Make all the tables with proper foreign keys between them. The batch material usage table must link to both batches and raw materials.
```

**Expected:** 6 tables created, FK arrows between them on canvas. Check that `batch_material_usage` has both `batch_id` (or similar) and `raw_material` FK columns. Verify no camelCase in column names.

---

### Prompt 1-B (Immediate Follow-up)
```
Add a machines column to production batches so we know which machine ran each batch. Also add a column to raw materials for lead time in days — how many days it takes to receive a new shipment from the supplier after ordering.
```

**Expected:** Two `ALTER TABLE` statements. `production_batches` gets a `machine` column. `raw_materials` gets `lead_time_days INTEGER`.

---

### Prompt 1-C
```
I also need to track quality control inspections. Each inspection is tied to a production batch. An inspection has an inspection date, the name of the quality inspector, a defect rate percentage (decimal), a result (Pass / Conditional Pass / Fail), and a detailed notes field for what was found. If the result is Conditional Pass or Fail, we need a corrective action field describing what must be fixed.
```

**Expected:** New `quality_inspections` table with FK to `production_batches`. 7 columns including `corrective_action`.

---

## PHASE 2 — Data Entry (Prefill Form Testing)

**Goal:** Test PREFILL mode, ILIKE matching, dropdown population from FK columns.

---

### Prompt 2-A
```
Add a new supplier: Ankara Tekstil AS, from Turkey, payment terms Net60, reliability score 8.5, contact person is Mehmet Yilmaz, phone +90-312-555-0192
```

**Expected:** PREFILL form appears with all fields pre-filled. Confirm → row inserted into `suppliers`.

---

### Prompt 2-B
```
Add 3 raw materials from Ankara Tekstil AS:
- Egyptian Cotton Blend, category Cotton, unit kg, stock 4500, reorder threshold 800, cost 3.20 per kg, lead time 21 days
- Polyester Thread 40s, category Thread, unit rolls, stock 1200, reorder threshold 200, cost 0.85 per roll, lead time 14 days
- Black Reactive Dye B200, category Dye, unit liters, stock 340, reorder threshold 60, cost 12.40 per liter, lead time 30 days
```

**Expected:** 3 PREFILL forms in sequence (or 3 INSERT statements). The `supplier` column dropdown should show "Ankara Tekstil AS". Verify ILIKE matching works for the supplier field.

---

### Prompt 2-C
```
Register a new machine: Dornier Rapier Loom Model P2, type Loom, factory section A, status Operational, purchased in 2019
```

**Expected:** PREFILL form for `machines`.

---

### Prompt 2-D
```
Create a production batch: batch code BATCH-2024-037, producing Raw Fabric, planned start 2024-11-01, planned end 2024-11-15, planned quantity 8000 meters, status In Progress. It's running on the Dornier Rapier Loom.
```

**Expected:** PREFILL for `production_batches`. The `machine` dropdown should list "Dornier Rapier Loom Model P2". Verify ILIKE matching on the machine name even if user typed "dornier rapier loom".

---

### Prompt 2-E
```
Log material usage for batch BATCH-2024-037: 1200 kg of egyptian cotton blend used, 45 kg waste. Also 80 rolls of polyester thread used, 3 rolls waste.
```

**Expected:** 2 rows inserted into `batch_material_usage`. Both FKs (batch + raw material) resolved via ILIKE. Waste quantities recorded correctly.

---

### Prompt 2-F
```
Add a client: Maison Delacroix SAS, France, industry Fashion, credit limit 250000 euros, payment method Letter of Credit, account manager is Sophie Renard
```

**Expected:** PREFILL form. Confirm → row inserted.

---

## PHASE 3 — Schema Evolution Under Pressure

**Goal:** Force repeated ALTER TABLE calls that test schema flexibility.

---

### Prompt 3-A
```
I realize I need to track orders from clients. Each order has an order reference number (like ORD-2024-001), the client who placed it, the product type ordered (Raw Fabric / Dyed Fabric / Garment), the quantity in meters or units, the unit price in euros, a total amount, the order date, the requested delivery date, the actual delivery date (can be empty), and the order status: Draft / Confirmed / In Production / Shipped / Delivered / Cancelled.
```

**Expected:** New `orders` table with FK to `clients`. 11 columns. Status as TEXT with values noted.

---

### Prompt 3-B
```
Add these columns to orders: a discount percentage column, a currency column (default EUR), and a linked production batch column so we can track which batch fulfills which order.
```

**Expected:** `ALTER TABLE orders` three times (or one statement adding 3 columns).

---

### Prompt 3-C
```
I need to track invoices separately from orders. An invoice has an invoice number, the order it relates to, the invoice date, payment due date, amount before tax, VAT rate, amount after tax, payment status (Unpaid / Partial / Paid / Overdue), and any payment notes. Also add a column to clients for their VAT number.
```

**Expected:** New `invoices` table (FK to `orders`). Plus `ALTER TABLE clients ADD COLUMN vat_number TEXT`.

---

### Prompt 3-D
```
We do machine maintenance. Add a maintenance_logs table: each log has the machine it refers to, the type of maintenance (Preventive / Corrective / Emergency), the maintenance date, the technician name, hours spent, parts replaced (text description), downtime in hours, and whether it was internal staff or external contractor. Also add a last_maintenance_date column to the machines table.
```

**Expected:** New `maintenance_logs` table + `ALTER TABLE machines ADD COLUMN last_maintenance_date DATE`.

---

## PHASE 4 — Complex Analytics & Queries

**Goal:** Test multi-table JOINs, aggregations, business intelligence queries.

---

### Prompt 4-A
```
Show me all production batches that are currently In Progress, along with the machine they're running on and how many days they've been running since the actual start date.
```

**Expected:** SQL with JOIN between `production_batches` and `machines`, filter on `status = 'In Progress'`, date arithmetic (`NOW() - actual_start_date`).

---

### Prompt 4-B
```
What is the total material cost consumed per production batch? Show batch code, product type, and total cost. Sort by highest cost first.
```

**Expected:** JOIN between `batch_material_usage`, `production_batches`, and `raw_materials`. Multiply `quantity_used × cost_per_unit`, GROUP BY batch.

---

### Prompt 4-C
```
Give me a supplier reliability report: for each supplier, show their name, country, reliability score, how many different raw materials they supply, total current stock value of their materials (quantity × cost per unit), and the average lead time of their materials.
```

**Expected:** Complex JOIN `suppliers → raw_materials`, GROUP BY supplier, multiple aggregates: COUNT, SUM(stock * cost), AVG(lead_time_days).

---

### Prompt 4-D
```
Which machines have had more than one maintenance event in the last 6 months? Show the machine name, section, total downtime hours accumulated, and the most recent maintenance date.
```

**Expected:** JOIN `machines → maintenance_logs`, filter by date `> NOW() - INTERVAL '6 months'`, GROUP BY machine, HAVING COUNT > 1.

---

### Prompt 4-E
```
Show me the order fulfillment pipeline: list all orders that are Confirmed or In Production, along with the client name, the linked production batch code and its current status, and whether the batch is on track to meet the delivery deadline (compare batch planned end date with order requested delivery date).
```

**Expected:** Three-way JOIN: `orders → clients`, `orders → production_batches`. Computed column: `CASE WHEN batch.planned_end_date <= order.requested_delivery_date THEN 'On Track' ELSE 'At Risk' END`.

---

### Prompt 4-F
```
Analyze my data
```

**Expected:** 8–10 auto-generated KPI cards covering:
- Total batches by status
- Overall defect rate average
- Top clients by order value
- Revenue by product type
- Material stock below reorder threshold
- Machine utilization by section
- Invoice payment status breakdown
- Average batch completion time

---

## PHASE 5 — Analytical Reasoning (LLM Interpretation)

**Goal:** Test whether Morph's LLM can interpret query results and give business insights.

---

### Prompt 5-A
```
Based on our current raw material stock levels and reorder thresholds, which materials are we at risk of running out of? Give me a risk assessment.
```

**Expected:** Query `WHERE stock_quantity <= reorder_threshold * 1.2` (or similar buffer logic). LLM narrative: "3 materials are at or near reorder threshold…"

---

### Prompt 5-B
```
Is Maison Delacroix a good client for us? Look at their orders, invoices, and payment behavior, and give me a recommendation on whether we should increase their credit limit.
```

**Expected:** Multi-query across `clients`, `orders`, `invoices` filtered by client. LLM synthesizes: order history, invoice payment status, total revenue → recommendation.

---

### Prompt 5-C
```
Our Dornier Rapier Loom keeps needing maintenance. Based on the maintenance logs, is it worth keeping or should we consider replacing it? Factor in downtime costs and the machine's age.
```

**Expected:** Query `maintenance_logs WHERE machine = 'Dornier Rapier Loom...'`. LLM calculates total downtime, total events, machine age (purchased 2019 → 5+ years), and makes a replace/keep recommendation.

---

## PHASE 6 — Edge Cases & Stress Tests

**Goal:** Intentionally break things.

---

### Prompt 6-A (Reserved Word Edge Case)
```
I need to track employee shift orders — each shift order has an order number, the employee it's assigned to, the shift type (Morning / Afternoon / Night), the date, the section they work in, and whether the order was approved by management.
```

**Expected:** Table `shift_orders` created. The column that would be named `order` (reserved word) should become `order_ref` or similar. Verify no SQL syntax error.

---

### Prompt 6-B (Ambiguous Prompt — Forces LLM Reasoning)
```
We have a problem with batch BATCH-2024-037. The quality inspection failed. The defect rate was 4.7%, inspector was Karim Benali, inspection date today, result Fail, notes say: "Uneven weft density in sections 3 and 7, cause suspected to be loom tension miscalibration." Corrective action: recalibrate loom tension settings and re-run a 200m test strip before resuming full production.
```

**Expected:** INSERT into `quality_inspections` with all fields. ILIKE match on batch code "BATCH-2024-037". Long text in `notes` and `corrective_action` fields preserved correctly.

---

### Prompt 6-C (Multi-entity Update via Follow-up)
```
Update batch BATCH-2024-037: the actual end date is today, quantity produced was 7620 meters (below the 8000 planned), and change status to Completed.
```

**Expected:** UPDATE statement on `production_batches` where `batch_code = 'BATCH-2024-037'`. Three field updates in one statement.

---

### Prompt 6-D (Long Paragraph Data Entry)
```
I just got off a call with a new client. Here is everything I know about them: The company is called Vestimenta Group, they're based in Milan, Italy, they work in the Fashion and Retail sector (primarily fashion), their credit limit should be set at 180,000 euros, they always pay by Wire transfer, and the account manager handling them will be Lucas Ferreira. Their VAT number is IT-04923810154. I want to add them to the system right away.
```

**Expected:** PREFILL form extracts all details from the paragraph. VAT number field populated correctly. Country = Italy, sector = Fashion.

---

### Prompt 6-E (Contradictory / Tricky Wording)
```
Show me all clients who have NOT placed any orders yet. Also show their credit limit and account manager. Sort by credit limit descending — these are potential clients we should follow up with.
```

**Expected:** `LEFT JOIN orders ON clients.id = orders.client WHERE orders.id IS NULL` — anti-join pattern. Tests whether LLM correctly handles "who have NOT."

---

### Prompt 6-F (Aggregation with No Data)
```
What is the average defect rate per machine type across all quality inspections?
```

**Expected:** Three-way JOIN: `quality_inspections → production_batches → machines`. GROUP BY `machines.type`. AVG(`defect_rate`). Should handle gracefully even if few rows exist (maybe only 1 inspection inserted so far).

---

### Prompt 6-G (Schema Self-Awareness)
```
How many tables have we created so far? List them with a brief description of what each one tracks.
```

**Expected:** LLM lists all tables from session context (should be ~10 tables at this point: suppliers, raw_materials, machines, production_batches, batch_material_usage, clients, quality_inspections, orders, invoices, maintenance_logs, shift_orders). Each with a one-line description.

---

## PHASE 7 — Seeding & Bulk Data

**Goal:** Test the seed/bulk data generation feature.

---

### Prompt 7-A
```
Seed the database with realistic test data. I want at least 5 suppliers from different countries, 12 raw materials spread across categories, 8 machines in different sections, 10 production batches with varied statuses, corresponding material usage, 6 clients from different countries and industries, 8 orders with different statuses, matching invoices, and at least 15 maintenance logs for the machines. Make the data consistent — foreign keys must reference real inserted rows.
```

**Expected:** This is the hardest seed request. Morph must respect dependency order (suppliers before raw_materials, machines + raw_materials before batches, batches before quality inspections, clients before orders, orders before invoices). Verify no FK violations in inserted data.

---

### Prompt 7-B (Seed Consistency Check)
```
Show me any production batches where the material usage quantity exceeds the planned quantity — that would indicate a data error. Also show batches with no material usage logged at all.
```

**Expected:** Two queries. First: JOIN batches + material_usage, compare. Second: `LEFT JOIN batch_material_usage WHERE batch_material_usage.id IS NULL`. Tests data consistency after seeding.

---

## PHASE 8 — Final Boss Query

**Goal:** Single prompt requiring the most complex query the system can produce.

---

### Prompt 8-A
```
Give me a full production performance dashboard for the last 90 days. I want to see:

1. Each production batch with its batch code, product type, planned vs actual quantity produced, the percentage of plan achieved, the machine it ran on, and the batch duration in days.

2. For each batch, the total raw material cost consumed and the average defect rate from all inspections on that batch.

3. Flag any batch where the defect rate exceeded 3% OR where the quantity achieved was below 90% of planned as "Needs Review".

4. Sort by batch start date descending.
```

**Expected:** This requires:
- `production_batches` as the base
- JOIN `machines` for machine name
- LEFT JOIN `batch_material_usage` + `raw_materials` for material cost (SUM + multiply)
- LEFT JOIN `quality_inspections` for AVG defect rate
- Computed columns: `(actual_qty / planned_qty * 100)` as pct_achieved, `(actual_end - actual_start)` as duration
- CASE WHEN for "Needs Review" flag
- GROUP BY batch (all attributes), filter by date
- ORDER BY start date DESC

This is a 6-table query with multiple aggregations, computed columns, and conditional logic.

---

### Prompt 8-B
```
Based on the dashboard above, write me a short executive summary (3 paragraphs) of NordFab's production performance. Identify the biggest problems and give 2 concrete recommendations.
```

**Expected:** LLM reads query results and generates coherent business narrative. Tests the full AI reasoning loop end-to-end.

---

## CHECKLIST — What to Verify After Running All Prompts

| # | Check |
|---|---|
| 1 | 11+ tables created with correct snake_case column names |
| 2 | FK arrows visible between related tables on canvas |
| 3 | PREFILL forms appeared for all data entry prompts |
| 4 | ILIKE matching resolved lowercase supplier/batch names correctly |
| 5 | No "column does not exist" SQL errors |
| 6 | `batch_material_usage` junction table has both FK columns |
| 7 | `shift_orders` table avoided `order` reserved word conflict |
| 8 | Long text (400+ chars) in `corrective_action` stored without truncation |
| 9 | Seed data respected FK dependency order (no constraint violations) |
| 10 | Anti-join query (clients with no orders) returned correct results |
| 11 | 6-table JOIN in Phase 8-A executed without error |
| 12 | LLM executive summary (Phase 8-B) is coherent and references actual data |
| 13 | Canvas cards draggable and not overlapping after auto-layout |
| 14 | Analytics panel populated after "Analyze my data" prompt |

---

## KNOWN HARD SPOTS (Things Most Likely to Break)

1. **Prompt 1-A** — 6 tables at once may timeout or truncate. Watch for missing tables.
2. **Prompt 2-E** — `batch_material_usage` junction inserts require both FKs resolved via ILIKE. High failure risk.
3. **Prompt 4-E** — Three-way JOIN with computed CASE WHEN. Claude may hallucinate column names.
4. **Prompt 7-A** — Seeding 80+ rows in dependency order. Any FK mismatch crashes bulk insert.
5. **Prompt 8-A** — 6-table aggregation. Most complex query the system should be able to produce.
6. **Prompt 6-E** — Anti-join (NOT IN / LEFT JOIN IS NULL). LLM may generate wrong SQL.
7. **Prompt 5-B** — Business recommendation requires multi-step reasoning across 3 tables for a specific client.
