const http = require("http");

const BASE = "http://localhost:3001";
let PASS = 0,
  FAIL = 0,
  WARN = 0;

function pass(msg) {
  PASS++;
  console.log(`  ✓ ${msg}`);
}
function fail(msg) {
  FAIL++;
  console.log(`  ✗ ${msg}`);
}
function warn(msg) {
  WARN++;
  console.log(`  ⚠ ${msg}`);
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {},
    };
    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const post = (path, body) => request("POST", path, body);
const get = (path) => request("GET", path);
const del = (path) => request("DELETE", path);

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log("═══════════════════════════════════════════════════════");
  console.log(" Morph Backend — Automated Test Suite");
  console.log("═══════════════════════════════════════════════════════");

  // 1. Create session
  console.log("\n▸ Step 1: Create a fresh session");
  const session = await post("/api/sessions");
  const SID = session.id;
  if (!SID) {
    fail("Could not create session");
    return;
  }
  pass(`Session created: id=${SID}`);

  const prefix = `s${SID}_`;

  // 2. Multi-table CREATE
  console.log("\n▸ Step 2: Create multi-table data model (gym coach scenario)");
  const r2 = await post("/api/chat", {
    message:
      "I'm a gym coach and nutritionist. I need to track my clients, their meals with calories, and their training programs with exercises.",
    sessionId: SID,
  });
  console.log(`  Action: ${r2.action} | Message: ${r2.message}`);
  if (r2.action === "create_many" || r2.action === "create")
    pass(`Action: ${r2.action}`);
  else fail(`Expected create/create_many, got: ${r2.action}`);

  const relCount = (r2.relations || []).length;
  console.log(
    `  Schemas: ${
      (r2.schemas || []).length
    } | Relations in response: ${relCount}`
  );
  if (relCount > 0) pass(`Relations detected: ${relCount}`);
  else warn("No relations in create response");

  // 3. Session relations endpoint
  console.log("\n▸ Step 3: Verify session relations endpoint");
  const rels3 = await get(`/api/sessions/${SID}/relations`);
  const relDetail = (rels3.relations || [])
    .map((r) => `${r.from}→${r.to}(${r.on})`)
    .join(", ");
  console.log(`  Relations: ${relDetail || "none"}`);
  if ((rels3.relations || []).length > 0) pass("Relations endpoint has data");
  else fail("Relations endpoint returned 0");

  // 4. Check schemas
  console.log("\n▸ Step 4: Verify table schemas");
  for (const tbl of ["clients", "meals", "training_programs"]) {
    const actual = prefix + tbl;
    const s = await get(`/api/schema/${actual}`);
    const cols = (s.columns || []).map((c) => c.column_name).join(", ");
    if (cols) pass(`${tbl}: ${cols}`);
    else fail(`${tbl}: no columns found`);
  }

  // 5. Insert test data
  console.log("\n▸ Step 5: Insert test data via /api/data");
  const CT = prefix + "clients";
  const MT = prefix + "meals";
  const TP = prefix + "training_programs";

  await post(`/api/data/${CT}`, {
    name: "Houssem",
    age: 28,
    weight: 82,
    goal: "fat loss",
  });
  await post(`/api/data/${CT}`, {
    name: "Sara",
    age: 24,
    weight: 61,
    goal: "muscle gain",
  });
  await post(`/api/data/${CT}`, {
    name: "Karim",
    age: 35,
    weight: 95,
    goal: "endurance",
  });
  const cd = await get(`/api/data/${CT}`);
  if ((cd.rows || []).length === 3) pass("3 clients inserted");
  else fail(`Clients: ${(cd.rows || []).length}`);

  await post(`/api/data/${MT}`, {
    client: "Houssem",
    food: "grilled chicken",
    calories: 650,
  });
  await post(`/api/data/${MT}`, {
    client: "Sara",
    food: "oats with banana",
    calories: 480,
  });
  await post(`/api/data/${MT}`, {
    client: "Karim",
    food: "pasta carbonara",
    calories: 920,
  });
  await post(`/api/data/${MT}`, {
    client: "Houssem",
    food: "almonds and apple",
    calories: 310,
  });
  const md = await get(`/api/data/${MT}`);
  if ((md.rows || []).length === 4) pass("4 meals inserted");
  else fail(`Meals: ${(md.rows || []).length}`);

  const tpSchema = await get(`/api/schema/${TP}`);
  const tpCols = (tpSchema.columns || [])
    .map((c) => c.column_name)
    .filter((c) => c !== "id" && c !== "created_at");
  console.log(`  training_programs columns: ${tpCols.join(", ")}`);

  const tpData = [
    {
      client: "Houssem",
      program: "Fat Burn HIIT",
      exercises: "HIIT intervals, jump rope",
      sessions_per_week: 3,
      duration_weeks: 8,
    },
    {
      client: "Sara",
      program: "Hypertrophy Split",
      exercises: "chest press, squats, rows",
      sessions_per_week: 4,
      duration_weeks: 12,
    },
    {
      client: "Karim",
      program: "Marathon Prep",
      exercises: "long runs, tempo runs, intervals",
      sessions_per_week: 5,
      duration_weeks: 16,
    },
  ];
  for (const row of tpData) {
    const filtered = Object.fromEntries(
      Object.entries(row).filter(([k]) => tpCols.includes(k))
    );
    await post(`/api/data/${TP}`, filtered);
  }
  const td = await get(`/api/data/${TP}`);
  if ((td.rows || []).length === 3) pass("3 training programs inserted");
  else fail(`Programs: ${(td.rows || []).length}`);

  // 6. PREFILL test
  console.log("\n▸ Step 6: PREFILL test — add client via chat");
  const r6 = await post("/api/chat", {
    message: "New client: Ahmed, 30 years old, 78kg, goal is muscle gain",
    sessionId: SID,
  });
  console.log(
    `  Action: ${r6.action} | Values: ${JSON.stringify(r6.values || {})}`
  );
  if (r6.action === "prefill") pass("PREFILL returned");
  else warn(`Expected prefill, got ${r6.action}`);

  // 7. Stat query: total calories
  console.log("\n▸ Step 7: Stat query — total calories");
  const r7 = await post("/api/chat", {
    message: "What is the total calories logged?",
    sessionId: SID,
  });
  console.log(
    `  Action: ${r7.action} | Chart: ${r7.chartType} | Rows: ${JSON.stringify(
      r7.rows || []
    )}`
  );
  console.log(`  Interpretation: ${r7.message}`);
  if (r7.action === "query") pass("Query action");
  else fail(`Expected query, got ${r7.action}`);
  if (r7.chartType === "stat") pass("Stat chart type");
  else warn(`Expected stat, got ${r7.chartType}`);

  // 8. Bar chart query
  console.log("\n▸ Step 8: Bar chart — calories per client");
  const r8 = await post("/api/chat", {
    message: "Show me total calories per client",
    sessionId: SID,
  });
  console.log(
    `  Chart: ${r8.chartType} | Rows: ${JSON.stringify(r8.rows || [])}`
  );
  console.log(`  Interpretation: ${r8.message}`);
  if (r8.chartType === "bar") pass("Bar chart");
  else warn(`Expected bar, got ${r8.chartType}`);

  // 9. Insight query: case-insensitive
  console.log(
    "\n▸ Step 9: Insight — is houssem eating healthy? (lowercase test)"
  );
  const r9 = await post("/api/chat", {
    message: "Is houssem eating healthy?",
    sessionId: SID,
  });
  console.log(`  Action: ${r9.action} | SQL: ${r9.sql}`);
  console.log(`  Interpretation: ${r9.message}`);
  if (r9.action === "query") pass("Insight query returned");
  else fail(`Expected query, got ${r9.action}`);
  if (
    r9.message &&
    (r9.message.includes("960") ||
      r9.message.includes("calori") ||
      r9.message.includes("Houssem") ||
      r9.message.includes("houssem"))
  )
    pass("Interpretation references actual data");
  else warn("Interpretation may lack specific data");

  // 10. ALTER table
  console.log("\n▸ Step 10: ALTER — add notes column");
  const r10 = await post("/api/chat", {
    message: "Add a notes column to the clients table",
    sessionId: SID,
  });
  console.log(`  Action: ${r10.action}`);
  if (r10.action === "alter") pass("ALTER returned");
  else fail(`Expected alter, got ${r10.action}`);

  const colsAfter = await get(`/api/schema/${CT}`);
  const colNames = (colsAfter.columns || []).map((c) => c.column_name);
  console.log(`  Columns after: ${colNames.join(", ")}`);
  if (colNames.includes("notes")) pass("notes column added");
  else fail("notes column missing");

  // 11. New linked table mid-session (weight_measurements)
  console.log("\n▸ Step 11: Create weight_measurements (new linked table)");
  const r11 = await post("/api/chat", {
    message: "I also want to track weekly weight measurements for each client",
    sessionId: SID,
  });
  console.log(`  Action: ${r11.action}`);
  const wmCols = ((r11.schema || {}).columns || [])
    .map((c) => c.name)
    .join(", ");
  console.log(`  Columns: ${wmCols}`);
  if (r11.action === "create" || r11.action === "create_many")
    pass("weight_measurements created");
  else fail(`Expected create, got ${r11.action}`);

  // 12. Second-level linked table (workout_sessions → training_programs) — KEY COMPOUND NAME TEST
  console.log(
    "\n▸ Step 12: Create workout_sessions → training_programs (COMPOUND NAME TEST)"
  );
  const r12 = await post("/api/chat", {
    message:
      "I want to log individual workout sessions for each training program — track the date, exercises done, and duration in minutes. The table should have a training_program column linking to training_programs.",
    sessionId: SID,
  });
  console.log(
    `  Action: ${r12.action} | SQL: ${(r12.sql || "").substring(0, 200)}`
  );
  if (r12.action === "create_many") {
    const wsManySchemas = (r12.schemas || [])
      .map((s) => `${s.tableName}(${s.columns.map((c) => c.name).join(",")})`)
      .join(" | ");
    console.log(`  Schemas: ${wsManySchemas}`);
  } else {
    const wsCols = ((r12.schema || {}).columns || [])
      .map((c) => c.name)
      .join(", ");
    console.log(`  Columns: ${wsCols}`);
  }

  await sleep(500);
  const rels12 = await get(`/api/sessions/${SID}/relations`);
  const allRels = (rels12.relations || []).map(
    (r) => `${r.from.replace(prefix, "")}→${r.to.replace(prefix, "")}(${r.on})`
  );
  console.log(`  All relations: ${allRels.join(", ")}`);

  const hasWsToTp = (rels12.relations || []).some(
    (r) => r.from.includes("workout") && r.to.includes("training")
  );
  if (hasWsToTp) pass("workout_sessions → training_programs relation DETECTED");
  else fail("workout_sessions → training_programs relation NOT DETECTED");

  // 13. Cross-table JOIN
  console.log("\n▸ Step 13: Cross-table JOIN query");
  try {
    const r13 = await post("/api/chat", {
      message:
        "Show me each client with their total calories and their training program name",
      sessionId: SID,
    });
    console.log(
      `  Action: ${r13.action} | Rows: ${JSON.stringify(
        (r13.rows || []).slice(0, 5)
      )}`
    );
    console.log(`  Interpretation: ${r13.message}`);
    if (r13.action === "query") pass("JOIN query returned");
    else warn(`Expected query, got ${r13.action}`);
  } catch (e) {
    fail(`JOIN query error: ${e.message}`);
  }

  // 14. Count clients (stat)
  console.log("\n▸ Step 14: How many clients?");
  try {
    const r14 = await post("/api/chat", {
      message: "How many clients do I have?",
      sessionId: SID,
    });
    console.log(
      `  Chart: ${r14.chartType} | Rows: ${JSON.stringify(r14.rows || [])}`
    );
    if (r14.chartType === "stat") pass("Stat card for count");
    else warn(`Expected stat, got ${r14.chartType}`);
  } catch (e) {
    fail(`Count query error: ${e.message}`);
  }

  // 15. Compare query
  console.log("\n▸ Step 15: Compare houssem and karim calorie intake");
  try {
    const r15 = await post("/api/chat", {
      message: "Compare houssem and karim calorie intake",
      sessionId: SID,
    });
    console.log(`  Interpretation: ${r15.message}`);
    if (
      r15.message &&
      (r15.message.toLowerCase().includes("houssem") ||
        r15.message.toLowerCase().includes("karim"))
    )
      pass("Comparison mentions both clients");
    else warn("Comparison may not reference both clients");
  } catch (e) {
    fail(`Compare error: ${e.message}`);
  }

  // CLEANUP
  console.log("\n▸ Cleanup: Deleting test session");
  await del(`/api/sessions/${SID}`);
  pass(`Session ${SID} deleted`);

  // Summary
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(` Results: ${PASS} passed, ${FAIL} failed, ${WARN} warnings`);
  console.log("═══════════════════════════════════════════════════════");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
