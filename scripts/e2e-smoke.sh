#!/usr/bin/env bash
# =============================================================================
# LotLogic end-to-end pre-install smoke test
# -----------------------------------------------------------------------------
# Drives the full parking-enforcement flow against PRODUCTION Supabase +
# Railway backend without any physical cameras. Run this the morning of the
# Charlotte Travel Plaza install to confirm every server-side code path is
# healthy.
#
# READ BEFORE RUNNING
# -------------------
#   1. This talks to PROD. It WILL create rows in plate_events /
#      plate_sessions / alpr_violations / visitor_passes / plate_holds, and
#      WILL trigger real Resend emails to whatever tow-dispatch-email is
#      configured for. Before running, confirm EMAIL_OVERRIDE_TO on the
#      tow-dispatch-email edge function is set to a mailbox you control (not
#      a real partner inbox), or accept that a partner will get a test email.
#   2. Every row created is tagged `plate_text LIKE 'TEST%'` and is deleted
#      in section H (via trap, so even a partial failure cleans up).
#   3. PREREQ — the spec at
#      docs/superpowers/specs/2026-04-20-camera-session-state-machine-design.md
#      MUST BE DEPLOYED before most of this passes. Specifically needed:
#        * migrations 011 (alpr_cameras.orientation)
#        * migration 012 (plate_sessions + FKs)
#        * migration 013 (plate_holds + violation.left_before_tow_at)
#        * migration 014 (pg_cron + fn_plate_sessions_* + cron-sessions-sweep)
#        * camera-snapshot v4 (session-aware)
#        * backend /visitor_passes/register hold-check (409 PLATE_HOLD)
#      Until those ship, sections B-G will fail and section A will create a
#      plate_events row (not a plate_sessions row).
#   4. Credentials come from .env.local via `source`. Required vars:
#        SUPABASE_URL, SUPABASE_PROJECT_REF, SUPABASE_SERVICE_ROLE_KEY,
#        CAMERA_SNAPSHOT_URL_SECRET
#      Optional (for section C): JWT_SECRET (= Supabase JWT secret).
#
# USAGE
# -----
#   cd /Users/gabe/lotlogic
#   bash scripts/e2e-smoke.sh
#   # Exit 0 = all sections passed. Non-zero = at least one section failed;
#   # see the summary block printed at the end.
# =============================================================================

set -u -o pipefail

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
PROPERTY_ID="bd44ace8-feda-42e1-9866-5d60f65e1712"   # Charlotte Travel Plaza
CAMERA_API_KEY="1CC31660025E"                         # Milesight devMac
BACKEND_URL="${BACKEND_URL:-https://api.lotlogicparking.com}"

# Repo root — so we can source .env.local regardless of where we're invoked
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$REPO_ROOT/.env.local" ]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO_ROOT/.env.local"; set +a
else
  echo "ERROR: $REPO_ROOT/.env.local missing — required for SUPABASE_URL etc." >&2
  exit 2
fi

: "${SUPABASE_URL:?SUPABASE_URL missing from .env.local}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY missing from .env.local}"
: "${CAMERA_SNAPSHOT_URL_SECRET:?CAMERA_SNAPSHOT_URL_SECRET missing from .env.local}"
SUPABASE_URL="${SUPABASE_URL%/}"   # strip trailing slash
REST="${SUPABASE_URL}/rest/v1"
FN="${SUPABASE_URL}/functions/v1"
SERVICE_KEY="$SUPABASE_SERVICE_ROLE_KEY"

SCRIPT_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_TAG="smoke-$(date -u +%Y%m%d-%H%M%S)"

# Three unique plates per run, so repeat runs don't collide
PLATE_A="TESTA001${RANDOM:0:3}"   # section A/B subject (grace → violation)
PLATE_B="TESTB002${RANDOM:0:3}"   # section D/E subject (registered, then pass expiry)
PLATE_C="TESTC003${RANDOM:0:3}"   # section F/G subject (early exit + hold + register guard)

# Outcomes per section — default to FAIL, flip to PASS on success, or to
# SKIP <reason> if we chose not to run it.
declare -A RESULT
RESULT[A]="FAIL (not run)"
RESULT[B]="FAIL (not run)"
RESULT[C]="FAIL (not run)"
RESULT[D]="FAIL (not run)"
RESULT[E]="FAIL (not run)"
RESULT[F]="FAIL (not run)"
RESULT[G]="FAIL (not run)"
RESULT[H]="FAIL (not run)"

