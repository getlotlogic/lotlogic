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
//   4. closeRegistered — registered sessions with exit_hinted_at set
//      (EXIT_HINT_BUFFER_MINUTES buffer) → close + 24h cooldown hold.
//      Silence-based slow-path removed 2026-05-12 — sessions only close
//      via camera-detected exit.
//   5. closeExpired — expired sessions whose violation is resolved or tow
//      confirmed → close + 24h cooldown hold.
//
// This function is idempotent: running it twice in the same second is
// harmless because each transition's SELECT filters by current state.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { findStaleGroups, flushGroup } from "../camera-snapshot/weak_plate_reads.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Tuning knobs (env-overridable).
const OVERSTAY_GRACE_MINUTES = Number(Deno.env.get("OVERSTAY_GRACE_MINUTES") ?? "5");
const EXIT_HINT_BUFFER_MINUTES = Number(Deno.env.get("EXIT_HINT_BUFFER_MINUTES") ?? "5");
const COOLDOWN_HOURS = Number(Deno.env.get("COOLDOWN_HOURS") ?? "24");
// Grace window — how long an unregistered plate has after entry to scan
// the QR and register. After this window with no match, the session is
// thrown away (closed_clean, no violation). The registered-only model
// means we never fire violations on unregistered plates — they're noise
// we discard.
const GRACE_EXPIRY_MINUTES = Number(Deno.env.get("GRACE_EXPIRY_MINUTES") ?? "15");

// PRESENCE_EVIDENCE_MINUTES + MIN_DWELL_SECONDS removed 2026-04-29 in
// PR #161 — gate-only properties (Charlotte) can never satisfy the
// 2-cameras-or-5-min-span rule because cameras don't see parked trucks.
// graceExpiry now relies on exit_hinted_at as the only "they left"
// signal; the rest is "any read + 30 min grace = violation".

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Global kill switch. Mirrors camera-snapshot's SYSTEM_PAUSED. When true,
// the sweep no-ops so we don't accidentally close sessions or fire
// violations while the camera ingest is paused.
const SYSTEM_PAUSED = (Deno.env.get("SYSTEM_PAUSED") ?? "false").toLowerCase() === "true";

