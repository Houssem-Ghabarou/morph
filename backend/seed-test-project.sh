#!/bin/bash
BASE="http://localhost:3001"

jp() {
  node -e "
    let buf='';
    process.stdin.on('data',c=>buf+=c);
    process.stdin.on('end',()=>{
      try{const d=JSON.parse(buf);const v=$1;console.log(v===undefined?'':v)}
      catch(e){console.log('')}
    });
  "
}

echo "═══════════════════════════════════════════════════════"
echo " Morph — Seed a Test Project (persistent)"
echo "═══════════════════════════════════════════════════════"

# ──────────────────────────────────────────────────────────
# 1. Create session
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Creating session..."
SESSION=$(curl -s -X POST "$BASE/api/sessions")
SID=$(echo "$SESSION" | jp "d.id")
if [ -z "$SID" ] || [ "$SID" = "" ]; then
  echo "  ✗ Could not create session. Is the backend running?"
  echo "  Raw response: $SESSION"
  exit 1
fi
echo "  ✓ Session created: id=$SID"

# Rename it so it's easy to find
curl -s -X PATCH "$BASE/api/sessions/$SID/name" \
  -H "Content-Type: application/json" \
  -d '{"name":"Gym Coach Demo"}' > /dev/null
echo "  ✓ Renamed to 'Gym Coach Demo'"

# ──────────────────────────────────────────────────────────
# 2. Create tables via chat (multi-table)
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Creating data model via AI chat..."
R=$(curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"I'm a gym coach and nutritionist. I need to track my clients with name age weight and goal, their meals with food and calories, and their training programs with program name sessions per week and duration in weeks.\",\"sessionId\":$SID}")

ACTION=$(echo "$R" | jp "d.action")
MSG=$(echo "$R" | jp "d.message")
echo "  Action: $ACTION"
echo "  $MSG"

# Give the DB a moment
sleep 2

# ──────────────────────────────────────────────────────────
# 3. Discover actual table names
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Discovering tables..."
SESSION_DETAIL=$(curl -s "$BASE/api/sessions/$SID")
TABLES=$(echo "$SESSION_DETAIL" | jp "d.sessionTables.map(t=>t.table_name).join(',')")
echo "  Tables: $TABLES"

CT=$(echo "$TABLES" | tr ',' '\n' | grep -i client | head -1)
MT=$(echo "$TABLES" | tr ',' '\n' | grep -i meal | head -1)
TP=$(echo "$TABLES" | tr ',' '\n' | grep -i program | head -1)

if [ -z "$CT" ]; then echo "  ✗ Clients table not found"; exit 1; fi
if [ -z "$MT" ]; then echo "  ✗ Meals table not found"; exit 1; fi
if [ -z "$TP" ]; then echo "  ✗ Training programs table not found"; exit 1; fi

echo "  Clients: $CT"
echo "  Meals: $MT"
echo "  Programs: $TP"

# ──────────────────────────────────────────────────────────
# 4. Get column names for each table
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Reading schemas..."
CT_COLS=$(curl -s "$BASE/api/schema/$CT" | jp "(d.columns||[]).filter(c=>c.column_name!=='id'&&c.column_name!=='created_at').map(c=>c.column_name).join(', ')")
MT_COLS=$(curl -s "$BASE/api/schema/$MT" | jp "(d.columns||[]).filter(c=>c.column_name!=='id'&&c.column_name!=='created_at').map(c=>c.column_name).join(', ')")
TP_COLS=$(curl -s "$BASE/api/schema/$TP" | jp "(d.columns||[]).filter(c=>c.column_name!=='id'&&c.column_name!=='created_at').map(c=>c.column_name).join(', ')")
echo "  $CT: $CT_COLS"
echo "  $MT: $MT_COLS"
echo "  $TP: $TP_COLS"

# ──────────────────────────────────────────────────────────
# 5. Insert clients
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Inserting clients..."
curl -s -X POST "$BASE/api/data/$CT" -H "Content-Type: application/json" \
  -d '{"name":"Houssem","age":28,"weight":82,"goal":"fat loss"}' > /dev/null
curl -s -X POST "$BASE/api/data/$CT" -H "Content-Type: application/json" \
  -d '{"name":"Sara","age":24,"weight":61,"goal":"muscle gain"}' > /dev/null