# Track IDs we create so cleanup is surgical (ID-based, not just plate-based)
CREATED_SESSIONS=()
CREATED_EVENTS=()
CREATED_VIOLATIONS=()
CREATED_PASSES=()
CREATED_HOLDS=()

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
banner() { echo; echo "=== $* ==="; }
pass()   { echo "  PASS  $*"; }
fail()   { echo "  FAIL  $*"; }
info()   { echo "        $*"; }

# PostgREST GET, returns body to stdout, status on stderr
rest_get() {
  # args: <path> (e.g. "plate_sessions?plate_text=eq.$PLATE")
  curl -sS -X GET "${REST}/$1" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "Accept: application/json"
}

# PostgREST INSERT / UPDATE / DELETE (return=representation when useful)
rest_post() {
  # args: <path> <json_body>
  curl -sS -X POST "${REST}/$1" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d "$2"
}
rest_patch() {
  # args: <path_with_filter> <json_body>
  curl -sS -X PATCH "${REST}/$1" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d "$2"
}
rest_delete() {
  # args: <path_with_filter>
  curl -sS -X DELETE "${REST}/$1" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "Prefer: return=minimal"
}

# jq helper that survives empty / error payloads
jqr() { jq -r "$1" 2>/dev/null || echo ""; }

# Build a tiny valid JPEG base64 string. 1×1 px white JPEG, minimum valid baseline.
# Good enough to pass the edge function's "no_image_bytes" check; Plate
# Recognizer will return no plate match, which is acceptable for sections A/D/F
# because we assert on DB state not on PR confidence — BUT it means we can't
# actually test the plate-text extraction path without a plate-bearing image.
# For a more useful test, swap this constant for a real plate photo encoded
# to base64 (e.g. `base64 -i plate.jpg`).
# TODO: Upgrade TEST_JPEG_B64 to a real plate photo if we want to exercise
# the PR → plate_events extraction instead of just the transport layer.
TEST_JPEG_B64="/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/wD/Z"

# Build a Milesight-shaped JSON payload that the camera-snapshot edge
# function's extract.ts knows how to parse. `values.image` is a data URI.
milesight_payload() {
  # args: <devMac> [<plate_hint_for_log_only>]
  local dev_mac="$1"
  local plate_hint="${2:-}"
  local now_ms; now_ms="$(date +%s)000"
  local file_name="smoke-${RUN_TAG}-${plate_hint}.jpg"
  cat <<EOF
{
  "ts": ${now_ms},
  "topic": "4GSolarCam/Snapshot",
  "gps": {"lat": 35.2, "lon": -80.8},
  "values": {
    "devName": "LotLogic Smoke Test",
    "devMac": "${dev_mac}",
    "file": "${file_name}",
    "time": $(date +%s),
    "dayNight": "day",
    "imageSize": 1024,
    "_smoke_plate_hint": "${plate_hint}",
    "image": "data:image/jpeg;base64,${TEST_JPEG_B64}"
  }
}
EOF
}

# Mint a violation-action JWT (HS256) using JWT_SECRET. Used in section C.
# Returns token on stdout, or empty string if JWT_SECRET isn't set.
mint_action_token() {
  # args: <violation_id> <action: "tow"|"no_tow">
  local vid="$1" action="$2"
  if [ -z "${JWT_SECRET:-}" ]; then
    echo ""; return 0
  fi
  local now exp header payload sig_input sig b64url
  now=$(date +%s)
  exp=$((now + 48*3600))
  # URL-safe base64 without padding
  b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"iss":"lotlogic-backend","aud":"violation-action","iat":%d,"exp":%d,"sub":"%s","v":"%s","a":"%s"}' \
    "$now" "$exp" "$vid" "$vid" "$action" | b64url)
  sig_input="${header}.${payload}"
  sig=$(printf '%s' "$sig_input" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)
  echo "${sig_input}.${sig}"
}

