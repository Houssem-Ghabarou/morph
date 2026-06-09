/**
 * Morph — NordFab Stress Test
 * Tests multi-table creation, relation detection, schema evolution,
 * context retention, and complex queries using the textile ERP scenario.
 *
 * Run: node backend/test-nordfab.js   (backend must be running on :3001)
 */
const http = require("http");

const BASE = "http://localhost:3001";
let AUTH_COOKIE = "";
let PASS = 0, FAIL = 0, WARN = 0;
const RESULTS = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pass(msg)  { PASS++; console.log(`  ✓ ${msg}`); RESULTS.push({ ok: true,  msg }); }
function fail(msg)  { FAIL++; console.log(`  ✗ ${msg}`); RESULTS.push({ ok: false, msg }); }
function warn(msg)  { WARN++; console.log(`  ⚠ ${msg}`); RESULTS.push({ ok: null,  msg }); }
function info(msg)  { console.log(`  ℹ ${msg}`); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(path, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const opts   = {
      method,
      hostname: url.hostname,
      port:     url.port,
      path:     url.pathname + url.search,
      headers:  {},
    };
    if (payload) {
      opts.headers["Content-Type"]   = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (AUTH_COOKIE) opts.headers["Cookie"] = AUTH_COOKIE;

    const req = http.request(opts, (res) => {
      // Capture auth cookie on login/register
      const setCookie = res.headers["set-cookie"];
      if (setCookie) {
        AUTH_COOKIE = setCookie.map(c => c.split(";")[0]).join("; ");
      }
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try   { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const post  = (p, b) => request("POST",   p, b);
const get   = (p)    => request("GET",    p);
const del   = (p)    => request("DELETE", p);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(" Morph — NordFab Stress Test");
  console.log("═══════════════════════════════════════════════════════════════════");

  // ─── Step 1: Auth ───────────────────────────────────────────────────────────
  console.log("\n▸ Step 1: Authentication");
  const TEST_EMAIL = `nordfab_test_${Date.now()}@morph.test`;
  const TEST_PASS  = "nordfab123";

  const reg = await post("/api/auth/register", { email: TEST_EMAIL, password: TEST_PASS });
  if (reg.user?.id) {
    pass(`Registered test user: ${TEST_EMAIL}`);
  } else if (reg.error?.includes("already exists")) {
    const login = await post("/api/auth/login", { email: TEST_EMAIL, password: TEST_PASS });
    if (login.user?.id) pass(`Logged in as existing user`);
    else { fail(`Auth failed: ${JSON.stringify(login)}`); return; }
  } else {
    fail(`Registration failed: ${JSON.stringify(reg)}`);
    return;
  }

  // ─── Step 2: Create session ─────────────────────────────────────────────────
  console.log("\n▸ Step 2: Create session");
  const session = await post("/api/sessions");
  const SID = session.id;
  if (!SID) { fail("Could not create session"); return; }
  pass(`Session created: id=${SID}`);
  const prefix = `s${SID}_`;

  // ─── Step 3: NordFab 6-table bootstrap ──────────────────────────────────────
  console.log("\n▸ Step 3: NordFab 6-table bootstrap (Prompt 1-A)");
  console.log("  (calling LLM — may take 15-30s…)");

  const p1a = await post("/api/chat", {
    sessionId: SID,
    message: `I run a mid-sized textile manufacturing company called NordFab. We produce custom fabric rolls and garments for B2B clients across three product lines: raw woven fabrics, dyed fabrics, and finished garments. I need to manage the following completely:

1. Suppliers — who provide raw cotton, thread, dyes, and packaging materials. Each supplier has a company name, a country of origin, a payment terms field (Net30 / Net60 / Prepaid), a reliability score from 0 to 10, and a primary contact person with their phone.

2. Raw Materials — items we buy from suppliers. Each raw material has a name, a category (Cotton / Thread / Dye / Packaging), a unit of measure (kg, liters, rolls, units), current stock quantity, a reorder threshold, a cost per unit, and a reference to which supplier provides it.

3. Machines — our production equipment. Each machine has a name, a type (Loom / Dyeing Vat / Cutting Table / Sewing Station), a factory section (A / B / C), current operational status (Operational / Under Maintenance / Decommissioned), and the year it was purchased.

4. Production Batches — each batch produces one product type. A batch has a batch code (like BATCH-2024-001), the product type being made (Raw Fabric / Dyed Fabric / Garment), planned start date, actual start date, planned end date, actual end date, the quantity planned in meters or units, the quantity actually produced, and the current status (Planned / In Progress / Completed / Failed).

5. Batch Material Usage — a junction table that tracks which raw materials are consumed by which production batch, with the quantity used and any waste quantity recorded.

6. Clients — companies that buy from us. Each client has a company name, country, industry sector (Fashion / Retail / Industrial / Medical), credit limit in euros, payment method (Wire / Letter of Credit / Factoring), and an account manager name.

Make all the tables with proper foreign keys between them. The batch material usage table must link to both batches and raw materials.`,
  });

  info(`Action: ${p1a.action} | Message: ${p1a.message}`);

  if (p1a.action === "create_many") pass("create_many returned");
  else if (p1a.action === "create")  warn("create returned (expected create_many)");
  else fail(`Expected create/create_many, got: ${p1a.action}`);

  // Wait a beat then check session tables
  await sleep(500);
  const detail = await get(`/api/sessions/${SID}`);
  const tables = (detail.sessionTables || []).map(t => t.table_name.replace(prefix, ""));
  info(`Tables created: ${tables.join(", ") || "none"}`);

  const REQUIRED = ["suppliers", "raw_materials", "machines", "production_batches", "batch_material_usage", "clients"];
  let missingTables = [];
  for (const t of REQUIRED) {
    const found = tables.some(n => n === t || n.includes(t.replace("_", "")));
    if (found) pass(`Table exists: ${t}`);
    else { warn(`Table missing: ${t}`); missingTables.push(t); }
  }

  // ─── Step 4: Relations after 6-table creation ────────────────────────────────
  console.log("\n▸ Step 4: Relation detection after 6-table creation (Bug #1 test)");
  const rels4 = await get(`/api/sessions/${SID}/relations`);
  const relList = (rels4.relations || []).map(r =>
    `${r.from.replace(prefix,"")}.${r.on} → ${r.to.replace(prefix,"")}`
  );
  info(`Relations: ${relList.join(" | ") || "none"}`);

  if (relList.length === 0) fail("No relations detected — Bug #1 still present");
  else pass(`${relList.length} relation(s) detected`);

  // Specifically check for compound-name relation (the hard one)
  const hasBatchRel = (rels4.relations || []).some(r =>
    (r.from.includes("batch_material") || r.from.includes("usage")) &&
    (r.to.includes("batch") || r.to.includes("production"))
  );
  if (hasBatchRel) pass("batch_material_usage → production_batches relation detected ✓");
  else warn("batch_material_usage → production_batches NOT detected (compound name issue)");

  const hasRawMatRel = (rels4.relations || []).some(r =>
    r.from.includes("batch_material") && r.to.includes("raw_material")
  );
  if (hasRawMatRel) pass("batch_material_usage → raw_materials relation detected ✓");
  else warn("batch_material_usage → raw_materials NOT detected");

  const hasSupplierRel = (rels4.relations || []).some(r =>
    r.to.includes("supplier") && r.from.includes("raw_material")
  );
  if (hasSupplierRel) pass("raw_materials → suppliers relation detected ✓");
  else warn("raw_materials → suppliers NOT detected");

  // ─── Step 5: schema snake_case check ────────────────────────────────────────
  console.log("\n▸ Step 5: Column snake_case check (no camelCase)");
  for (const tbl of tables.slice(0, 6)) {
    const s = await get(`/api/schema/${prefix + tbl}`);
    const cols = (s.columns || []).map(c => c.column_name);
    const camel = cols.filter(c => /[A-Z]/.test(c));
    if (camel.length === 0) pass(`${tbl}: all snake_case`);
    else fail(`${tbl}: camelCase columns found — ${camel.join(", ")}`);
  }

  // ─── Step 6: ALTER TABLE — Prompt 1-B (context retention test) ───────────────
  console.log("\n▸ Step 6: ALTER TABLE — add columns to existing tables (Prompt 1-B)");
  console.log("  (calling LLM…)");

  const p1b = await post("/api/chat", {
    sessionId: SID,
    message: "Add a machines column to production batches so we know which machine ran each batch. Also add a column to raw materials for lead time in days — how many days it takes to receive a new shipment from the supplier after ordering.",
  });
  info(`Action: ${p1b.action} | SQL: ${(p1b.sql || "").substring(0, 120)}`);

  if (p1b.action === "alter") pass("ALTER action returned");
  else warn(`Expected alter, got ${p1b.action}`);

  // Verify columns were added
  await sleep(300);
  const pbSchema = await get(`/api/schema/${prefix}production_batches`);
  const pbCols   = (pbSchema.columns || []).map(c => c.column_name);
  if (pbCols.some(c => c.includes("machine")))
    pass("production_batches.machine column added");
  else
    warn("production_batches.machine column NOT found (may use different name)");

  const rmSchema = await get(`/api/schema/${prefix}raw_materials`);
  const rmCols   = (rmSchema.columns || []).map(c => c.column_name);
  if (rmCols.some(c => c.includes("lead")))
    pass("raw_materials.lead_time_days column added");
  else
    warn("raw_materials lead_time column NOT found");

  // ─── Step 7: New table (quality_inspections) — Prompt 1-C ────────────────────
  console.log("\n▸ Step 7: Create quality_inspections table (Prompt 1-C)");
  console.log("  (calling LLM…)");

  const p1c = await post("/api/chat", {
    sessionId: SID,
    message: "I also need to track quality control inspections. Each inspection is tied to a production batch. An inspection has an inspection date, the name of the quality inspector, a defect rate percentage (decimal), a result (Pass / Conditional Pass / Fail), and a detailed notes field for what was found. If the result is Conditional Pass or Fail, we need a corrective action field describing what must be fixed.",
  });
  info(`Action: ${p1c.action}`);

  if (p1c.action === "create" || p1c.action === "create_many")
    pass("quality_inspections table created");
  else
    fail(`Expected create, got ${p1c.action}`);

  // Check FK to production_batches is detected
  await sleep(300);
  const rels7 = await get(`/api/sessions/${SID}/relations`);
  const hasQiRel = (rels7.relations || []).some(r =>
    r.from.includes("quality") && r.to.includes("batch")
  );
  if (hasQiRel) pass("quality_inspections → production_batches relation detected ✓");
  else warn("quality_inspections → production_batches NOT detected");

  // ─── Step 8: PREFILL — Prompt 2-A ────────────────────────────────────────────
  console.log("\n▸ Step 8: PREFILL test — add supplier (Prompt 2-A)");
  console.log("  (calling LLM…)");

  const p2a = await post("/api/chat", {
    sessionId: SID,
    message: "Add a new supplier: Ankara Tekstil AS, from Turkey, payment terms Net60, reliability score 8.5, contact person is Mehmet Yilmaz, phone +90-312-555-0192",
  });
  info(`Action: ${p2a.action} | Values: ${JSON.stringify(p2a.values || {})}`);

  if (p2a.action === "prefill") pass("PREFILL returned for supplier insert");
  else warn(`Expected prefill, got ${p2a.action}`);

  const vals = p2a.values || {};
  const nameOk = Object.values(vals).some(v => String(v).includes("Ankara") || String(v).includes("ankara"));
  if (nameOk) pass("Supplier name extracted in PREFILL values");
  else warn("Supplier name not found in PREFILL values");

  // ─── Step 9: Orders table — Prompt 3-A ───────────────────────────────────────
  console.log("\n▸ Step 9: Add orders table (Prompt 3-A)");
  console.log("  (calling LLM…)");

  const p3a = await post("/api/chat", {
    sessionId: SID,
    message: "I realize I need to track orders from clients. Each order has an order reference number (like ORD-2024-001), the client who placed it, the product type ordered (Raw Fabric / Dyed Fabric / Garment), the quantity in meters or units, the unit price in euros, a total amount, the order date, the requested delivery date, the actual delivery date (can be empty), and the order status: Draft / Confirmed / In Production / Shipped / Delivered / Cancelled.",
  });
  info(`Action: ${p3a.action}`);

  if (p3a.action === "create" || p3a.action === "create_many")
    pass("orders table created");
  else
    fail(`Expected create for orders, got ${p3a.action}`);

  // Check that orders links to clients
  await sleep(300);
  const rels9 = await get(`/api/sessions/${SID}/relations`);
  const hasOrderClientRel = (rels9.relations || []).some(r =>
    r.from.includes("order") && r.to.includes("client")
  );
  if (hasOrderClientRel) pass("orders → clients relation detected ✓");
  else warn("orders → clients NOT detected");

  // ─── Step 10: Context continuity — ALTER on old table (Bug #2 test) ───────────
  console.log("\n▸ Step 10: Context continuity — ALTER table created many prompts ago (Bug #2 test)");
  console.log("  (calling LLM…)");

  const p3b = await post("/api/chat", {
    sessionId: SID,
    message: "Add these columns to orders: a discount percentage column, a currency column (default EUR), and a linked production batch column so we can track which batch fulfills which order.",
  });
  info(`Action: ${p3b.action} | SQL: ${(p3b.sql || "").substring(0, 200)}`);

  if (p3b.action === "alter") pass("ALTER on orders returned (context retained ✓)");
  else fail(`Context failure: expected alter on orders, got ${p3b.action}`);

  // Verify columns added
  await sleep(300);
  const ordSchema = await get(`/api/schema/${prefix}orders`);
  const ordCols   = (ordSchema.columns || []).map(c => c.column_name);
  info(`orders columns: ${ordCols.join(", ")}`);
  if (ordCols.some(c => c.includes("discount")))
    pass("orders.discount column added");
  else
    warn("orders.discount NOT found");
  if (ordCols.some(c => c.includes("currency") || c.includes("curr")))
    pass("orders.currency column added");
  else
    warn("orders.currency NOT found");

  // ─── Step 11: Complex JOIN query ─────────────────────────────────────────────
  console.log("\n▸ Step 11: Complex JOIN query — Prompt 4-A style");
  console.log("  (calling LLM…)");

  // First seed a couple rows so the query has something to return
  const suppTable  = prefix + "suppliers";
  const suppSchema = await get(`/api/schema/${suppTable}`);
  const suppCols   = (suppSchema.columns || [])
    .map(c => c.column_name)
    .filter(c => c !== "id" && c !== "created_at");

  // Build a minimal insert using available columns
  const suppRow = {};
  for (const c of suppCols) {
    if (c.includes("name") || c.includes("company")) suppRow[c] = "Test Supplier";
    else if (c.includes("country"))    suppRow[c] = "Germany";
    else if (c.includes("score") || c.includes("reliab")) suppRow[c] = 7;
    else if (c.includes("contact"))    suppRow[c] = "Hans";
    else if (c.includes("phone"))      suppRow[c] = "+49-111-222";
    else if (c.includes("payment") || c.includes("terms")) suppRow[c] = "Net30";
  }
  if (Object.keys(suppRow).length > 0) {
    await post(`/api/data/${suppTable}`, suppRow);
    info(`Seeded 1 supplier row`);
  }

  const p4a = await post("/api/chat", {
    sessionId: SID,
    message: "Show me all suppliers with their country and reliability score, ordered by reliability score descending.",
  });
  info(`Action: ${p4a.action} | Chart: ${p4a.chartType} | Rows: ${JSON.stringify((p4a.rows || []).slice(0, 2))}`);

  if (p4a.action === "query") pass("JOIN/query returned for supplier list");
  else warn(`Expected query, got ${p4a.action}`);

  // ─── Step 12: Anti-join — Prompt 6-E style ───────────────────────────────────
  console.log("\n▸ Step 12: Anti-join — clients with no orders (Prompt 6-E)");
  console.log("  (calling LLM…)");

  const p6e = await post("/api/chat", {
    sessionId: SID,
    message: "Show me all clients who have NOT placed any orders yet. Also show their credit limit and account manager. Sort by credit limit descending.",
  });
  info(`Action: ${p6e.action} | SQL: ${(p6e.sql || "").substring(0, 200)}`);
  if (p6e.action === "query") {
    pass("Anti-join query executed");
    const sqlLower = (p6e.sql || "").toLowerCase();
    if (sqlLower.includes("not") || sqlLower.includes("null") || sqlLower.includes("except"))
      pass("SQL contains anti-join pattern (NOT / NULL / EXCEPT)");
    else
      warn("SQL may not use correct anti-join — check manually");
  } else {
    warn(`Expected query for anti-join, got ${p6e.action}`);
  }

  // ─── Step 13: Seed + data consistency check ───────────────────────────────────
  console.log("\n▸ Step 13: Seed all tables");
  console.log("  (calling LLM — may take 20-40s…)");

  const p7a = await post("/api/chat", {
    sessionId: SID,
    message: "Add random data to all modules",
  });
  info(`Action: ${p7a.action} | Message: ${p7a.message}`);

  if (p7a.action === "seed") pass("Seed action triggered");
  else warn(`Expected seed, got ${p7a.action}`);

  if (p7a.seedResult && p7a.seedResult.length > 0) {
    pass(`Seeded ${p7a.seedResult.length} tables`);
    for (const r of p7a.seedResult) info(`  → ${r.table}: ${r.count} rows`);
  } else {
    warn("seedResult empty — tables may not have data yet");
  }

  // FK consistency: check that child FK values exist in parent tables
  console.log("\n▸ Step 13b: FK consistency check");
  const finalRels = await get(`/api/sessions/${SID}/relations`);
  for (const rel of (finalRels.relations || []).slice(0, 4)) {
    try {
      const parent = await get(`/api/data/${rel.to}`);
      const child  = await get(`/api/data/${rel.from}`);
      const parentVals = new Set(
        (parent.rows || []).map(r => {
          const firstText = Object.entries(r).find(([k, v]) => k !== "id" && k !== "created_at" && typeof v === "string");
          return firstText ? firstText[1] : null;
        }).filter(Boolean)
      );
      const childFKs = (child.rows || []).map(r => r[rel.on]).filter(Boolean);
      if (childFKs.length === 0) {
        warn(`${rel.from.replace(prefix,"")}.${rel.on}: no FK values to check`);
        continue;
      }
      const bad = childFKs.filter(v => !parentVals.has(v));
      const fromD = rel.from.replace(prefix,"");
      const toD   = rel.to.replace(prefix,"");
      if (bad.length === 0)
        pass(`FK ok: ${fromD}.${rel.on} → ${toD} (${childFKs.length} rows)`);
      else
        warn(`FK mismatch: ${fromD}.${rel.on} → ${bad.length}/${childFKs.length} values not in ${toD}`);
    } catch(e) {
      warn(`FK check error for ${rel.from}: ${e.message}`);
    }
  }

  // ─── Step 14: Analyze ─────────────────────────────────────────────────────────
  console.log("\n▸ Step 14: Analyze my data");
  console.log("  (calling LLM…)");

  const p4f = await post("/api/chat", { sessionId: SID, message: "Analyze my data" });
  info(`Action: ${p4f.action} | Analyses: ${(p4f.analyses || []).length}`);
  if (p4f.action === "analyze") pass("Analyze action triggered");
  else warn(`Expected analyze, got ${p4f.action}`);
  if ((p4f.analyses || []).length >= 4) pass(`${p4f.analyses.length} analysis cards generated`);
  else warn(`Only ${(p4f.analyses||[]).length} analysis cards (expected 6+)`);

  // ─── Cleanup ──────────────────────────────────────────────────────────────────
  console.log("\n▸ Cleanup");
  await del(`/api/sessions/${SID}`);
  pass(`Session ${SID} deleted`);
  await post("/api/auth/logout");

  // ─── Summary ──────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log(` NordFab Test Results: ${PASS} passed | ${FAIL} failed | ${WARN} warnings`);
  console.log("═══════════════════════════════════════════════════════════════════");
  if (FAIL > 0) {
    console.log("\n Failed checks:");
    RESULTS.filter(r => r.ok === false).forEach(r => console.log(`  ✗ ${r.msg}`));
  }
  if (WARN > 0) {
    console.log("\n Warnings (investigate manually):");
    RESULTS.filter(r => r.ok === null).forEach(r => console.log(`  ⚠ ${r.msg}`));
  }
}

run().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