curl -s -X POST "$BASE/api/data/$CT" -H "Content-Type: application/json" \
  -d '{"name":"Karim","age":35,"weight":95,"goal":"endurance"}' > /dev/null
curl -s -X POST "$BASE/api/data/$CT" -H "Content-Type: application/json" \
  -d '{"name":"Lina","age":29,"weight":58,"goal":"toning"}' > /dev/null
curl -s -X POST "$BASE/api/data/$CT" -H "Content-Type: application/json" \
  -d '{"name":"Youssef","age":22,"weight":73,"goal":"bulk up"}' > /dev/null

COUNT=$(curl -s "$BASE/api/data/$CT" | jp "(d.rows||[]).length")
echo "  ✓ $COUNT clients inserted"

# ──────────────────────────────────────────────────────────
# 6. Insert meals
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Inserting meals..."
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Houssem","food":"grilled chicken with rice","calories":650}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Houssem","food":"almonds and apple","calories":310}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Houssem","food":"protein shake","calories":280}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Sara","food":"oats with banana","calories":480}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Sara","food":"tuna salad","calories":350}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Sara","food":"egg white omelette","calories":220}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Karim","food":"pasta carbonara","calories":920}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Karim","food":"steak with potatoes","calories":850}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Lina","food":"greek yogurt with berries","calories":180}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Lina","food":"quinoa bowl","calories":420}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Youssef","food":"chicken breast with sweet potato","calories":580}' > /dev/null
curl -s -X POST "$BASE/api/data/$MT" -H "Content-Type: application/json" \
  -d '{"client":"Youssef","food":"mass gainer shake","calories":1100}' > /dev/null

COUNT=$(curl -s "$BASE/api/data/$MT" | jp "(d.rows||[]).length")
echo "  ✓ $COUNT meals inserted"

# ──────────────────────────────────────────────────────────
# 7. Insert training programs
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Inserting training programs..."
curl -s -X POST "$BASE/api/data/$TP" -H "Content-Type: application/json" \
  -d '{"client":"Houssem","program":"Fat Burn HIIT","sessions_per_week":4,"duration_weeks":8}' > /dev/null
curl -s -X POST "$BASE/api/data/$TP" -H "Content-Type: application/json" \
  -d '{"client":"Sara","program":"Hypertrophy Split","sessions_per_week":5,"duration_weeks":12}' > /dev/null
curl -s -X POST "$BASE/api/data/$TP" -H "Content-Type: application/json" \
  -d '{"client":"Karim","program":"Marathon Prep","sessions_per_week":5,"duration_weeks":16}' > /dev/null
curl -s -X POST "$BASE/api/data/$TP" -H "Content-Type: application/json" \
  -d '{"client":"Lina","program":"Toning & Flexibility","sessions_per_week":3,"duration_weeks":10}' > /dev/null
curl -s -X POST "$BASE/api/data/$TP" -H "Content-Type: application/json" \
  -d '{"client":"Youssef","program":"Mass Building","sessions_per_week":6,"duration_weeks":14}' > /dev/null

COUNT=$(curl -s "$BASE/api/data/$TP" | jp "(d.rows||[]).length")
echo "  ✓ $COUNT training programs inserted"

# ──────────────────────────────────────────────────────────
# 8. Verify relations
# ──────────────────────────────────────────────────────────
echo ""
echo "▸ Checking relations..."
RELS=$(curl -s "$BASE/api/sessions/$SID/relations")
REL_DETAIL=$(echo "$RELS" | jp "d.relations.map(r=>r.from+'.'+r.on+' -> '+r.to).join(', ')")
echo "  Relations: $REL_DETAIL"

# ──────────────────────────────────────────────────────────
# Done — NOT deleting
# ──────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo " ✓ Done! Project 'Gym Coach Demo' seeded (session $SID)"
echo ""
echo " Data summary:"
echo "   • 5 clients (Houssem, Sara, Karim, Lina, Youssef)"
echo "   • 12 meals with calories"
echo "   • 5 training programs"
echo ""
echo " The session is NOT deleted — open the app and try:"
echo "   • 'analyze my data'"
echo "   • 'show me all statistics'"
echo "   • 'give me insights'"
echo "═══════════════════════════════════════════════════════"