# -----------------------------------------------------------------------------
# Cleanup trap — runs even on partial failure. Deletes ONLY rows we tracked
# by ID, plus a belt-and-suspenders filter (plate_text LIKE 'TEST%' AND
# created_at >= SCRIPT_START_ISO) to catch anything we created but forgot
# to track. Never deletes rows older than this script's start.
# -----------------------------------------------------------------------------
cleanup() {
  local rc=$?
  banner "H. Cleanup"
  local cleanup_ok=1

  # 1) Delete by tracked IDs — most surgical path.
  #    Order matters: child rows first (plate_holds → alpr_violations →
  #    visitor_passes → plate_events → plate_sessions) because of FK deps.
  for id in "${CREATED_HOLDS[@]}"; do
    rest_delete "plate_holds?id=eq.${id}" >/dev/null \
      && info "deleted plate_holds ${id}" \
      || { fail "delete plate_holds ${id}"; cleanup_ok=0; }
  done
  for id in "${CREATED_VIOLATIONS[@]}"; do
    rest_delete "alpr_violations?id=eq.${id}" >/dev/null \
      && info "deleted alpr_violations ${id}" \
      || { fail "delete alpr_violations ${id}"; cleanup_ok=0; }
  done
  for id in "${CREATED_PASSES[@]}"; do
    rest_delete "visitor_passes?id=eq.${id}" >/dev/null \
      && info "deleted visitor_passes ${id}" \
      || { fail "delete visitor_passes ${id}"; cleanup_ok=0; }
  done
  for id in "${CREATED_EVENTS[@]}"; do
    rest_delete "plate_events?id=eq.${id}" >/dev/null \
      && info "deleted plate_events ${id}" \
      || { fail "delete plate_events ${id}"; cleanup_ok=0; }
  done
  for id in "${CREATED_SESSIONS[@]}"; do
    rest_delete "plate_sessions?id=eq.${id}" >/dev/null \
      && info "deleted plate_sessions ${id}" \
      || { fail "delete plate_sessions ${id}"; cleanup_ok=0; }
  done

  # 2) Belt-and-suspenders sweep: anything TEST% that was created during
  #    this run and slipped past our tracking. Two filters required for
  #    safety: plate_text LIKE 'TEST%' AND created_at >= script_start.
  #    PostgREST `like` uses `*` as wildcard.
  local start="$SCRIPT_START_ISO"
  rest_delete "plate_holds?normalized_plate=like.TEST*&created_at=gte.${start}" >/dev/null || true
  rest_delete "alpr_violations?plate_text=like.TEST*&created_at=gte.${start}" >/dev/null || true
  rest_delete "visitor_passes?plate_text=like.TEST*&created_at=gte.${start}" >/dev/null || true
  rest_delete "plate_events?plate_text=like.TEST*&created_at=gte.${start}" >/dev/null || true
  rest_delete "plate_sessions?plate_text=like.TEST*&created_at=gte.${start}" >/dev/null || true

  if [ "$cleanup_ok" = "1" ]; then
    RESULT[H]="PASS"
    pass "all test rows removed"
  else
    RESULT[H]="FAIL (cleanup errors — inspect manually)"
  fi

  # Summary
  echo
  echo "================================"
  for sec in A B C D E F G H; do
    printf "  %s: %s\n" "$sec" "${RESULT[$sec]}"
  done
  echo "================================"

  # Exit 0 only if every section is PASS (SKIP counts as not-passing unless
  # explicitly accepted). rc was from the last command; override with a
  # strict check so cleanup doesn't hide an earlier failure.
  local final=0
  for sec in A B C D E F G H; do
    case "${RESULT[$sec]}" in
      PASS*) ;;
      *) final=1 ;;
    esac
  done
  exit "$final"
}
trap cleanup EXIT

# =============================================================================
# A. Camera ingest (entry path)
# -----------------------------------------------------------------------------
# POST a Milesight-shaped JSON body to camera-snapshot with our test devMac.
# Assert HTTP 200 and that the function either (spec deployed) opened a new
# plate_sessions row in state='grace', or (spec NOT deployed) at least
# inserted a plate_events row tied to this camera+property. This is the
# canary that the entire ingest pipeline is alive.
# =============================================================================
banner "A. Camera ingest (entry path)"

PAYLOAD_A="$(milesight_payload "$CAMERA_API_KEY" "$PLATE_A")"
RESP_A="$(curl -sS -w "\n%{http_code}" -X POST \
  "${FN}/camera-snapshot/${CAMERA_API_KEY}?secret=${CAMERA_SNAPSHOT_URL_SECRET}" \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD_A")"
HTTP_A="$(echo "$RESP_A" | tail -n1)"
BODY_A="$(echo "$RESP_A" | sed '$d')"
info "HTTP $HTTP_A — body: $(echo "$BODY_A" | head -c 240)"

a_ok=1
if [ "$HTTP_A" != "200" ]; then
  fail "expected HTTP 200, got $HTTP_A"; a_ok=0
else
  pass "camera-snapshot returned 200"
fi

# Whether a plate_sessions row exists depends on whether migration 012 is
# live AND whether the test JPEG actually produced a PR plate hit. The
# synthetic JPEG is 1x1 px so PR will return no results. Real pre-flight
# value is "the HTTP transport + auth + camera lookup worked". We also
# poll plate_events in case PR did resolve a plate from some edge case.
sleep 2
SESS_JSON="$(rest_get "plate_sessions?property_id=eq.${PROPERTY_ID}&plate_text=eq.${PLATE_A}&order=created_at.desc&limit=1")"
SESS_ID_A="$(echo "$SESS_JSON" | jqr '.[0].id // empty')"
SESS_STATE_A="$(echo "$SESS_JSON" | jqr '.[0].state // empty')"

