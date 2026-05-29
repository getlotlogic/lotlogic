// Best-of-N burst flush for SC211 (no-onboard-LPR) cameras.
//
// Each weak sidecar read (confidence >= 0.20) is buffered into the
// `weak_plate_reads` table. After the burst window (BURST_WINDOW_MS,
// 30s) we pick the highest-confidence row in the group, fetch its
// snapshot via Plate Recognizer for a second-opinion OCR, and run the
// normal exit/tow match against PR's plate (or the sidecar plate as
// fallback if PR returns nothing).
//
// Two callers invoke flushGroup:
//   1. Opportunistic — camera-snapshot/index.ts, on every SC211 frame,
//      checks for stale unprocessed groups before adding the new read.
//   2. Cron — cron-sessions-sweep/index.ts runs every minute as a
//      safety net for bursts that never get a follow-up frame.
//
// Race protection: a conditional UPDATE on processed_at claims all
// rows in the group before doing any external work. Two simultaneous
// flushers will see one win the claim and the other no-op.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlate } from "../pr-ingest/normalize.ts";
import { plateSimilar, plateMatchesPartial } from "./sessions.ts";
import {
  findOpenViolation,
  insertViolation,
  updateViolation,
  bundleEvidence,
  LINGER_MS,
  EXIT_GAP_MS,
} from "./no_reg_violations.ts";

// Plate-shape gate for no-registration violations. OCR off the side/back of a
// truck routinely returns trailer brand names (WABASH, FREIGHTLINER), decals,
// state names, and bare numbers — wrong-object detections, NOT weak plate
// reads. Per Gabe (2026-05-29): OCR garbage must NOT be recognized/recorded as
// a violation. Mirrors the SHAPE layer of isPlausiblePlate() in index.ts:
// length 5-8 with at least one letter AND one digit. (normalizePlate only
// strips punctuation, so pure-alpha brand words carry no digit → rejected.)
const NO_REG_MIN_PLATE_LEN = Number(Deno.env.get("PR_MIN_PLATE_LEN") ?? "5");
function looksLikePlate(normalized: string): boolean {
  if (normalized.length < NO_REG_MIN_PLATE_LEN || normalized.length > 8) return false;
  return /[A-Z]/.test(normalized) && /\d/.test(normalized);
}

export const BURST_WINDOW_MS = 30 * 1000;
// Hard cap: if a group's OLDEST unprocessed read is older than this, force
// a flush even if new reads keep arriving. Without this, a burst that
// never goes quiet (continuous SC211 motion) grows unboundedly and never
// reaches PR. 90s is a generous upper bound for "a single truck still
// arriving at the gate" — anything older is a stuck/oversize burst.
export const HARD_FLUSH_MAX_AGE_MS = 90 * 1000;

export type WeakReadInsert = {
  property_id: string;
  camera_id: string;
  group_key: string;
  raw_plate: string;
  normalized_plate: string;
  confidence: number;
  image_url: string | null;
};

export async function insertWeakRead(
  db: SupabaseClient,
  row: WeakReadInsert,
): Promise<string> {
  const ins = await db
    .from("weak_plate_reads")
    .insert(row)
    .select("id")
    .single();
  if (ins.error) throw ins.error;
  return ins.data.id as string;
}

export type FlushResult =
  | { outcome: "no_op"; reason: "no_stale_group" | "lost_claim_race" | "empty_group" }
  | { outcome: "no_match"; group_key: string; chosen_plate: string; reads_consumed: number }
  | { outcome: "exit_clean"; pass_id: string; reads_consumed: number }
  | { outcome: "exit_overstay"; pass_id: string; violation_id: string; reads_consumed: number }
  | { outcome: "partner_truck_sighting"; partner_id: string; sighting_id: string; reads_consumed: number }
  | {
      outcome: "no_registration_recorded";
      violation_id: string;
      row_state: "created" | "updated_presence" | "updated_exit";
      reads_consumed: number;
    };

type FlushArgs = {
  db: SupabaseClient;
  propertyId: string;
  groupKey: string;
  now: Date;
  prToken: string;
  prApiUrl: string;
  // Resolve the URL or raw bytes for PR. Returning null skips PR (we use
  // the sidecar plate directly). The caller controls how the snapshot is
  // produced — we just pass the image_url back from the chosen row.
};

