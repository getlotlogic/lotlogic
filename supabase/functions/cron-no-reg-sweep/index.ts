// Runs every 60s. Transitions no_registration_violations rows:
//   pending → flagged (if no matching pass)
//   pending → resolved_pre_flag (if pass arrived during grace)
//   flagged → resolved_late (if pass arrived after flag)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "@supabase/supabase-js";
import { findPassForPlateInWindow } from "../camera-snapshot/no_reg_violations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GRACE_MS = 15 * 60_000;
const FLAGGED_LOOKBACK_MS = 48 * 60 * 60_000;
const PRE_BOOK_WINDOW_MS = 30 * 60_000;
const POST_LAST_SEEN_WINDOW_MS = 60 * 60_000;

export async function sweepViolations(db: any, now: Date = new Date()) {
  const transitions = { flagged: 0, resolved_pre_flag: 0, resolved_late: 0 };

  // (1) Pending rows past 15-min grace
  const graceCutoff = new Date(now.getTime() - GRACE_MS).toISOString();
  const { data: expired, error: e1 } = await db
    .from("no_registration_violations")
    .select("*")
    .eq("status", "pending")
    .lt("first_seen_at", graceCutoff);
  if (e1) throw e1;

  for (const v of expired ?? []) {
    const pass = await findPassForPlateInWindow(db, {
      property_id: v.property_id,
      normalized_plate: v.normalized_plate,
      window_start: new Date(new Date(v.first_seen_at).getTime() - PRE_BOOK_WINDOW_MS),
      window_end:   new Date(new Date(v.last_seen_at).getTime()  + POST_LAST_SEEN_WINDOW_MS),
    });
    const patch = pass
      ? { status: "resolved_pre_flag", resolved_at: now.toISOString(), resolved_reason: "pass_created" }
      : { status: "flagged", flagged_at: now.toISOString() };
    const { error: updErr } = await db
      .from("no_registration_violations")
      .update(patch)
      .eq("id", v.id)
      .eq("status", "pending");
    if (updErr) throw updErr;
    if (pass) transitions.resolved_pre_flag++; else transitions.flagged++;
  }

  // (2) Flagged rows — auto-resolve if pass shows up late (look back 48h)
  const lookback = new Date(now.getTime() - FLAGGED_LOOKBACK_MS).toISOString();
  const { data: flagged, error: e2 } = await db
    .from("no_registration_violations")
    .select("*")
    .eq("status", "flagged")
    .gt("flagged_at", lookback);
  if (e2) throw e2;

  for (const v of flagged ?? []) {
    const pass = await findPassForPlateInWindow(db, {
      property_id: v.property_id,
      normalized_plate: v.normalized_plate,
      window_start: new Date(v.flagged_at),
      window_end: now,
    });
    if (!pass) continue;
    const { error: updErr } = await db
      .from("no_registration_violations")
      .update({
        status: "resolved_late",
        resolved_at: now.toISOString(),
        resolved_reason: "pass_created",
      })
      .eq("id", v.id)
      .eq("status", "flagged");
    if (updErr) throw updErr;
    transitions.resolved_late++;
  }

  return transitions;
}

if (import.meta.main) {
  serve(async () => {
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const t = await sweepViolations(db);
    return new Response(JSON.stringify({ ok: true, ...t }), {
      headers: { "Content-Type": "application/json" },
    });
  });
}