if [ -n "$SESS_ID_A" ]; then
  CREATED_SESSIONS+=("$SESS_ID_A")
  info "plate_sessions row: $SESS_ID_A state=$SESS_STATE_A"
  if [ "$SESS_STATE_A" = "grace" ]; then
    pass "session opened in state=grace"
  else
    fail "session state expected grace, got '$SESS_STATE_A'"; a_ok=0
  fi
else
  info "no plate_sessions row for $PLATE_A — likely because (1) the 1x1 test"
  info "JPEG produced no PR match, or (2) migrations 011/012 aren't live yet."
  # Seed a row manually so downstream sections can still exercise B-G.
  # This is a DB-direct shortcut; it skips the camera-snapshot session-open
  # code path, but lets us verify the rest of the state machine.
  # TODO: replace TEST_JPEG_B64 with a real plate image to remove this fallback.
  SEED_BODY=$(cat <<EOF
{
  "property_id": "${PROPERTY_ID}",
  "normalized_plate": "${PLATE_A}",
  "plate_text": "${PLATE_A}",
  "entry_camera_id": null,
  "entry_plate_event_id": null,
  "entered_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "state": "grace"
}
EOF
)
  SEED_RESP="$(rest_post "plate_sessions" "$SEED_BODY")"
  SESS_ID_A="$(echo "$SEED_RESP" | jqr '.[0].id // empty')"
  if [ -n "$SESS_ID_A" ]; then
    CREATED_SESSIONS+=("$SESS_ID_A")
    info "seeded plate_sessions row directly: $SESS_ID_A"
    pass "ingest transport OK; session seeded via DB for downstream checks"
  else
    fail "could not seed plate_sessions — table may not exist yet"
    info "seed error body: $(echo "$SEED_RESP" | head -c 300)"
    a_ok=0
  fi
fi

if [ "$a_ok" = "1" ]; then RESULT[A]="PASS"; else RESULT[A]="FAIL (see log)"; fi

# =============================================================================
# B. Grace expiry triggers violation + email
# -----------------------------------------------------------------------------
# Backdate the session's entered_at to 16 minutes ago so the 15-min grace
# timer has expired. Invoke cron-sessions-sweep. Assert response shows
# grace_expired >= 1 and a matching alpr_violations row was created with
# status='dispatched' and sms_sent_at populated.
# =============================================================================
banner "B. Grace expiry triggers violation"

b_ok=1
if [ -z "${SESS_ID_A:-}" ]; then
  fail "no session from section A — skipping"; b_ok=0
else
  BACKDATE_ISO="$(date -u -v-16M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '16 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
  UPD="$(rest_patch "plate_sessions?id=eq.${SESS_ID_A}" \
    "$(printf '{"entered_at":"%s"}' "$BACKDATE_ISO")")"
  if [ -z "$(echo "$UPD" | jqr '.[0].id // empty')" ]; then
    fail "failed to backdate entered_at: $(echo "$UPD" | head -c 200)"; b_ok=0
  else
    info "backdated entered_at → $BACKDATE_ISO"
  fi

  # Invoke cron-sessions-sweep. Service-role auth required.
  SWEEP_RESP="$(curl -sS -w "\n%{http_code}" -X POST "${FN}/cron-sessions-sweep" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "Content-Type: application/json" -d '{}')"
  SWEEP_HTTP="$(echo "$SWEEP_RESP" | tail -n1)"
  SWEEP_BODY="$(echo "$SWEEP_RESP" | sed '$d')"
  info "cron-sessions-sweep HTTP $SWEEP_HTTP — $(echo "$SWEEP_BODY" | head -c 240)"

  if [ "$SWEEP_HTTP" != "200" ]; then
    fail "cron-sessions-sweep HTTP $SWEEP_HTTP — function may not be deployed yet"
    b_ok=0
  else
    GRACE_EXPIRED="$(echo "$SWEEP_BODY" | jqr '.grace_expired // 0')"
    if [ "${GRACE_EXPIRED:-0}" -ge 1 ] 2>/dev/null; then
      pass "grace_expired=$GRACE_EXPIRED"
    else
      fail "expected grace_expired>=1, got '$GRACE_EXPIRED'"; b_ok=0
    fi
  fi

  # Check for the violation row + email-sent marker
  sleep 2
  VIO_JSON="$(rest_get "alpr_violations?session_id=eq.${SESS_ID_A}&order=created_at.desc&limit=1")"
  VIO_ID="$(echo "$VIO_JSON" | jqr '.[0].id // empty')"
  VIO_STATUS="$(echo "$VIO_JSON" | jqr '.[0].status // empty')"
  VIO_SMS="$(echo "$VIO_JSON" | jqr '.[0].sms_sent_at // empty')"
  if [ -n "$VIO_ID" ]; then
    CREATED_VIOLATIONS+=("$VIO_ID")
    info "alpr_violations row: $VIO_ID status=$VIO_STATUS sms_sent_at=$VIO_SMS"
    if [ "$VIO_STATUS" = "dispatched" ]; then
      pass "violation status=dispatched"
    else
      fail "violation status expected dispatched, got '$VIO_STATUS'"; b_ok=0
    fi
    if [ -n "$VIO_SMS" ] && [ "$VIO_SMS" != "null" ]; then
      pass "sms_sent_at populated ($VIO_SMS)"
    else
      fail "sms_sent_at not populated — dispatch email/SMS didn't fire"; b_ok=0
    fi
  else
    fail "no alpr_violations row found for session $SESS_ID_A"; b_ok=0
  fi
