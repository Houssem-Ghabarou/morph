#!/bin/bash
BASE="http://localhost:3001"
PASS=0
FAIL=0
WARN=0

pass() { ((PASS++)); echo "  ✓ $1"; }
fail() { ((FAIL++)); echo "  ✗ $1"; }
warn() { ((WARN++)); echo "  ⚠ $1"; }

jp() { node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));const v=$1;console.log(v===undefined?'':v)}catch(e){console.log('')}"; }

echo "═══════════════════════════════════════════════════════"
echo " Morph Backend — Automated Test Suite"
echo "═══════════════════════════════════════════════════════"

# ──────────────────────────────────────────────────────────
# 1. Create a fresh session
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 1: Create a fresh session"
SESSION=$(curl -s -X POST "$BASE/api/sessions")
SID=$(echo "$SESSION" | jp "d.id")
if [ -z "$SID" ] || [ "$SID" = "" ]; then
  fail "Could not create session"
  echo "  Response: $SESSION"
  exit 1
fi
pass "Session created: id=$SID"

# ──────────────────────────────────────────────────────────
# 2. Build data model (multi-table CREATE)
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 2: Create multi-table data model"
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"I'm a gym coach and nutritionist. I need to track my clients, their meals with calories, and their training programs with exercises.\",\"sessionId\":$SID}")

ACTION=$(echo "$R" | jp "d.action")
MSG=$(echo "$R" | jp "d.message")
SCHEMAS_COUNT=$(echo "$R" | jp "(d.schemas||[]).length")
REL_COUNT=$(echo "$R" | jp "(d.relations||[]).length")

if [ "$ACTION" = "create_many" ] || [ "$ACTION" = "create" ]; then
  pass "Action: $ACTION"
else
  fail "Expected create/create_many, got: $ACTION"
fi
echo "  Message: $MSG"
echo "  Schemas: $SCHEMAS_COUNT | Relations: $REL_COUNT"

if [ "$REL_COUNT" -gt "0" ] 2>/dev/null; then
  pass "Relations detected: $REL_COUNT"
else
  warn "No relations in create response (may need compound name fix)"
fi

# ──────────────────────────────────────────────────────────
# 3. Verify session relations endpoint
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 3: Verify session relations endpoint"
RELS=$(curl -s "$BASE/api/sessions/$SID/relations")
REL_COUNT2=$(echo "$RELS" | jp "(d.relations||[]).length")
REL_DETAIL=$(echo "$RELS" | jp "JSON.stringify(d.relations)")
echo "  Relations: $REL_DETAIL"
if [ "$REL_COUNT2" -gt "0" ] 2>/dev/null; then
  pass "Relations endpoint returns $REL_COUNT2 relations"
else
  fail "Relations endpoint returned 0 relations"
fi

# ──────────────────────────────────────────────────────────
# 4. Check table schemas
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 4: Check table schemas created"
for TBL in "s${SID}_clients" "s${SID}_meals" "s${SID}_training_programs"; do
  SCHEMA_R=$(curl -s "$BASE/api/schema/$TBL")
  COLS=$(echo "$SCHEMA_R" | jp "(d.columns||[]).map(c=>c.column_name).join(', ')")
  if [ -n "$COLS" ]; then
    pass "Table $TBL: $COLS"
  else
    fail "Table $TBL not found or no columns"
  fi
done

# ──────────────────────────────────────────────────────────
# 5. INSERT clients via data API
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 5: Insert test data via /api/data"

CT="s${SID}_clients"
MT="s${SID}_meals"
TP="s${SID}_training_programs"

curl -s -X POST "$BASE/api/data/$CT" -H "Content-Type: application/json" -d '{"name":"Houssem","age":28,"weight":82,"goal":"fat loss"}' > /dev/null 2>&1
curl -s -X POST "$BASE/api/data/$CT" -H "Content-Type: application/json" -d '{"name":"Sara","age":24,"weight":61,"goal":"muscle gain"}' > /dev/null 2>&1
curl -s -X POST "$BASE/api/data/$CT" -H "Content-Type: application/json" -d '{"name":"Karim","age":35,"weight":95,"goal":"endurance"}' > /dev/null 2>&1