// Find unprocessed groups whose newest read is older than the burst
// window. Returns an array of (property_id, group_key) tuples.
export async function findStaleGroups(
  db: SupabaseClient,
  now: Date,
  cutoffMs: number = BURST_WINDOW_MS,
): Promise<Array<{ property_id: string; group_key: string }>> {
  const cutoff = new Date(now.getTime() - cutoffMs).toISOString();
  // PostgREST can't do GROUP BY natively in this client. Workaround:
  // pull all unprocessed rows in one shot (cheap — should be small),
  // bucket in JS, keep groups whose max(seen_at) < cutoff.
  const { data, error } = await db
    .from("weak_plate_reads")
    .select("property_id,group_key,seen_at")
    .is("processed_at", null)
    .order("seen_at", { ascending: false })
    .limit(2000);
  if (error) throw error;
  if ((data?.length ?? 0) >= 2000) {
    // Backlog: more unprocessed rows than this query can see. Logging so
    // operators notice; the most-recent-first ordering means we still
    // process fresh bursts, but old never-flushed groups can be stranded.
    console.warn("findStaleGroups: 2000-row cap hit — older unprocessed weak_plate_reads may be stranded");
  }
  type Bucket = { property_id: string; group_key: string; latest: number; oldest: number };
  const buckets = new Map<string, Bucket>();
  for (const r of (data ?? []) as Array<{ property_id: string; group_key: string; seen_at: string }>) {
    const key = `${r.property_id}|${r.group_key}`;
    const ts = new Date(r.seen_at).getTime();
    const b = buckets.get(key);
    if (!b) {
      buckets.set(key, { property_id: r.property_id, group_key: r.group_key, latest: ts, oldest: ts });
    } else {
      if (ts > b.latest) b.latest = ts;
      if (ts < b.oldest) b.oldest = ts;
    }
  }
  const quietCutoff = new Date(cutoff).getTime();
  const hardCutoff = now.getTime() - HARD_FLUSH_MAX_AGE_MS;
  const stale: Array<{ property_id: string; group_key: string }> = [];
  for (const b of buckets.values()) {
    // Flush if EITHER (a) burst went quiet for cutoffMs, OR (b) oldest
    // unprocessed read in the group is past the hard-max-age — prevents
    // continuous traffic from accumulating forever.
    if (b.latest < quietCutoff || b.oldest < hardCutoff) {
      stale.push({ property_id: b.property_id, group_key: b.group_key });
    }
  }
  return stale;
}

// Atomic claim of every unprocessed row in this group. Returns the rows
// that were successfully claimed (caller did the claim, not a racer).
async function claimGroup(
  db: SupabaseClient,
  propertyId: string,
  groupKey: string,
  now: Date,
): Promise<Array<{
  id: string;
  camera_id: string;
  raw_plate: string;
  normalized_plate: string;
  confidence: number;
  image_url: string | null;
  seen_at: string;
}>> {
  const { data, error } = await db
    .from("weak_plate_reads")
    .update({ processed_at: now.toISOString() })
    .eq("property_id", propertyId)
    .eq("group_key", groupKey)
    .is("processed_at", null)
    .select("id,camera_id,raw_plate,normalized_plate,confidence,image_url,seen_at");
  if (error) throw error;
  return (data ?? []) as Array<{
    id: string;
    camera_id: string;
    raw_plate: string;
    normalized_plate: string;
    confidence: number;
    image_url: string | null;
    seen_at: string;
  }>;
}

// Call Plate Recognizer using the snapshot URL of the chosen weak read.
// Returns the highest-score plate or null on no-plate / API failure.
async function callPrViaUrl(
  imageUrl: string,
  token: string,
  apiUrl: string,
): Promise<{ plate: string; confidence: number | null } | null> {
  try {
    const form = new FormData();
    form.append("upload_url", imageUrl);
    form.append("regions", "us");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Token ${token}` },
      body: form,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    const results = (body?.results ?? []) as Array<{ plate?: string; score?: number }>;
    if (results.length === 0) return null;
    const best = results.reduce((a, b) => (Number(b.score ?? 0) > Number(a.score ?? 0) ? b : a));
    if (!best.plate) return null;
    return { plate: best.plate, confidence: typeof best.score === "number" ? best.score : null };
  } catch (err) {
    // Surface timeouts (AbortError after 8s) + network failures + parse
    // errors so we can tell "PR returned no plate" (legitimate) from
    // "PR is unreachable" (operational issue) without trawling the DB.
    console.warn(`callPrViaUrl failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return null;
  }
}