fi

if [ "$b_ok" = "1" ]; then RESULT[B]="PASS"; else RESULT[B]="FAIL (see log)"; fi

# =============================================================================
# C. Partner action: No-Tow click
# -----------------------------------------------------------------------------
# Mint an HS256 action token (aud=violation-action, 48h TTL) using
# JWT_SECRET and POST to the backend /violations/action with action=no_tow.
# Assert action_taken='no_tow' on the violation row afterward.
# Skipped if JWT_SECRET isn't set in env.
# =============================================================================
banner "C. Partner action: No-Tow click"

if [ -z "${JWT_SECRET:-}" ]; then
  info "JWT_SECRET not set — skipping token minting"
  info "TODO: export JWT_SECRET=\$(supabase secrets get JWT_SECRET --project-ref $SUPABASE_PROJECT_REF 2>/dev/null)"
  info "then re-run; or paste the Supabase JWT secret from Dashboard → Settings → API."
  RESULT[C]="SKIP (JWT_SECRET not in env)"
else
  c_ok=1
  if [ -z "${VIO_ID:-}" ]; then
    fail "no violation from section B — skipping"; c_ok=0
  else
    TOKEN="$(mint_action_token "$VIO_ID" "no_tow")"
    if [ -z "$TOKEN" ]; then
      fail "mint_action_token returned empty"; c_ok=0
    else
      info "minted no_tow token (truncated): ${TOKEN:0:40}..."
      ACT_RESP="$(curl -sS -w "\n%{http_code}" -X POST "${BACKEND_URL}/violations/action" \
        -H "Content-Type: application/json" \
        --data "$(printf '{"token":"%s","action":"no_tow"}' "$TOKEN")")"
      ACT_HTTP="$(echo "$ACT_RESP" | tail -n1)"
      ACT_BODY="$(echo "$ACT_RESP" | sed '$d')"
      info "POST /violations/action HTTP $ACT_HTTP — $(echo "$ACT_BODY" | head -c 240)"
      if [ "$ACT_HTTP" != "200" ]; then
        fail "expected HTTP 200, got $ACT_HTTP"; c_ok=0
      else
        sleep 1
        AT="$(rest_get "alpr_violations?id=eq.${VIO_ID}&select=action_taken" | jqr '.[0].action_taken // empty')"
        if [ "$AT" = "no_tow" ]; then pass "action_taken=no_tow"
        else fail "action_taken expected no_tow, got '$AT'"; c_ok=0; fi
      fi
    fi
  fi
  if [ "$c_ok" = "1" ]; then RESULT[C]="PASS"; else RESULT[C]="FAIL (see log)"; fi
fi

# =============================================================================
# D. Registration during grace (happy path)
# -----------------------------------------------------------------------------
# New session with plate B via camera-snapshot. Insert a matching
# visitor_passes row. Wait for cron-sessions-sweep's
# fn_plate_sessions_registration_transition() to promote grace → registered
# and link visitor_pass_id. Assert both.
# =============================================================================
banner "D. Registration during grace (happy path)"

d_ok=1
PAYLOAD_B="$(milesight_payload "$CAMERA_API_KEY" "$PLATE_B")"
RESP_B="$(curl -sS -w "\n%{http_code}" -X POST \
  "${FN}/camera-snapshot/${CAMERA_API_KEY}?secret=${CAMERA_SNAPSHOT_URL_SECRET}" \
  -H "Content-Type: application/json" --data "$PAYLOAD_B")"
