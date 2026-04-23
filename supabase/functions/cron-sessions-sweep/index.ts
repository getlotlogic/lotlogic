// Every minute (scheduled via pg_cron -> net.http_post), this function
// walks the plate_sessions state machine forward. Execution order matters:
//
//   1. registrationTransition — grace sessions that got a matching pass
//      become 'registered' first (so they don't get picked up by grace
//      expiry in the same run).
//   2. graceExpiry — grace sessions older than 15 min with no pass →
//      'expired' + violation + email.
//   3. overstayExpiry — registered sessions whose pass expired more than
//      OVERSTAY_GRACE_MINUTES ago → 'expired' + violation + email.
//   4. closeRegistered — registered sessions with exit_hinted_at set (fast
//      path, EXIT_HINT_BUFFER_MINUTES buffer) OR pass expired + 2h +
//      no recent detections (slow path) → close + 24h cooldown hold.
//   5. closeExpired — expired sessions whose violation is resolved or tow
//      confirmed → close + 24h cooldown hold.
//
// This function is idempotent: running it twice in the same second is
// harmless because each transition's SELECT filters by current state.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Tuning knobs (env-overridable).
const OVERSTAY_GRACE_MINUTES = Number(Deno.env.get("OVERSTAY_GRACE_MINUTES") ?? "5");
const CLOSE_BUFFER_HOURS = Number(Deno.env.get("CLOSE_BUFFER_HOURS") ?? "2");
const EXIT_HINT_BUFFER_MINUTES = Number(Deno.env.get("EXIT_HINT_BUFFER_MINUTES") ?? "5");
const COOLDOWN_HOURS = Number(Deno.env.get("COOLDOWN_HOURS") ?? "24");

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (_req: Request) => {
  const started = Date.now();
  try {
    const promoted = await registrationTransition();
    const graceExpired = await graceExpiry();
    const overstayExpired = await overstayExpiry();
    const closedRegistered = await closeRegistered();
    const closedResident = await closeResident();
    const closedExpired = await closeExpired();

    return json(200, {
      ok: true,
      promoted,
      grace_expired: graceExpired,
      overstay_expired: overstayExpired,
      closed_registered: closedRegistered,
      closed_resident: closedResident,
      closed_expired: closedExpired,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    console.error("cron-sessions-sweep error:", err instanceof Error ? err.stack ?? err.message : err);
    return json(500, { ok: false, error: String(err) });
  }
});

async function registrationTransition(): Promise<number> {
  // Find grace sessions that now have a matching active visitor_pass.
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, property_id, normalized_plate")
    .eq("state", "grace")
    .is("exited_at", null);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let promoted = 0;
  const nowIso = new Date().toISOString();

  for (const s of sessions) {
    const { data: passes, error: pErr } = await db
      .from("visitor_passes")
      .select("id, plate_text, valid_from, valid_until, cancelled_at")
      .eq("property_id", s.property_id)
      .is("cancelled_at", null);
    if (pErr) throw pErr;

    const match = (passes ?? []).find((p: { plate_text?: string; valid_from?: string; valid_until?: string }) => {
      const norm = String(p.plate_text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (norm !== s.normalized_plate) return false;
      if (p.valid_from && new Date(p.valid_from) > new Date()) return false;
      if (!p.valid_until || new Date(p.valid_until) <= new Date()) return false;
      return true;
    });
    if (!match) continue;

    const { error: uErr } = await db
      .from("plate_sessions")
      .update({ state: "registered", visitor_pass_id: match.id, updated_at: nowIso })
      .eq("id", s.id)
      .eq("state", "grace");
    if (uErr) throw uErr;
    promoted++;
  }
  return promoted;
}

async function graceExpiry(): Promise<number> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, property_id, plate_text, entry_plate_event_id")
    .eq("state", "grace")
    .is("exited_at", null)
    .lt("entered_at", cutoff);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let n = 0;
  for (const s of sessions) {
    await createViolationAndDispatch(s.property_id, s.plate_text, s.entry_plate_event_id, s.id, "grace");
    n++;
  }
  return n;
}

// NEW — registered session + pass expired > OVERSTAY_GRACE_MINUTES ago =
// overstay violation. Fires regardless of detection silence; the whole point
// is to catch silent parked overstayers. Retrospective left_before_tow
// flagging handles the edge case of a truck that silently left on time.
async function overstayExpiry(): Promise<number> {
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, property_id, plate_text, entry_plate_event_id, visitor_pass_id")
    .eq("state", "registered")
    .is("exited_at", null);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let n = 0;
  const graceCutoffMs = Date.now() - OVERSTAY_GRACE_MINUTES * 60 * 1000;
  for (const s of sessions) {
    if (!s.visitor_pass_id) continue;
    const { data: pass, error: pErr } = await db
      .from("visitor_passes")
      .select("valid_until")
      .eq("id", s.visitor_pass_id)
      .single();
    if (pErr) throw pErr;
    if (!pass?.valid_until) continue;
    if (new Date(pass.valid_until).getTime() >= graceCutoffMs) continue;

    await createViolationAndDispatch(s.property_id, s.plate_text, s.entry_plate_event_id, s.id, "registered");
    n++;
  }
  return n;
}

// NEW — close registered sessions whose pass expired AND are likely gone.
// Fast path: exit_hinted_at set > EXIT_HINT_BUFFER_MINUTES ago (cross-camera
// timing inferred the truck was exiting; give them a few minutes to clear
// the lot, then close).
// Slow path: pass expired > CLOSE_BUFFER_HOURS ago AND no hint (fallback —
// assume they left silently within the buffer).
async function closeRegistered(): Promise<number> {
  const nowMs = Date.now();
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, property_id, normalized_plate, last_detected_at, exit_hinted_at, visitor_pass_id")
    .eq("state", "registered")
    .is("exited_at", null);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let closed = 0;
  for (const s of sessions) {
    if (!s.visitor_pass_id) continue;
    const { data: pass, error: pErr } = await db
      .from("visitor_passes")
      .select("valid_until")
      .eq("id", s.visitor_pass_id)
      .single();
    if (pErr) throw pErr;
    if (!pass?.valid_until) continue;

    const validUntilMs = new Date(pass.valid_until).getTime();
    const fastPath = s.exit_hinted_at &&
      nowMs - new Date(s.exit_hinted_at).getTime() > EXIT_HINT_BUFFER_MINUTES * 60 * 1000;
    const slowPath = nowMs - validUntilMs > CLOSE_BUFFER_HOURS * 60 * 60 * 1000;

    if (!fastPath && !slowPath) continue;

    // Close the session. exited_at = best estimate of physical exit:
    // - fast path: exit_hinted_at is when silence-gap or depth-pair
    //   inferred the truck crossed the throat again → real exit time.
    // - slow path: we never detected an exit. last_detected_at could be
    //   days stale (truck parked silently for its whole stay), which
    //   would make a (last_detected_at + 24h) cooldown already expired
    //   by the time we write it. Use close-time instead so the 24h hold
    //   runs from the moment we decide the truck is gone. Slightly
    //   conservative vs. pass expiry, but never in-the-past.
    const exitedAt = s.exit_hinted_at ?? new Date().toISOString();
    const sUpd = await db.from("plate_sessions")
      .update({
        state: "closed_clean",
        exited_at: exitedAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", s.id);
    if (sUpd.error) throw sUpd.error;

    // 24h cooldown hold from the exit time.
    const holdUntil = new Date(new Date(exitedAt).getTime() + COOLDOWN_HOURS * 60 * 60 * 1000);
    const hIns = await db.from("plate_holds").insert({
      property_id: s.property_id,
      normalized_plate: s.normalized_plate,
      source_session_id: s.id,
      held_at: new Date().toISOString(),
      hold_until: holdUntil.toISOString(),
      reason: "post_visit_cooldown",
    });
    // Throw on insert failure — session already closed; silent failure here
    // would leave the truck free to return immediately with no cooldown.
    if (hIns.error) throw hIns.error;

    console.log(`close_registered session=${s.id} path=${fastPath ? "hint" : "buffer"} exited_at=${exitedAt}`);
    closed++;
  }
  return closed;
}

// NEW — close resident sessions (permanent allowlisted plates) when
// silence-gap set exit_hinted_at 5+ min ago. Residents come and go
// freely; their one open session represents "currently on property."
// At properties without an orientation='exit' camera, applyExitOutcome
// never fires, so resident sessions would otherwise accumulate forever.
// No cooldown hold inserted — residents aren't subject to the 24h
// between-visits policy (that's a visitor-only guardrail).
async function closeResident(): Promise<number> {
  const nowMs = Date.now();
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, last_detected_at, exit_hinted_at")
    .eq("state", "resident")
    .is("exited_at", null)
    .not("exit_hinted_at", "is", null);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let closed = 0;
  for (const s of sessions) {
    if (!s.exit_hinted_at) continue;
    const hintMs = new Date(s.exit_hinted_at).getTime();
    if (nowMs - hintMs <= EXIT_HINT_BUFFER_MINUTES * 60 * 1000) continue;

    const exitedAt = s.exit_hinted_at;
    const sUpd = await db.from("plate_sessions")
      .update({
        state: "closed_clean",
        exited_at: exitedAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", s.id);
    if (sUpd.error) throw sUpd.error;

    console.log(`close_resident session=${s.id} exited_at=${exitedAt}`);
    closed++;
  }
  return closed;
}

// NEW — close expired (violation-active) sessions when the violation is
// resolved (tow confirmed OR manually resolved/dismissed). Creates a 24h
// cooldown hold — abuse patterns apply here too.
async function closeExpired(): Promise<number> {
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, property_id, normalized_plate, last_detected_at, violation_id")
    .eq("state", "expired")
    .is("exited_at", null);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let closed = 0;
  for (const s of sessions) {
    if (!s.violation_id) continue;
    const { data: v, error: vErr } = await db
      .from("alpr_violations")
      .select("status, tow_confirmed_at")
      .eq("id", s.violation_id)
      .single();
    if (vErr) throw vErr;
    if (!v) continue;

    const resolved = v.tow_confirmed_at !== null ||
      (v.status && ["resolved", "dismissed", "no_tow"].includes(v.status));
    if (!resolved) continue;

    // Same null-fallback as closeRegistered. last_detected_at can be null
    // on older sessions (pre-migration-018 inserts) — if we pass null into
    // new Date() we get epoch (1970), which creates an already-expired
    // 24h hold that doesn't actually block anything.
    const exitedAt = s.last_detected_at ?? new Date().toISOString();
    const sUpd = await db.from("plate_sessions")
      .update({
        state: v.tow_confirmed_at ? "closed_post_violation" : "closed_clean",
        exited_at: exitedAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", s.id)
      .eq("state", "expired");
    if (sUpd.error) throw sUpd.error;

    const holdUntil = new Date(new Date(exitedAt).getTime() + COOLDOWN_HOURS * 60 * 60 * 1000);
    const hIns = await db.from("plate_holds").insert({
      property_id: s.property_id,
      normalized_plate: s.normalized_plate,
      source_session_id: s.id,
      held_at: new Date().toISOString(),
      hold_until: holdUntil.toISOString(),
      reason: "post_visit_cooldown",
    });
    // Throw, don't warn — a silent insert failure means the session was
    // closed with NO cooldown enforcement, which is worse than failing loud.
    if (hIns.error) throw hIns.error;

    closed++;
  }
  return closed;
}

async function createViolationAndDispatch(
  propertyId: string,
  plateText: string,
  entryPlateEventId: string,
  sessionId: string,
  expectedState: "grace" | "registered",
): Promise<void> {
  // Guard against a concurrent cron tick having already transitioned this
  // session. Try to claim the transition first via a conditional UPDATE;
  // only if the claim succeeds do we insert the violation + dispatch email.
  // This prevents the race where graceExpiry/overstayExpiry both pick up
  // the same session during a slow SendGrid roundtrip (2-5s) and produce
  // duplicate violations + duplicate partner emails.
  const claim = await db
    .from("plate_sessions")
    .update({ state: "expired", updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("state", expectedState)
    .is("exited_at", null)
    .select("id");
  if (claim.error) throw claim.error;
  if (!claim.data || claim.data.length === 0) {
    console.log(`createViolationAndDispatch: session ${sessionId} no longer in state=${expectedState}, skipping (another cron tick won the race)`);
    return;
  }

  const vIns = await db
    .from("alpr_violations")
    .insert({
      property_id: propertyId,
      plate_event_id: entryPlateEventId,
      plate_text: plateText,
      status: "pending",
      violation_type: "alpr_unmatched",
      session_id: sessionId,
    })
    .select("id")
    .single();
  if (vIns.error) throw vIns.error;
  const violationId = vIns.data.id;

  const sUpd = await db
    .from("plate_sessions")
    .update({ violation_id: violationId, updated_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (sUpd.error) throw sUpd.error;

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/tow-dispatch-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ violation_id: violationId }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`tow-dispatch-email ${res.status} for ${violationId}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`tow-dispatch-email fetch failed for ${violationId}: ${String(err)}`);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
