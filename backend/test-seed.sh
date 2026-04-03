#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Morph — Seed random data end-to-end test
# Creates a session, builds tables via chat, then seeds random data.
# ═══════════════════════════════════════════════════════════════
BASE="http://localhost:3001"
PASS=0
FAIL=0

pass() { ((PASS++)); echo "  ✓ $1"; }
fail() { ((FAIL++)); echo "  ✗ $1"; }
# Portable JSON parser — works on Windows (no /dev/stdin)
jp() {
  local json="$1"
  local expr="$2"
  node -e "const d=JSON.parse(process.argv[1]); const r=$expr; if(r!==undefined) console.log(typeof r==='string'?r:JSON.stringify(r))" "$json"
}

echo "═══════════════════════════════════════════════════════"
echo " Morph — Seed Random Data Test"
echo "═══════════════════════════════════════════════════════"

# ──────────────────────────────────────────────────────────
# 1. Create a session
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 1: Create a fresh session"
SESSION=$(curl -s -X POST "$BASE/api/sessions")
SID=$(jp "$SESSION" "d.id")
if [ -z "$SID" ] || [ "$SID" = "" ] || [ "$SID" = "undefined" ]; then
  fail "Could not create session"
  echo "  Response: $SESSION"
  exit 1
fi
pass "Session created: id=$SID"

# ──────────────────────────────────────────────────────────
# 2. Create tables via chat (multi-table)
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 2: Create linked tables via chat"
CHAT_BODY=$(node -e "console.log(JSON.stringify({message:'I run a small gym. Track clients with name, age, weight and goal. Track meals for each client with food and calories. Track training programs for each client with name, duration_weeks and level.',sessionId:$SID}))")

CHAT_RESP=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "$CHAT_BODY" \
  --max-time 120)

ACTION=$(jp "$CHAT_RESP" "d.action")
MSG=$(jp "$CHAT_RESP" "d.message")
echo "  Action: $ACTION"
echo "  Message: $MSG"

if [ "$ACTION" = "create" ] || [ "$ACTION" = "create_many" ]; then
  pass "Tables created (action=$ACTION)"
else
  fail "Expected create/create_many, got: $ACTION"
fi

# ──────────────────────────────────────────────────────────
# 3. Verify tables exist
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 3: Verify tables in session"
DETAIL=$(curl -s "$BASE/api/sessions/$SID")
TABLE_COUNT=$(jp "$DETAIL" "d.sessionTables.length")
TABLES=$(jp "$DETAIL" "d.sessionTables.map(t=>t.table_name).join(', ')")

if [ "$TABLE_COUNT" -gt 0 ] 2>/dev/null; then
  pass "$TABLE_COUNT table(s) found: $TABLES"
else
  fail "No tables found in session"
  exit 1
fi

# ──────────────────────────────────────────────────────────
# 4. Verify tables are empty
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 4: Verify tables are empty before seed"
TABLE_NAMES=$(jp "$DETAIL" "d.sessionTables.map(t=>t.table_name).join(' ')")
for TBL in $TABLE_NAMES; do
  DATA=$(curl -s "$BASE/api/data/$TBL")
  COUNT=$(jp "$DATA" "d.rows.length")
  DISPLAY=$(echo "$TBL" | sed "s/^s${SID}_//")
  if [ "$COUNT" = "0" ]; then
    pass "$DISPLAY is empty (0 rows)"
  else
    echo "  ⚠ $DISPLAY already has $COUNT rows"
  fi
done

# ──────────────────────────────────────────────────────────
# 5. Seed random data
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 5: Seed random data to all modules"
echo "  (this calls the LLM, may take 10-30s…)"
SEED_RESP=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"add random data to all modules\",\"sessionId\":$SID}" \
  --max-time 120)

SEED_ACTION=$(jp "$SEED_RESP" "d.action")
SEED_MSG=$(jp "$SEED_RESP" "d.message")
SEED_COUNT=$(jp "$SEED_RESP" "d.seedResult ? d.seedResult.length : 0")