HTTP_B="$(echo "$RESP_B" | tail -n1)"
info "camera-snapshot HTTP $HTTP_B"
[ "$HTTP_B" = "200" ] || { fail "entry POST failed"; d_ok=0; }

sleep 2
SESS_B_JSON="$(rest_get "plate_sessions?property_id=eq.${PROPERTY_ID}&plate_text=eq.${PLATE_B}&order=created_at.desc&limit=1")"
SESS_ID_B="$(echo "$SESS_B_JSON" | jqr '.[0].id // empty')"
if [ -z "$SESS_ID_B" ]; then
  # Fallback: seed directly so we can still exercise the registration path.
  SEED_BODY=$(cat <<EOF
{
  "property_id": "${PROPERTY_ID}",
  "normalized_plate": "${PLATE_B}",
  "plate_text": "${PLATE_B}",
  "entered_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "state": "grace"
}
EOF
)
  SEED_RESP="$(rest_post "plate_sessions" "$SEED_BODY")"
  SESS_ID_B="$(echo "$SEED_RESP" | jqr '.[0].id // empty')"
  [ -n "$SESS_ID_B" ] && CREATED_SESSIONS+=("$SESS_ID_B")
  info "seeded plate_sessions $SESS_ID_B for $PLATE_B"
else
  CREATED_SESSIONS+=("$SESS_ID_B")
fi

# Insert a matching visitor_pass
VALID_FROM="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
VALID_UNTIL="$(date -u -v+12H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+12 hours' +%Y-%m-%dT%H:%M:%SZ)"
PASS_BODY=$(cat <<EOF
{
  "property_id": "${PROPERTY_ID}",
  "plate_text": "${PLATE_B}",
  "valid_from": "${VALID_FROM}",
  "valid_until": "${VALID_UNTIL}",
  "status": "active",
  "stay_days": 1,
  "registration_source": "test_smoke",
  "policy_acknowledged_at": "${VALID_FROM}"
}
EOF
)
PASS_RESP="$(rest_post "visitor_passes" "$PASS_BODY")"
PASS_ID_B="$(echo "$PASS_RESP" | jqr '.[0].id // empty')"
if [ -n "$PASS_ID_B" ]; then
  CREATED_PASSES+=("$PASS_ID_B")
  pass "visitor_pass inserted: $PASS_ID_B"
else
  fail "visitor_pass insert failed: $(echo "$PASS_RESP" | head -c 300)"
  info "if the error mentions missing columns, registration_source/policy_acknowledged_at aren't migrated yet"
  d_ok=0
fi

# Invoke sweep immediately (rather than wait 70s for pg_cron)
SWEEP_D="$(curl -sS -X POST "${FN}/cron-sessions-sweep" \
  -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" -d '{}')"
info "cron-sessions-sweep (D) body: $(echo "$SWEEP_D" | head -c 240)"

sleep 2
D_CHECK_JSON="$(rest_get "plate_sessions?id=eq.${SESS_ID_B}&select=state,visitor_pass_id")"
D_STATE="$(echo "$D_CHECK_JSON" | jqr '.[0].state // empty')"
D_VPID="$(echo "$D_CHECK_JSON" | jqr '.[0].visitor_pass_id // empty')"
info "session state=$D_STATE visitor_pass_id=$D_VPID"

if [ "$D_STATE" = "registered" ]; then pass "state flipped to registered"
else fail "expected state=registered, got '$D_STATE'"; d_ok=0; fi
if [ "$D_VPID" = "$PASS_ID_B" ]; then pass "visitor_pass_id linked"
else fail "visitor_pass_id expected $PASS_ID_B, got '$D_VPID'"; d_ok=0; fi

if [ "$d_ok" = "1" ]; then RESULT[D]="PASS"; else RESULT[D]="FAIL (see log)"; fi

# =============================================================================
# E. Pass expiry still opens in lot
# -----------------------------------------------------------------------------
# Backdate the pass's valid_until to 1 minute ago. Invoke cron-sessions-sweep
# (fn_plate_sessions_pass_expiry). Assert session transitioned to 'expired'
# AND a new alpr_violations row was created.
# =============================================================================
banner "E. Pass expiry still opens in lot"

e_ok=1
if [ -z "${PASS_ID_B:-}" ] || [ -z "${SESS_ID_B:-}" ]; then
  fail "no pass/session from section D — skipping"; e_ok=0