CLIENT_COUNT=$(curl -s "$BASE/api/data/$CT" | jp "(d.rows||[]).length")
if [ "$CLIENT_COUNT" = "3" ]; then pass "3 clients inserted"; else fail "Expected 3 clients, got $CLIENT_COUNT"; fi

curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" -d '{"client":"Houssem","food":"grilled chicken","calories":650}' > /dev/null 2>&1
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" -d '{"client":"Sara","food":"oats with banana","calories":480}' > /dev/null 2>&1
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" -d '{"client":"Karim","food":"pasta carbonara","calories":920}' > /dev/null 2>&1
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" -d '{"client":"Houssem","food":"almonds and apple","calories":310}' > /dev/null 2>&1

MEAL_COUNT=$(curl -s "$BASE/api/data/$MT" | jp "(d.rows||[]).length")
if [ "$MEAL_COUNT" = "4" ]; then pass "4 meals inserted"; else fail "Expected 4 meals, got $MEAL_COUNT"; fi

curl -s -X POST "$BASE/api/data/$TP" -H "Content-Type: application/json" -d '{"client":"Houssem","program":"Fat Burn HIIT","sessions_per_week":3,"duration_weeks":8}' > /dev/null 2>&1
curl -s -X POST "$BASE/api/data/$TP" -H "Content-Type: application/json" -d '{"client":"Sara","program":"Hypertrophy Split","sessions_per_week":4,"duration_weeks":12}' > /dev/null 2>&1
curl -s -X POST "$BASE/api/data/$TP" -H "Content-Type: application/json" -d '{"client":"Karim","program":"Marathon Prep","sessions_per_week":5,"duration_weeks":16}' > /dev/null 2>&1

TP_COUNT=$(curl -s "$BASE/api/data/$TP" | jp "(d.rows||[]).length")
if [ "$TP_COUNT" = "3" ]; then pass "3 training programs inserted"; else fail "Expected 3, got $TP_COUNT"; fi

# ──────────────────────────────────────────────────────────
# 6. PREFILL test (INSERT intent via chat)
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 6: PREFILL test — add client via chat"
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"New client: Ahmed, 30 years old, 78kg, goal is muscle gain\",\"sessionId\":$SID}")

ACTION=$(echo "$R" | jp "d.action")
VALUES=$(echo "$R" | jp "JSON.stringify(d.values||{})")
echo "  Action: $ACTION | Values: $VALUES"
if [ "$ACTION" = "prefill" ]; then pass "PREFILL returned for insert intent"; else warn "Expected prefill, got $ACTION"; fi

# ──────────────────────────────────────────────────────────
# 7. Stat query: total calories
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 7: Stat query — total calories"
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"What is the total calories logged?\",\"sessionId\":$SID}")

ACTION=$(echo "$R" | jp "d.action")
CHART=$(echo "$R" | jp "d.chartType")
ROWS=$(echo "$R" | jp "JSON.stringify(d.rows||[])")
MSG=$(echo "$R" | jp "d.message")

if [ "$ACTION" = "query" ]; then pass "Query action returned"; else fail "Expected query, got $ACTION"; fi
if [ "$CHART" = "stat" ]; then pass "Stat chart type"; else warn "Expected stat, got $CHART"; fi
echo "  Rows: $ROWS"
echo "  Interpretation: $MSG"

# ──────────────────────────────────────────────────────────
# 8. Bar chart query: calories per client
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 8: Bar chart — calories per client"
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Show me total calories per client\",\"sessionId\":$SID}")

CHART=$(echo "$R" | jp "d.chartType")
ROWS=$(echo "$R" | jp "JSON.stringify(d.rows||[])")
MSG=$(echo "$R" | jp "d.message")

if [ "$CHART" = "bar" ]; then pass "Bar chart detected"; else warn "Expected bar, got $CHART"; fi
echo "  Rows: $ROWS"
echo "  Interpretation: $MSG"

# ──────────────────────────────────────────────────────────
# 9. Insight: is houssem eating healthy
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 9: Insight — is houssem eating healthy?"
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Is houssem eating healthy?\",\"sessionId\":$SID}")