async function findActiveUnexitedPassFuzzy(
  db: SupabaseClient,
  propertyId: string,
  normalized: string,
  now: Date,
): Promise<{ id: string; valid_until: string; fuzzy: boolean; overstay_violation_id: string | null } | null> {
  type Row = {
    id: string;
    valid_until: string;
    valid_from: string | null;
    plate_text: string | null;
    normalized_back_plate: string | null;
    overstay_violation_id: string | null;
  };
  const { data, error } = await db
    .from("visitor_passes")
    .select("id,valid_until,valid_from,plate_text,normalized_back_plate,overstay_violation_id")
    .eq("property_id", propertyId)
    // active OR expired (C2, 2026-05-29): pass_expiry.py may soft-expire a pass
    // before the SC211 buffer flushes its exit. cancelled/revoked/towed stay out.
    .in("status", ["active", "expired"])
    .is("exited_at", null)
    .order("valid_from", { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = ((data ?? []) as Row[]).filter((r) => {
    if (r.valid_from && new Date(r.valid_from) > now) return false;
    return true;
  });
  if (rows.length === 0) return null;
  const cands = (r: Row): string[] => {
    const out: string[] = [];
    if (r.plate_text) out.push(normalizePlate(r.plate_text));
    if (r.normalized_back_plate) out.push(r.normalized_back_plate);
    return out;
  };
  const wrap = (r: Row, fuzzy: boolean) => ({
    id: r.id,
    valid_until: r.valid_until,
    fuzzy,
    overstay_violation_id: r.overstay_violation_id ?? null,
  });
  for (const r of rows) {
    if (cands(r).includes(normalized)) return wrap(r, false);
  }
  for (const r of rows) {
    if (cands(r).some((p) => plateSimilar(p, normalized, true))) return wrap(r, true);
  }
  for (const r of rows) {
    if (cands(r).some((p) => plateMatchesPartial(normalized, p))) return wrap(r, true);
  }
  return null;
}

// Fetch the tow-truck plate set once for a property. Returns the partner
// id and the normalized plate set so the caller can scan many candidate
// plates without re-querying.
async function loadTowTruckSet(
  db: SupabaseClient,
  propertyId: string,
): Promise<{ partner_id: string; plates: Set<string> } | null> {
  const { data: prop } = await db
    .from("properties")
    .select("tow_company_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!prop?.tow_company_id) return null;
  const { data: partner } = await db
    .from("enforcement_partners")
    .select("id,tow_truck_plates")
    .eq("id", prop.tow_company_id)
    .maybeSingle();
  if (!partner) return null;
  const plates = new Set<string>((partner.tow_truck_plates ?? []).map((p: string) => normalizePlate(p)));
  return { partner_id: partner.id, plates };
}

export async function flushGroup(args: FlushArgs): Promise<FlushResult> {
  const { db, propertyId, groupKey, now, prToken, prApiUrl } = args;

  // 1) Claim the group atomically. Any racer who beat us gets nothing back.
  const claimed = await claimGroup(db, propertyId, groupKey, now);
  if (claimed.length === 0) return { outcome: "no_op", reason: "lost_claim_race" };

  // 2) Pick the highest-confidence row as the "best frame".
  const best = claimed.reduce((a, b) => (b.confidence > a.confidence ? b : a));

  // 3) PR pass. Try the sidecar-best first; if the sidecar is unreliable
  //    (best confidence < 0.5 OR empty plate), ALSO try up to 2 additional
  //    recent frames from the burst. The sidecar (free Railway OpenALPR)
  //    misses plates on hard conditions (night exposure, headlight glare,
  //    partial framing) that PR Cloud can read — but only if we let it look.
  //    Without this fallback, a burst where every sidecar score is 0 means
  //    PR Cloud never sees a clear-plate frame at all.
  //
  //    Cost: at most 3x PR calls per burst, and only when the sidecar
  //    returned no useful signal. Trivial vs the value of catching missed
  //    plates.
  let plateForMatch = best.normalized_plate;
  let prUsed = false;
  let prPlateRaw: string | null = null;
  let prConfidence: number | null = null;
  let prFrameWinner = best;
  if (prToken && prApiUrl) {
    const framesToTry: typeof claimed = [];
    if (best.image_url) framesToTry.push(best);
    const sidecarUnreliable = best.confidence < 0.5 || !best.normalized_plate;
    if (sidecarUnreliable) {
      const additional = claimed
        .filter((r) => r.id !== best.id && r.image_url)
        .sort((a, b) => new Date(b.seen_at).getTime() - new Date(a.seen_at).getTime())
        .slice(0, 2);
      framesToTry.push(...additional);
    }
    for (const frame of framesToTry) {
      const pr = await callPrViaUrl(frame.image_url!, prToken, prApiUrl);
      if (!pr) continue;
      const norm = normalizePlate(pr.plate);
      if (norm.length < 4) continue;
      plateForMatch = norm;
      prUsed = true;
      prPlateRaw = pr.plate;
      prConfidence = pr.confidence;
      prFrameWinner = frame;
      break;
    }
  }

  // 4) Tow check first — scan EVERY claimed weak read's plate (plus the
  //    PR plate) against the partner's tow-truck list. A tow truck might
  //    appear cleanly in a non-best-confidence frame; the previous logic
  //    only checked the best frame's plate and could miss the sighting.
  const towSet = await loadTowTruckSet(db, propertyId);
  let tow: { partner_id: string } | null = null;
  let towPlate = plateForMatch;
  if (towSet) {
    const candidates = new Set<string>();
    candidates.add(plateForMatch);
    for (const r of claimed) candidates.add(r.normalized_plate);
    for (const c of candidates) {
      if (towSet.plates.has(c)) {
        tow = { partner_id: towSet.partner_id };
        towPlate = c;
        break;
      }
    }
  }
  // If we matched a tow truck on a NON-best frame, prefer that plate
  // (and the frame's snapshot) as the canonical record so the sighting
  // links to the snapshot that actually shows the tow truck.
  let chosenFrame = best;
  if (tow && towPlate !== plateForMatch) {
    const towFrame = claimed.find((r) => r.normalized_plate === towPlate);
    if (towFrame) chosenFrame = towFrame;
    plateForMatch = towPlate;
  }
  // If PR Cloud succeeded on a frame other than the sidecar's best, that
  // frame's snapshot is the right one to associate with the plate_event —
  // it's what visually shows the plate the operator will see.
  if (!tow && prUsed && prFrameWinner.id !== best.id) {
    chosenFrame = prFrameWinner;
  }
  const pass = tow ? null : await findActiveUnexitedPassFuzzy(db, propertyId, plateForMatch, now);

  // 5) Emit a single plate_event for the "winning" read of this burst.
  //    raw_data carries the burst metadata so the dashboard can show
  //    "this exit was chosen from N candidate reads via PR".
  if (!tow && !pass) {
    // ── Unmatched: record/extend a no-registration violation row ────────────
    // Only record when we have a confirmed plate text to key the violation on.
    // Use plateForMatch (= PR's read when available, else best.normalized_plate)
    // — the weak_read's raw_plate is empty when buffered without sidecar OCR.
    if (!plateForMatch) {
      return { outcome: "no_match", group_key: groupKey, chosen_plate: plateForMatch, reads_consumed: claimed.length };
    }

    // Reject OCR garbage (trailer brand text, decals, state names, bare
    // numbers) before it becomes an operator-facing violation. This is a
    // wrong-object detection, not a weak plate read.
    if (!looksLikePlate(plateForMatch)) {
      console.log(`weak_flush: skipped non-plate OCR text "${plateForMatch}" — no no-reg violation recorded (group=${groupKey})`);
      return { outcome: "no_match", group_key: groupKey, chosen_plate: plateForMatch, reads_consumed: claimed.length };
    }

    const burst_min = claimed.reduce(
      (m, r) => (new Date(r.seen_at) < m ? new Date(r.seen_at) : m),
      new Date(claimed[0].seen_at),
    );
    const burst_max = claimed.reduce(
      (m, r) => (new Date(r.seen_at) > m ? new Date(r.seen_at) : m),
      new Date(claimed[0].seen_at),
    );

    // bundleEvidence requires image_url: string — filter out URL-less rows.
    const evidenceRows = claimed
      .filter((r): r is typeof r & { image_url: string } => r.image_url !== null);

    const candidate = await findOpenViolation(db, {
      property_id: propertyId,
      normalized_plate: plateForMatch,
      within_hours: 24,
    });

    if (candidate) {
      const gap_ms = burst_min.getTime() - new Date(candidate.last_seen_at).getTime();
      const isExit = gap_ms >= EXIT_GAP_MS && candidate.exit_seen_at === null;
      const newSpan_ms = burst_max.getTime() - new Date(candidate.first_seen_at).getTime();
      const newStrength: "brief" | "lingered" =
        newSpan_ms >= LINGER_MS ? "lingered" : (candidate.presence_strength as "brief" | "lingered");

      await updateViolation(db, candidate.id, {
        last_seen_at: burst_max,
        exit_seen_at: isExit ? burst_min : undefined,
        presence_strength: newStrength,
        best_confidence: Math.max(Number(candidate.best_confidence), prConfidence ?? best.confidence),
        evidence_append: bundleEvidence(evidenceRows),
        weak_read_ids_append: claimed.map((r) => r.id),
      });
      return {
        outcome: "no_registration_recorded",
        violation_id: candidate.id,
        row_state: isExit ? "updated_exit" : "updated_presence",
        reads_consumed: claimed.length,
      };
    }

    const burst_span_ms = burst_max.getTime() - burst_min.getTime();
    const inserted = await insertViolation(db, {
      property_id: propertyId,
      normalized_plate: plateForMatch,
      raw_plate: prPlateRaw ?? best.raw_plate,
      best_confidence: prConfidence ?? best.confidence,
      first_seen_at: burst_min,
      last_seen_at: burst_max,
      presence_strength: burst_span_ms >= LINGER_MS ? "lingered" : "brief",
      evidence: bundleEvidence(evidenceRows),
      weak_read_ids: claimed.map((r) => r.id),
    });
    return {
      outcome: "no_registration_recorded",
      violation_id: inserted.id,
      row_state: "created",
      reads_consumed: claimed.length,
    };
  }

  const overstay = pass !== null && now.getTime() > new Date(pass.valid_until).getTime();
  const matchStatus = tow
    ? "partner_truck"
    : (overstay ? "overstay" : (pass!.fuzzy ? "visitor_pass_fuzzy" : "visitor_pass"));
  const evIns = await db.from("plate_events").insert({
    property_id: propertyId,
    camera_id: chosenFrame.camera_id,
    plate_text: (prUsed && prPlateRaw && !tow ? prPlateRaw : chosenFrame.raw_plate).toUpperCase(),
    normalized_plate: plateForMatch,
    image_url: chosenFrame.image_url,
    raw_data: {
      flow: tow ? "partner_truck_sighting" : "truck_plaza_exit",
      ocr_source: prUsed && !tow ? "pr_via_weak_buffer" : "sidecar_weak_buffer",
      pass_id: pass?.id ?? null,
      pass_match_fuzzy: pass?.fuzzy ?? false,
      overstay,
      burst_size: claimed.length,
      chosen_weak_read_id: chosenFrame.id,
      best_confidence_weak_read_id: best.id,
      sidecar_best_plate: best.raw_plate,
      sidecar_best_confidence: best.confidence,
      pr_used: prUsed && !tow,
      pr_confidence: prConfidence,
      pr_rescued_from_non_best_frame: !tow && prUsed && prFrameWinner.id !== best.id,
      tow_matched_on_non_best_frame: tow ? chosenFrame.id !== best.id : false,
    },
    match_status: matchStatus,
    confidence: tow ? chosenFrame.confidence : (prUsed ? prConfidence : chosenFrame.confidence),
  }).select("id").single();
  if (evIns.error) throw evIns.error;
  const plateEventId = evIns.data.id as string;

  // 6) Tow-truck sighting branch.
  if (tow) {
    const sIns = await db.from("partner_truck_sightings").insert({
      property_id: propertyId,
      partner_id: tow.partner_id,
      truck_plate: plateForMatch,
      plate_event_id: plateEventId,
      seen_at: now.toISOString(),
    }).select("id").single();
    if (sIns.error) throw sIns.error;
    return {
      outcome: "partner_truck_sighting",
      partner_id: tow.partner_id,
      sighting_id: sIns.data.id as string,
      reads_consumed: claimed.length,
    };
  }

  // 7) Pass-exit branch. Reuse the existing overstay violation if the
  //    proactive cron already inserted one. If not, INSERT and then race-
  //    safely claim the pass — cron may have stamped its own id between
  //    our SELECT and our claim; in that case delete our duplicate.
  let overstayViolationId: string | null = pass!.overstay_violation_id ?? null;
  // C4 (2026-05-29): a weak-buffer exit IS a real camera exit. If an overstay
  // violation already exists (cron fired it, possibly dispatched), atomically
  // claim the left-before-tow state. Stamp-only — we never send the stand-down
  // email here. The cron sweeps do it: dispatchPendingViolations suppresses a
  // not-yet-sent dispatch (via the pass's exited_at), and sweepPendingStandDowns
  // sends exactly one stand-down when a dispatch already went out. This avoids
  // the same-tick double-send race. Mirrors truck_plaza_exit.ts.
  if (overstay && overstayViolationId) {
    const vUpd = await db.from("alpr_violations")
      .update({
        plate_event_id: plateEventId,
        left_before_tow_at: now.toISOString(),
        status: "dismissed",
        action_taken: "no_tow",
        action_channel: "auto_left_before_tow",
        notes: `Pass valid until ${pass!.valid_until}; exited at ${now.toISOString()} via SC211 burst flush (${claimed.length} reads). Vehicle left before tow — auto-cancelled.`,
      })
      .eq("id", overstayViolationId)
      .is("left_before_tow_at", null);
    if (vUpd.error) throw vUpd.error;
  } else if (overstay) {
    // Overstaying pass with no prior violation, but the camera just caught it
    // leaving. Born dismissed/no_tow — the vehicle already left, so it must
    // never be dispatched.
    const vIns = await db.from("alpr_violations").insert({
      property_id: propertyId,
      plate_event_id: plateEventId,
      plate_text: (prUsed && prPlateRaw && !tow ? prPlateRaw : chosenFrame.raw_plate).toUpperCase(),
      status: "dismissed",
      action_taken: "no_tow",
      action_channel: "auto_left_before_tow",
      left_before_tow_at: now.toISOString(),
      violation_type: "overstay",
      notes: `Pass valid until ${pass!.valid_until}; exited at ${now.toISOString()} via SC211 burst flush (${claimed.length} reads). Camera caught exit before tow — born no_tow.`,
    }).select("id").single();
    if (vIns.error) throw vIns.error;
    const candidateId = vIns.data.id as string;
    const claim = await db.from("visitor_passes")
      .update({ overstay_violation_id: candidateId })
      .eq("id", pass!.id)
      .is("overstay_violation_id", null)
      .is("exited_at", null)
      .select("overstay_violation_id");
    if (claim.error) throw claim.error;
    if (!claim.data || claim.data.length === 0) {
      // Lost the race — cron stamped its own (possibly dispatched) violation.
      // Drop our duplicate and stand down the cron's row instead.
      await db.from("alpr_violations").delete().eq("id", candidateId);
      const reread = await db.from("visitor_passes")
        .select("overstay_violation_id")
        .eq("id", pass!.id)
        .single();
      overstayViolationId = (reread.data?.overstay_violation_id as string | null) ?? null;
      if (overstayViolationId) {
        await db.from("alpr_violations")
          .update({
            plate_event_id: plateEventId,
            left_before_tow_at: now.toISOString(),
            status: "dismissed",
            action_taken: "no_tow",
            action_channel: "auto_left_before_tow",
            notes: `Pass valid until ${pass!.valid_until}; exited at ${now.toISOString()} via SC211 burst flush (${claimed.length} reads, race-loser path). Vehicle left before tow — auto-cancelled.`,
          })
          .eq("id", overstayViolationId)
          .is("left_before_tow_at", null);
      }
    } else {
      overstayViolationId = candidateId;
    }
  }

  // C4 (2026-05-29): flip status='cancelled'/cancelled_by='camera_exit' on the
  // pass, same as truck_plaza_exit.ts — a weak-buffer exit is a real camera
  // exit per the canonical lifecycle. Previously this path left status='active',
  // so operators had to manually dismiss exited-but-active passes. The
  // status IN ('active','expired') guard mirrors the C2 re-key.
  const upd = await db.from("visitor_passes")
    .update({
      exited_at: now.toISOString(),
      exited_via_camera_id: chosenFrame.camera_id,
      exited_via_plate_event_id: plateEventId,
      overstay_violation_id: overstayViolationId,
      status: "cancelled",
      cancelled_at: now.toISOString(),
      cancelled_by: "camera_exit",
    })
    .eq("id", pass!.id)
    .in("status", ["active", "expired"])
    .is("exited_at", null);
  if (upd.error) throw upd.error;

  if (overstay && overstayViolationId) {
    return { outcome: "exit_overstay", pass_id: pass!.id, violation_id: overstayViolationId, reads_consumed: claimed.length };
  }
  return { outcome: "exit_clean", pass_id: pass!.id, reads_consumed: claimed.length };
}