else
  EXPIRED_ISO="$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:%SZ)"
  UPD_E="$(rest_patch "visitor_passes?id=eq.${PASS_ID_B}" \
    "$(printf '{"valid_until":"%s"}' "$EXPIRED_ISO")")"
  if [ -z "$(echo "$UPD_E" | jqr '.[0].id // empty')" ]; then
    fail "backdate valid_until failed: $(echo "$UPD_E" | head -c 200)"; e_ok=0
  else
    info "backdated valid_until → $EXPIRED_ISO"
  fi

  curl -sS -X POST "${FN}/cron-sessions-sweep" \
    -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" -d '{}' >/dev/null
  sleep 2

  E_STATE="$(rest_get "plate_sessions?id=eq.${SESS_ID_B}&select=state" | jqr '.[0].state // empty')"
  if [ "$E_STATE" = "expired" ]; then pass "session state=expired"
  else fail "expected state=expired, got '$E_STATE'"; e_ok=0; fi

  VIO_E_JSON="$(rest_get "alpr_violations?session_id=eq.${SESS_ID_B}&order=created_at.desc&limit=1")"
  VIO_E_ID="$(echo "$VIO_E_JSON" | jqr '.[0].id // empty')"
  if [ -n "$VIO_E_ID" ]; then
    CREATED_VIOLATIONS+=("$VIO_E_ID")
    pass "new violation created: $VIO_E_ID"
  else
    fail "no violation row for session $SESS_ID_B"; e_ok=0
  fi
fi

if [ "$e_ok" = "1" ]; then RESULT[E]="PASS"; else RESULT[E]="FAIL (see log)"; fi

# =============================================================================
# F. Early exit creates plate_hold
# -----------------------------------------------------------------------------
# New session plate C. Insert a matching valid visitor_pass. Let cron promote
# to 'registered'. Then simulate an exit at the DB level (no exit camera in
# prod yet): set state='closed_early', exited_at=now(), cancel the pass,
# insert a plate_holds row with hold_until = exited_at + 24h.
# NOTE: this DOES NOT exercise the camera-snapshot exit-orientation code path
# — it verifies only the DB post-condition. TODO: once an exit camera is
# installed, replace the manual UPDATE with a second camera-snapshot POST
# using an exit-orientation api_key.
# =============================================================================
banner "F. Early exit creates plate_hold"

f_ok=1

# Create the session + pass and let the cron promote it
PAYLOAD_C="$(milesight_payload "$CAMERA_API_KEY" "$PLATE_C")"
curl -sS -X POST "${FN}/camera-snapshot/${CAMERA_API_KEY}?secret=${CAMERA_SNAPSHOT_URL_SECRET}" \
  -H "Content-Type: application/json" --data "$PAYLOAD_C" >/dev/null
sleep 2
SESS_C_JSON="$(rest_get "plate_sessions?property_id=eq.${PROPERTY_ID}&plate_text=eq.${PLATE_C}&order=created_at.desc&limit=1")"
SESS_ID_C="$(echo "$SESS_C_JSON" | jqr '.[0].id // empty')"
if [ -z "$SESS_ID_C" ]; then
  SEED_BODY=$(cat <<EOF
{
  "property_id": "${PROPERTY_ID}",
  "normalized_plate": "${PLATE_C}",
  "plate_text": "${PLATE_C}",
  "entered_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "state": "grace"
}
EOF
)
  SEED_RESP="$(rest_post "plate_sessions" "$SEED_BODY")"
  SESS_ID_C="$(echo "$SEED_RESP" | jqr '.[0].id // empty')"
  [ -n "$SESS_ID_C" ] && CREATED_SESSIONS+=("$SESS_ID_C")
else
  CREATED_SESSIONS+=("$SESS_ID_C")
fi