ACTION=$(echo "$R" | jp "d.action")
MSG=$(echo "$R" | jp "d.message")
SQL=$(echo "$R" | jp "d.sql")

if [ "$ACTION" = "query" ]; then pass "Insight query returned"; else fail "Expected query, got $ACTION"; fi
echo "  SQL: $SQL"
echo "  Interpretation: $MSG"

# ──────────────────────────────────────────────────────────
# 10. ALTER table test
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 10: ALTER — add notes column to clients"
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Add a notes column to the clients table\",\"sessionId\":$SID}")

ACTION=$(echo "$R" | jp "d.action")
if [ "$ACTION" = "alter" ]; then pass "ALTER returned"; else fail "Expected alter, got $ACTION"; fi

# Verify column was added
COLS=$(curl -s "$BASE/api/schema/$CT" | jp "(d.columns||[]).map(c=>c.column_name).join(', ')")
echo "  Updated columns: $COLS"

# ──────────────────────────────────────────────────────────
# 11. New linked table mid-session
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 11: Create weight_measurements (new linked table)"
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"I also want to track weekly weight measurements for each client\",\"sessionId\":$SID}")

ACTION=$(echo "$R" | jp "d.action")
COLS=$(echo "$R" | jp "(d.schema||{columns:[]}).columns.map(c=>c.name).join(', ')")
echo "  Action: $ACTION | Columns: $COLS"
if [ "$ACTION" = "create" ] || [ "$ACTION" = "create_many" ]; then pass "weight_measurements created"; else fail "Expected create, got $ACTION"; fi

# ──────────────────────────────────────────────────────────
# 12. Second-level linked table (workout_sessions → training_programs)
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 12: Create workout_sessions → training_programs (compound relation test)"
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"I want to log individual workout sessions for each training program — track the date, exercises done, and duration in minutes\",\"sessionId\":$SID}")

ACTION=$(echo "$R" | jp "d.action")
COLS=$(echo "$R" | jp "(d.schema||{columns:[]}).columns.map(c=>c.name).join(', ')")
echo "  Action: $ACTION | Columns: $COLS"

# Check relations — this is the KEY test for compound name matching
sleep 1
RELS=$(curl -s "$BASE/api/sessions/$SID/relations")
REL_DETAIL=$(echo "$RELS" | jp "JSON.stringify(d.relations||[])")
echo "  All relations: $REL_DETAIL"

HAS_WS_TP=$(echo "$RELS" | jp "d.relations.some(r=>r.from.includes('workout')&&r.to.includes('training'))")
if [ "$HAS_WS_TP" = "true" ]; then
  pass "workout_sessions → training_programs relation detected"
else
  fail "workout_sessions → training_programs relation NOT detected (COMPOUND NAME BUG)"
fi

# ──────────────────────────────────────────────────────────
# 13. Cross-table JOIN query
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 13: Cross-table JOIN query"
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Show me each client with their total calories and their training program name\",\"sessionId\":$SID}")

ACTION=$(echo "$R" | jp "d.action")
ROWS=$(echo "$R" | jp "JSON.stringify(d.rows||[])")
MSG=$(echo "$R" | jp "d.message")
echo "  Action: $ACTION"
echo "  Rows: $ROWS"
echo "  Interpretation: $MSG"

# ──────────────────────────────────────────────────────────
# 14. How many clients
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 14: How many clients?"
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"How many clients do I have?\",\"sessionId\":$SID}")

CHART=$(echo "$R" | jp "d.chartType")
ROWS=$(echo "$R" | jp "JSON.stringify(d.rows||[])")
echo "  Chart: $CHART | Rows: $ROWS"

# ──────────────────────────────────────────────────────────
# CLEANUP
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Cleanup: Deleting test session $SID"
curl -s -X DELETE "$BASE/api/sessions/$SID" > /dev/null
pass "Session $SID deleted"

# ──────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo " Results: $PASS passed, $FAIL failed, $WARN warnings"
echo "═══════════════════════════════════════════════════════"