echo "  Action: $SEED_ACTION"
echo "  Message: $SEED_MSG"

if [ "$SEED_ACTION" = "seed" ]; then
  pass "Seed action detected"
else
  fail "Expected action=seed, got: $SEED_ACTION"
  echo "  Full response: $SEED_RESP"
fi

if [ "$SEED_COUNT" -gt 0 ] 2>/dev/null; then
  pass "$SEED_COUNT table(s) seeded"
  node -e "const d=JSON.parse(process.argv[1]); d.seedResult.forEach(r => console.log('    → ' + r.table + ': ' + r.count + ' rows'))" "$SEED_RESP"
else
  fail "seedResult is empty — no data was inserted"
  echo "  Full response (first 500 chars):"
  echo "  ${SEED_RESP:0:500}"
fi

# ──────────────────────────────────────────────────────────
# 6. Verify data exists in tables
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 6: Verify tables have data after seed"
for TBL in $TABLE_NAMES; do
  DATA=$(curl -s "$BASE/api/data/$TBL")
  COUNT=$(jp "$DATA" "d.rows.length")
  DISPLAY=$(echo "$TBL" | sed "s/^s${SID}_//")
  if [ "$COUNT" -gt 0 ] 2>/dev/null; then
    pass "$DISPLAY has $COUNT rows"
    node -e "const d=JSON.parse(process.argv[1]); d.rows.slice(0,2).forEach(r => { delete r.id; delete r.created_at; console.log('    → ' + JSON.stringify(r)) })" "$DATA"
  else
    fail "$DISPLAY is still empty"
  fi
done

# ──────────────────────────────────────────────────────────
# 7. Check FK consistency
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 7: Check FK consistency (child values exist in parent)"
RELS=$(curl -s "$BASE/api/sessions/$SID/relations")
REL_COUNT=$(jp "$RELS" "d.relations ? d.relations.length : 0")

if [ "$REL_COUNT" -gt 0 ] 2>/dev/null; then
  echo "  $REL_COUNT relation(s) found"
  node -e "const d=JSON.parse(process.argv[1]); d.relations.forEach(r => console.log('    ' + r.from.replace(/^s\d+_/,'') + '.' + r.on + ' → ' + r.to.replace(/^s\d+_/,'')))" "$RELS"

  # For each relation, verify child FK values exist in parent
  node -e "
    const d=JSON.parse(process.argv[1]);
    const base=process.argv[2];
    (async () => {
      for (const r of d.relations) {
        const parentData = await fetch(base + '/api/data/' + r.to).then(r=>r.json());
        const childData  = await fetch(base + '/api/data/' + r.from).then(r=>r.json());
        const parentNames = new Set(parentData.rows.map(row => {
          const firstText = Object.entries(row).find(([k,v]) => k !== 'id' && k !== 'created_at' && typeof v === 'string');
          return firstText ? firstText[1] : null;
        }).filter(Boolean));
        const childFKs = childData.rows.map(row => row[r.on]).filter(Boolean);
        const mismatches = childFKs.filter(v => !parentNames.has(v));
        const fromDisp = r.from.replace(/^s\d+_/,'');
        const toDisp = r.to.replace(/^s\d+_/,'');
        if (mismatches.length === 0 && childFKs.length > 0) {
          console.log('    ✓ ' + fromDisp + '.' + r.on + ' → all ' + childFKs.length + ' values match ' + toDisp);
        } else if (mismatches.length > 0) {
          console.log('    ✗ ' + fromDisp + '.' + r.on + ' → ' + mismatches.length + '/' + childFKs.length + ' values not in ' + toDisp + ': ' + mismatches.slice(0,3).join(', '));
        }
      }
    })()
  " "$RELS" "$BASE"
else
  echo "  No relations detected"
fi

# ──────────────────────────────────────────────────────────
# 8. Cleanup
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Step 8: Cleanup — delete test session"
curl -s -X DELETE "$BASE/api/sessions/$SID" > /dev/null
pass "Session $SID deleted"

# ──────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo " Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