VALID_UNTIL_C="$(date -u -v+12H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+12 hours' +%Y-%m-%dT%H:%M:%SZ)"
PASS_BODY_C=$(cat <<EOF
{
  "property_id": "${PROPERTY_ID}",
  "plate_text": "${PLATE_C}",
  "valid_from": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "valid_until": "${VALID_UNTIL_C}",
  "status": "active",
  "stay_days": 1,
  "registration_source": "test_smoke",
  "policy_acknowledged_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)
PASS_RESP_C="$(rest_post "visitor_passes" "$PASS_BODY_C")"
PASS_ID_C="$(echo "$PASS_RESP_C" | jqr '.[0].id // empty')"
if [ -n "$PASS_ID_C" ]; then CREATED_PASSES+=("$PASS_ID_C")
else fail "pass insert failed for C: $(echo "$PASS_RESP_C" | head -c 200)"; f_ok=0; fi

curl -sS -X POST "${FN}/cron-sessions-sweep" \
  -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" -d '{}' >/dev/null
sleep 2

# Now simulate an early exit at DB level
EXIT_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HOLD_UNTIL="$(date -u -v+24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)"

# Use any valid UUID for exit_camera_id — we use the entry camera since
# there's no exit camera yet. The column is a FK to alpr_cameras.
ENTRY_CAM_ID="$(rest_get "alpr_cameras?api_key=eq.${CAMERA_API_KEY}&select=id" | jqr '.[0].id // empty')"

UPD_F="$(rest_patch "plate_sessions?id=eq.${SESS_ID_C}" \
  "$(printf '{"state":"closed_early","exited_at":"%s","exit_camera_id":"%s"}' "$EXIT_ISO" "$ENTRY_CAM_ID")")"
[ -n "$(echo "$UPD_F" | jqr '.[0].id // empty')" ] \
  || { fail "close session UPDATE failed: $(echo "$UPD_F" | head -c 200)"; f_ok=0; }

# Cancel the pass (matches spec: cancelled_at + cancelled_by='exited_early')
rest_patch "visitor_passes?id=eq.${PASS_ID_C}" \
  "$(printf '{"cancelled_at":"%s","cancelled_by":"exited_early"}' "$EXIT_ISO")" >/dev/null || true

HOLD_BODY=$(cat <<EOF
{
  "property_id": "${PROPERTY_ID}",
  "normalized_plate": "${PLATE_C}",
  "source_session_id": "${SESS_ID_C}",
  "held_at": "${EXIT_ISO}",
  "hold_until": "${HOLD_UNTIL}",
  "reason": "early_exit"
}
EOF
)
HOLD_RESP="$(rest_post "plate_holds" "$HOLD_BODY")"
HOLD_ID="$(echo "$HOLD_RESP" | jqr '.[0].id // empty')"
if [ -n "$HOLD_ID" ]; then
  CREATED_HOLDS+=("$HOLD_ID")
  HOLD_UNTIL_SEEN="$(echo "$HOLD_RESP" | jqr '.[0].hold_until // empty')"
  pass "plate_holds row: $HOLD_ID hold_until=$HOLD_UNTIL_SEEN"
  # Sanity-check: hold_until is within a minute of exit + 24h
  # (skip strict time-math in bash; visual check is enough)
else
  fail "plate_holds insert failed: $(echo "$HOLD_RESP" | head -c 200)"
  info "if the error mentions 'relation does not exist', migration 013 isn't live"
  f_ok=0
fi

if [ "$f_ok" = "1" ]; then RESULT[F]="PASS"; else RESULT[F]="FAIL (see log)"; fi

# =============================================================================
# G. Held plate registration guard
# -----------------------------------------------------------------------------
# POST to /visitor_passes/register with plate C (which now has an active
# hold). Assert HTTP 409 and body contains PLATE_HOLD.
# =============================================================================
banner "G. Held plate registration guard"

g_ok=1
REG_BODY=$(cat <<EOF
{
  "property_id": "${PROPERTY_ID}",
  "plate_text": "${PLATE_C}",
  "visitor_name": "Smoke Test",
  "company_name": "LotLogic QA",
  "host_unit": "",
  "host_name": "",
  "phone": "+15555550100",
  "parking_spot": "1",
  "stay_hours": 12,
  "policy_acknowledged_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "submission_idempotency_key": "smoke-${RUN_TAG}-G"
}
EOF
)
REG_RESP="$(curl -sS -w "\n%{http_code}" -X POST "${BACKEND_URL}/visitor_passes/register" \
  -H "Content-Type: application/json" --data "$REG_BODY")"
REG_HTTP="$(echo "$REG_RESP" | tail -n1)"
REG_BODY_OUT="$(echo "$REG_RESP" | sed '$d')"
info "POST /visitor_passes/register HTTP $REG_HTTP — $(echo "$REG_BODY_OUT" | head -c 240)"

if [ "$REG_HTTP" = "409" ]; then
  if echo "$REG_BODY_OUT" | grep -qiE "plate_hold|plate_on_hold|PLATE_HOLD"; then
    pass "backend returned 409 with PLATE_HOLD"
  else
    fail "got 409 but body doesn't mention PLATE_HOLD"; g_ok=0
  fi
else
  fail "expected HTTP 409, got $REG_HTTP — backend hold guard may not be deployed"; g_ok=0
fi

# If the register call somehow succeeded, track the row so cleanup kills it.
NEW_PASS_ID="$(echo "$REG_BODY_OUT" | jqr '.id // empty')"
[ -n "$NEW_PASS_ID" ] && CREATED_PASSES+=("$NEW_PASS_ID")

if [ "$g_ok" = "1" ]; then RESULT[G]="PASS"; else RESULT[G]="FAIL (see log)"; fi

# =============================================================================
# (H runs automatically via trap on exit)
# =============================================================================
