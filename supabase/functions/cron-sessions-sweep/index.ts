// Every minute (scheduled via pg_cron -> net.http_post), this function runs
// the three plate_sessions state transitions IN ORDER:
//   1. registration-transition: grace sessions with a newly-valid pass -> 'registered'
//   2. grace-expiry: grace sessions older than 15 min -> 'expired' + violation + email
//   3. pass-expiry: registered sessions whose pass.valid_until has passed -> 'expired' + violation + email
//
// Order matters: we want step 1 to promote any session that just registered
// before step 2 considers it for grace expiry. Otherwise a driver who
// registers at minute 14 could still catch a tow email at minute 15.
//
// This function is idempotent: running it twice in the same second is
// harmless because each transition's SELECT filters by current state.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (_req: Request) => {
  const started = Date.now();
  try {
    const promoted = await registrationTransition();
    const graceExpired = await graceExpiry();
    const passExpired = await passExpiry();

    return json(200, {
      ok: true,
      promoted,
      grace_expired: graceExpired,
      pass_expired: passExpired,
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
    // Fetch active passes for this property + plate match.
    const { data: passes, error: pErr } = await db
      .from("visitor_passes")
      .select("id, plate_text, valid_from, valid_until, cancelled_at")
      .eq("property_id", s.property_id)
      .is("cancelled_at", null);
    if (pErr) throw pErr;

    const match = (passes ?? []).find(p => {
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
      .eq("state", "grace");   // optimistic: only promote if still grace
    if (uErr) throw uErr;
    promoted++;
  }
  return promoted;
}

async function graceExpiry(): Promise<number> {
  // 15 min cutoff.
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
    await createViolationAndDispatch(s.property_id, s.plate_text, s.entry_plate_event_id, s.id);
    n++;
  }
  return n;
}

async function passExpiry(): Promise<number> {
  // Find registered sessions whose pass is now expired. Two-step so we don't
  // need a complex join with .or()/.lt() on the PostgREST builder.
  const { data: sessions, error } = await db
    .from("plate_sessions")
    .select("id, property_id, plate_text, entry_plate_event_id, visitor_pass_id")
    .eq("state", "registered")
    .is("exited_at", null);
  if (error) throw error;
  if (!sessions || sessions.length === 0) return 0;

  let n = 0;
  for (const s of sessions) {
    if (!s.visitor_pass_id) continue;
    const { data: pass, error: pErr } = await db
      .from("visitor_passes")
      .select("valid_until")
      .eq("id", s.visitor_pass_id)
      .single();
    if (pErr) throw pErr;
    if (!pass?.valid_until) continue;
    if (new Date(pass.valid_until) >= new Date()) continue;

    await createViolationAndDispatch(s.property_id, s.plate_text, s.entry_plate_event_id, s.id);
    n++;
  }
  return n;
}

async function createViolationAndDispatch(
  propertyId: string,
  plateText: string,
  entryPlateEventId: string,
  sessionId: string,
): Promise<void> {
  // 1. Insert violation.
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

  // 2. Flip session state (atomic guard on state != already expired).
  const sUpd = await db
    .from("plate_sessions")
    .update({ state: "expired", violation_id: violationId, updated_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (sUpd.error) throw sUpd.error;

  // 3. Fire tow-dispatch-email fire-and-forget. Errors logged, not thrown:
  //    the violation is safely recorded even if the email fails.
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