Deno.serve(async (_req: Request) => {
  const started = Date.now();
  if (SYSTEM_PAUSED) return json(200, { ok: true, paused: true });
  try {
    const promoted = await registrationTransition();
    const grace = await graceExpiry();
    const overstayExpired = await overstayExpiry();
    const passOverstay = await sweepUnexitedPassesForOverstay();
    const weakReads = await sweepWeakPlateReads();
    const dispatch = await dispatchPendingViolations();
    const closedRegistered = await closeRegistered();
    const closedResident = await closeResident();
    const closedExpired = await closeExpired();

    return json(200, {
      ok: true,
      promoted,
      grace_thrown_away: grace.thrown_away,
      overstay_expired: overstayExpired,
      pass_overstay_fired: passOverstay,
      weak_reads_flushed: weakReads,
      dispatched: dispatch.dispatched,
      auto_no_tow_left_before_tow: dispatch.left_before_tow,
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

// Grace expiry. Under the registered-only model: a plate that's been in
// `grace` for GRACE_EXPIRY_MINUTES without matching a pass/resident is
// thrown away — closed_clean, NO violation. The driver had their chance
// to scan the QR; we discard the data and never act on them. Used to
// fire a violation in the old apartment-style model; that branch is gone.
async function graceExpiry(): Promise<{ thrown_away: number }> {
  const cutoff = new Date(Date.now() - GRACE_EXPIRY_MINUTES * 60 * 1000).toISOString();
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, last_detected_at, entered_at")
    .eq("state", "grace")
    .is("exited_at", null)
    .lt("entered_at", cutoff);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return { thrown_away: 0 };

  let thrownAway = 0;
  const nowIso = new Date().toISOString();
  for (const s of sessions) {
    // exited_at = last_detected_at when we have one, else entered_at —
    // never `now`, because `now` is when the cron fired, not when the
    // truck was actually here.
    const exitedAt = s.last_detected_at ?? s.entered_at;
    const upd = await db.from("plate_sessions")
      .update({ state: "closed_clean", exited_at: exitedAt, updated_at: nowIso })
      .eq("id", s.id)
      .eq("state", "grace");
    if (upd.error) throw upd.error;
    thrownAway++;
  }
  return { thrown_away: thrownAway };
}

// NEW — registered session + pass expired > OVERSTAY_GRACE_MINUTES ago =
// overstay violation. Skips sessions where an exit camera has already seen
// the truck heading out (exit_hinted_at). At Charlotte the cameras only
// cover entrances/exits — there's no interior coverage that could confuse
// a "still on lot" signal — so an exit hint is a hard "they left, no
// violation". closeRegistered will close the session clean on its next pass.
async function overstayExpiry(): Promise<number> {
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, property_id, plate_text, entry_plate_event_id, visitor_pass_id, exit_hinted_at")
    .eq("state", "registered")
    .is("exited_at", null);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let n = 0;
  const graceCutoffMs = Date.now() - OVERSTAY_GRACE_MINUTES * 60 * 1000;
  for (const s of sessions) {
    if (!s.visitor_pass_id) continue;
    if (s.exit_hinted_at) {
      // Exit camera saw them leaving — no violation. closeRegistered fast
      // path will close the session at +EXIT_HINT_BUFFER_MINUTES.
      console.log(`overstay_skip session=${s.id} reason=exit_hinted_at exit_hinted_at=${s.exit_hinted_at}`);
      continue;
    }
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

// Close registered sessions when an exit camera sighting fires. Silence-
// based fallbacks were removed 2026-05-12 — under the registered-only
// ignore-unregistered policy, sessions ONLY close via a camera-detected
// exit (dedup→exit in camera-snapshot, or exit_hinted_at on multi-camera
// properties). A pass expiring without a corresponding exit fires an
// overstay violation in overstayExpiry; we never auto-close on silence.
async function closeRegistered(): Promise<number> {
  const nowMs = Date.now();
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, property_id, normalized_plate, exit_hinted_at, visitor_pass_id")
    .eq("state", "registered")
    .is("exited_at", null)
    .not("exit_hinted_at", "is", null);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let closed = 0;
  for (const s of sessions) {
    // exit_hinted_at IS NOT NULL is enforced by the SQL filter above.
    if (nowMs - new Date(s.exit_hinted_at!).getTime() <= EXIT_HINT_BUFFER_MINUTES * 60 * 1000) continue;

    const exitedAt = s.exit_hinted_at!;
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

    console.log(`close_registered session=${s.id} exited_at=${exitedAt}`);
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
    // SQL filter above already guarantees exit_hinted_at IS NOT NULL.
    const hintMs = new Date(s.exit_hinted_at!).getTime();
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
    let towConfirmed = false;
    if (s.violation_id) {
      const { data: v, error: vErr } = await db
        .from("alpr_violations")
        .select("status, tow_confirmed_at")
        .eq("id", s.violation_id)
        .single();
      if (vErr) throw vErr;
      if (!v) {
        // Violation row referenced by this session has been deleted from
        // the dashboard. Fall through to close the session as orphan
        // (treat same as no violation_id).
      } else {
        const resolved = v.tow_confirmed_at !== null ||
          (v.status && ["resolved", "dismissed", "no_tow"].includes(v.status));
        if (!resolved) continue;
        towConfirmed = v.tow_confirmed_at !== null;
      }
    }
    // If we get here the session is either:
    //   (a) violation resolved (action_taken set or tow confirmed), or
    //   (b) violation_id IS NULL (operator deleted the violation from
    //       the dashboard, ON DELETE SET NULL nulled the back-ref), or
    //   (c) violation row vanished mid-flight.
    // All three should close the session — leaving expired+exited_at=null
    // forever just clutters the state machine.

    // Same null-fallback as closeRegistered. last_detected_at can be null
    // on older sessions (pre-migration-018 inserts) — if we pass null into
    // new Date() we get epoch (1970), which creates an already-expired
    // 24h hold that doesn't actually block anything.
    const exitedAt = s.last_detected_at ?? new Date().toISOString();
    const sUpd = await db.from("plate_sessions")
      .update({
        state: towConfirmed ? "closed_post_violation" : "closed_clean",
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

// Post-violation hold: time we wait between creating a violation row and
// dispatching the partner email. If exit_hinted_at gets set on the session
// during this window (the truck pulled out shortly after the 30-min grace
// expired), we cancel the dispatch and mark the violation as
// left_before_tow_at — Frank never gets paged for a truck that already
// left. This is the practical fix for "still getting violations on cars
// that are leaving" reported on 2026-04-29.
const DISPATCH_HOLD_MINUTES = Number(Deno.env.get("DISPATCH_HOLD_MINUTES") ?? "5");

// Truck-plaza proactive overstay sweep. Under the registration-as-entrance
// model (handled by truck_plaza_exit.ts in camera-snapshot), an exit camera
// stamps visitor_passes.exited_at + overstay_violation_id when it sees a
// registered vehicle leave. If valid_until passes WITHOUT a camera-detected
// exit, this sweep fires the violation proactively so the partner email
// goes out without waiting for the eventual exit read.
//
// Matches: visitor_passes where valid_until < now, exited_at IS NULL,
// overstay_violation_id IS NULL, status='active'. Per-property guard:
// only properties whose property_type='truck_plaza' use this model.
async function sweepUnexitedPassesForOverstay(): Promise<number> {
  const nowIso = new Date().toISOString();
  // Join via property_type filter — only truck_plaza properties participate.
  const { data: passes, error } = await db
    .from("visitor_passes")
    .select("id, property_id, plate_text, properties!inner(property_type)")
    .is("exited_at", null)
    .is("overstay_violation_id", null)
    .eq("status", "active")
    .lt("valid_until", nowIso)
    .eq("properties.property_type", "truck_plaza")
    .limit(200);
  if (error) throw error;
  if (!passes || passes.length === 0) return 0;

  let fired = 0;
  for (const p of passes) {
    // Insert the violation. plate_event_id is null — there's no read; this
    // is a time-based fire. The eventual exit read in truck_plaza_exit will
    // backfill the actual exit camera + event ids onto the pass row.
    const vIns = await db.from("alpr_violations").insert({
      property_id: p.property_id,
      plate_text: p.plate_text,
      status: "pending",
      violation_type: "overstay",
      notes: `Pass valid_until passed without camera-detected exit. Fired by cron-sessions-sweep.`,
    }).select("id").single();
    if (vIns.error) {
      console.warn(`overstay_sweep: violation insert failed pass=${p.id}: ${vIns.error.message}`);
      continue;
    }
    // Claim the pass via conditional update so a near-simultaneous camera
    // exit can't double-insert. If the camera beat us to it, overstay_violation_id
    // is now non-null and our update no-ops; rollback the violation row.
    const claim = await db.from("visitor_passes")
      .update({ overstay_violation_id: vIns.data.id })
      .eq("id", p.id)
      .is("overstay_violation_id", null)
      .is("exited_at", null)
      .select("id");
    if (claim.error) {
      console.warn(`overstay_sweep: claim failed pass=${p.id}: ${claim.error.message}`);
      await db.from("alpr_violations").delete().eq("id", vIns.data.id);
      continue;
    }
    if (!claim.data || claim.data.length === 0) {
      // Lost the race — camera-snapshot stamped overstay_violation_id on
      // this same pass between our SELECT and UPDATE. Drop our duplicate.
      await db.from("alpr_violations").delete().eq("id", vIns.data.id);
      continue;
    }
    fired++;
  }
  return fired;
}

// SC211 burst-flush safety net. truck_plaza_exit.ts does an opportunistic
// flush whenever a new SC211 frame arrives, but for the last burst of
// the night (no follow-up frame) we need a time-driven backstop. Every
// minute we look for weak_plate_reads groups whose newest read is older
// than the burst window and run flushGroup on each — picks the best
// frame, PR-OCRs it, runs the tow + active-pass match, records exit /
// overstay / sighting just like the camera-snapshot inline path.
const PR_TOKEN = Deno.env.get("PLATE_RECOGNIZER_TOKEN") ?? "";
const PR_SDK_URL = Deno.env.get("PR_SDK_URL") ?? "";
const PR_API_URL = PR_SDK_URL || "https://api.platerecognizer.com/v1/plate-reader/";

async function sweepWeakPlateReads(): Promise<number> {
  if (!PR_TOKEN) {
    // No PR token configured — can't second-opinion the best frame.
    // Skip rather than do a sidecar-only flush from here (we'd risk
    // marking exits off raw weak reads). The opportunistic path in
    // camera-snapshot does its own flush so this is a true backstop.
    return 0;
  }
  const now = new Date();
  const stale = await findStaleGroups(db, now);
  if (stale.length === 0) return 0;
  let flushed = 0;
  for (const g of stale) {
    try {
      const r = await flushGroup({
        db,
        propertyId: g.property_id,
        groupKey: g.group_key,
        now,
        prToken: PR_TOKEN,
        prApiUrl: PR_API_URL,
      });
      if (r.outcome !== "no_op") flushed++;
    } catch (err) {
      console.warn(`sweepWeakPlateReads: flushGroup ${g.property_id}/${g.group_key} failed: ${String(err)}`);
    }
  }
  return flushed;
}

async function dispatchPendingViolations(): Promise<{ dispatched: number; left_before_tow: number }> {
  const cutoff = new Date(Date.now() - DISPATCH_HOLD_MINUTES * 60 * 1000).toISOString();
  const { data: pending, error } = await db
    .from("alpr_violations")
    .select("id, session_id, created_at")
    .is("sms_sent_at", null)
    .lt("created_at", cutoff)
    .limit(50);
  if (error) throw error;
  if (!pending || pending.length === 0) return { dispatched: 0, left_before_tow: 0 };

  let dispatched = 0;
  let leftBeforeTow = 0;
  const internalToken = Deno.env.get("INTERNAL_TOKEN") ?? "";

  for (const v of pending) {
    if (!v.session_id) continue;
    const { data: sess, error: sErr } = await db
      .from("plate_sessions")
      .select("exit_hinted_at")
      .eq("id", v.session_id)
      .maybeSingle();
    if (sErr) { console.warn("dispatchPending session fetch failed:", sErr.message); continue; }

    if (sess?.exit_hinted_at) {
      // Truck was seen heading out during the post-violation hold —
      // they left before Frank would have rolled. Suppress the dispatch
      // and stamp the audit flag.
      const upd = await db
        .from("alpr_violations")
        .update({
          left_before_tow_at: new Date().toISOString(),
          sms_sent_at: new Date().toISOString(), // mark as "handled" so we don't retry
          status: "dismissed",
          action_taken: "no_tow",
          action_channel: "auto_left_before_tow",
          action_at: new Date().toISOString(),
          resolved_at: new Date().toISOString(),
        })
        .eq("id", v.id)
        .is("sms_sent_at", null);
      if (upd.error) console.warn(`auto-no-tow update failed for ${v.id}: ${upd.error.message}`);
      else {
        console.log(`auto_no_tow violation=${v.id} session=${v.session_id} exit_hinted_at=${sess.exit_hinted_at}`);
        leftBeforeTow++;
      }
      continue;
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/tow-dispatch-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${internalToken}` },
        body: JSON.stringify({ violation_id: v.id }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`tow-dispatch-email ${res.status} for ${v.id}: ${body.slice(0, 200)}`);
      } else {
        dispatched++;
      }
    } catch (err) {
      console.warn(`tow-dispatch-email fetch failed for ${v.id}: ${String(err)}`);
    }
  }

  return { dispatched, left_before_tow: leftBeforeTow };
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

  // Do NOT dispatch the email here — dispatchPendingViolations runs every
  // minute and will dispatch this violation after DISPATCH_HOLD_MINUTES,
  // giving the depth-pair / silence-gap a chance to set exit_hinted_at if
  // the truck is in the middle of pulling out. If that happens, the
  // dispatch is auto-cancelled with left_before_tow_at instead.
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
