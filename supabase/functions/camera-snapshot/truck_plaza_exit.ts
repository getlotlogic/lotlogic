// Registration-as-entrance model: a visitor_pass IS the entry record, and
// exits are detected by an exit-camera plate read that matches an active
// pass. This module handles that exit flow end-to-end, plus partner
// tow-truck sighting recording, for property_type='truck_plaza'.
//
// Flow per plate read:
//   1. Plate text comes from the camera's onboard LPR. If absent (SC211
//      cloud-OCR cameras), call Plate Recognizer once to backfill it.
//   2. Tow-truck list check (any direction) — partner truck plates at
//      this property get a partner_truck_sightings row + snapshot. We
//      record both Approach and Leave events so the operator dashboard
//      can see when partner trucks come and go.
//   3. Pass exit check — Leave-only. Active visitor_pass whose plate_text
//      OR normalized_back_plate matches AND exited_at IS NULL. Stamp
//      exited_at + overstay violation if now > valid_until.
//   4. No match in either list AND we used onboard plate first → call PR
//      Cloud as a second-opinion OCR and retry both lookups with PR's
//      plate. Catches onboard-OCR drift that would otherwise misfire as
//      a missed exit (overstay violation against a vehicle that actually
//      left on time).

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlate } from "../pr-ingest/normalize.ts";
import { areCharsConfusable } from "./sessions.ts";
import { insertWeakRead, findStaleGroups, flushGroup } from "./weak_plate_reads.ts";
import { extractMmc, isMmcBlocked, handleMmcFailureStatus, type PrMmcData } from "./mmc.ts";

export type CameraRow = {
  id: string;
  property_id: string;
  api_key: string;
  // Group multiple cameras that should be treated as one logical camera
  // for SC211 burst dedup. NULL = camera is its own group.
  gate_id: string | null;
};

export type SidecarRead = { plate: string; confidence: number } | null;

export type TruckPlazaPayload = {
  bytes: Uint8Array;
  cameraHint: string | null;
  onboardLpr: {
    plate: string;
    plateConfidence: number | null;
    direction: "Approach" | "Leave" | null;
    plateColor: string | null;
    vehicleType: string | null;
    vehicleColor: string | null;
    vehicleBrand: string | null;
    detectionRegion: string | null;
    eventType: string | null;
  } | null;
  rawMeta: Record<string, unknown> | null;
};

// plate / confidence are surfaced on every outcome that produced a durable
// plate_event so the caller (index.ts) can fire tow-confirm exit-correlation
// for the truck_plaza path (audit H1). truck_plaza returns before the legacy
// path that used to fire tow-confirm, so without these the correlator never
// ran — 47 sightings, 0 auto-confirmed tows.
export type TruckPlazaResult =
  | { outcome: "dropped"; reason: string }
  | { outcome: "exit_clean"; pass_id: string; plate_event_id: string; plate: string; confidence: number }
  | { outcome: "exit_overstay"; pass_id: string; plate_event_id: string; violation_id: string; plate: string; confidence: number }
  | { outcome: "partner_truck_sighting"; partner_id: string; plate_event_id: string; sighting_id: string; plate: string; confidence: number }
  | { outcome: "buffered"; weak_read_id: string; opportunistic_flushed: number };

type ResolvedPlate = { raw: string; normalized: string; confidence: number | null; source: "onboard" | "pr"; mmc?: PrMmcData; mmcRequested?: boolean };

// Sidecar threshold. Below this confidence we drop the frame outright;
// at-or-above buffers into weak_plate_reads for best-of-N selection in
// flushGroup() at end of burst. Operator request 2026-05-13: filter less,
// buffer everything the sidecar produces. Best-of-N over a burst window
// will surface the strongest read across multiple frames anyway.
export const SC211_SIDECAR_FLOOR = 0.0;

// Minimum read confidence for a DIRECT FUZZY (≤1-edit OCR-confusable) match to
// cancel a pass. Exact, cross-camera, and operator-verified-pair matches are
// NOT gated — they cancel at ANY confidence (exact plate / ground truth, per
// the canonical "any read = exit" rule). This guards ONLY the fuzzy tier so a
// low-confidence garbage read can't fuzzy-cancel the wrong truck's pass.
// 0.65 default chosen over 0.85: real fuzzy exits have been observed down to
// ~0.63, and onboard reads <0.25 are already rescued to PR-exact upstream.
// Env-tunable; log-and-retune as data accumulates.
const TRUCK_FUZZY_CANCEL_MIN = Number(Deno.env.get("TRUCK_FUZZY_CANCEL_MIN") ?? "0.65");

// Minimum dwell before a camera read may count as an EXIT. Charlotte has no
// entry/exit direction gate, so the read that fires right as/after a truck
// REGISTERS (their arrival, sitting at the gate) was being treated as an exit
// and closing the pass instantly. A genuine exit is hours later (min stay is
// hours); a read within this many minutes of the pass's valid_from is the
// ARRIVAL, not a departure — so it must not close the pass. (Data showed ~25%
// of camera-exits were closing within an hour of registration, many within 5
// minutes — all false.) Env-tunable. Default 30: the Charlotte arrival-read
// cluster is all <=37min on 12-48h passes, while the earliest plausible genuine
// exit observed is 72min, so 30 catches every false arrival-close and stays
// well clear of real exits. Assumes valid_from == registration time (true
// today); if valid_from is ever repurposed as a policy start, re-anchor this.
const EXIT_MIN_DWELL_MINUTES = Number(Deno.env.get("EXIT_MIN_DWELL_MINUTES") ?? "30");

// Max TOTAL differing character positions (OCR-confusable swaps + true edits
// combined) for a fuzzy exit read to auto-close a pass. The old rule allowed
// UNLIMITED confusable swaps + 1 true edit, so a read could ride several "free"
// confusable swaps onto a different vehicle's plate — e.g. MBD8497 closed a
// WBD3427 pass via M↔W + 8↔3 (both confusable) + 9↔2 (the 1 true edit) = 3
// real differences. Bounding the TOTAL diffs to 2 rejects that cross-vehicle
// case while still allowing genuine 1–2 char night OCR drift. 0 = exact only.
// Env-tunable so the threshold can be retuned without a redeploy.
const EXIT_MATCH_MAX_TOTAL_DIFFS = Number(Deno.env.get("EXIT_MATCH_MAX_TOTAL_DIFFS") ?? "2");

// Tighter fuzzy predicate for the EXIT close path ONLY (not session burst-dedup,
// which keeps using the looser plateSimilar). Same-length required; counts every
// differing position, distinguishing confusable swaps from true edits, and caps
// both: at most 1 true edit AND at most EXIT_MATCH_MAX_TOTAL_DIFFS total diffs.
function exitFuzzyMatch(read: string, registered: string): boolean {
  if (read.length !== registered.length) return false;
  let trueEdits = 0;
  let totalDiffs = 0;
  for (let i = 0; i < read.length; i++) {
    if (read[i] === registered[i]) continue;
    totalDiffs++;
    if (!areCharsConfusable(read[i], registered[i])) trueEdits++;
  }
  return trueEdits <= 1 && totalDiffs <= EXIT_MATCH_MAX_TOTAL_DIFFS;
}

// Group key for burst dedup. SC211s at the same gate share a group so
// the best frame across cameras gets chosen as the winning read.
function groupKeyFor(camera: CameraRow): string {
  return camera.gate_id ?? camera.id;
}

type PassMatch = {
  id: string;
  valid_until: string;
  valid_from: string | null;
  fuzzy: boolean;
  // If the proactive overstay cron already created an overstay violation
  // (and stamped it on the pass), we want to link the camera-detected
  // exit to that existing row instead of inserting a duplicate.
  overstay_violation_id: string | null;
};

// Active visitor_pass that hasn't been marked exited. Three-pass matcher
// over the (typically small) active-unexited set for this property:
//
//   1. EXACT — front (plate_text) or back (normalized_back_plate) equals
//      the camera's normalized read. Runs against every row first so a
//      clean read of "ABC1234" never wrong-links to "ABC1235" via the
//      fuzzy pass below.
//   2. FUZZY — exitFuzzyMatch: same-length, ≤1 true edit AND ≤EXIT_MATCH_
//      MAX_TOTAL_DIFFS total differing positions (confusable swaps now COUNT
//      toward the cap, so they're no longer unlimited-free). Catches TS4467
//      onboard drift like "ABC1234" → "ABG1234" but rejects multi-swap
//      cross-vehicle matches like MBD8497 → WBD3427.
//   3. PARTIAL — last-resort substring match (≥50% length overlap).
//      Covers reads where the camera caught only part of the plate.
//
// `fuzzy=true` on the return tells the caller to stamp a distinct
// match_status on the plate_event so the operator dashboard can spot-
// review fuzzy hits.
async function findActiveUnexitedPass(
  db: SupabaseClient,
  propertyId: string,
  normalized: string,
  now: Date,
  opts: { exactOnly?: boolean } = {},
): Promise<PassMatch | null> {
  type Row = {
    id: string;
    valid_until: string;
    valid_from: string | null;
    plate_text: string | null;
    back_plate: string | null;
    normalized_back_plate: string | null;
    overstay_violation_id: string | null;
  };
  const { data, error } = await db
    .from("visitor_passes")
    .select("id,valid_until,valid_from,plate_text,back_plate,normalized_back_plate,overstay_violation_id")
    .eq("property_id", propertyId)
    // active OR expired: pass_expiry.py may have soft-expired a pass before the
    // camera caught the exit. We must still match it to close it out. cancelled/
    // revoked/towed remain excluded (operator-killed passes never re-open).
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

  const candidates = (r: Row): string[] => {
    const out: string[] = [];
    if (r.plate_text) out.push(normalizePlate(r.plate_text));
    if (r.normalized_back_plate) out.push(r.normalized_back_plate);
    return out;
  };

  const wrap = (r: Row, fuzzy: boolean): PassMatch => ({
    id: r.id,
    valid_until: r.valid_until,
    valid_from: r.valid_from ?? null,
    fuzzy,
    overstay_violation_id: r.overstay_violation_id ?? null,
  });
  // 1) Exact
  for (const r of rows) {
    if (candidates(r).includes(normalized)) return wrap(r, false);
  }
  if (opts.exactOnly) return null;
  // 2) Fuzzy (OCR confusion + ≤1 true edit, same-length). Min-length floor
  //    on the camera read — 5-char plates are too short for the fuzzy
  //    matcher's loose budget (e.g. 2R028 fuzzy-matched 24023 on Honda).
  if (normalized.length >= 6) {
    for (const r of rows) {
      if (candidates(r).some((p) => exitFuzzyMatch(p, normalized))) return wrap(r, true);
    }
  }
  // 3) Partial substring path REMOVED for onboard / camera matching —
  //    it was the path that mismatched 2R028 onto 24023 via shared "02".
  //    Sidecar (SC211) flows that need this fallback are not on this
  //    function; they have their own best-of-burst PR-resolved matcher.
  return null;
}

// Cross-camera vehicle unification. When this camera's read didn't match
// any active pass directly, look at the OTHER camera's plate_events at
// this property within ±60s. If any of those reads matches an active pass
// (exact OR fuzzy), treat this read as the same vehicle.
//
// At Charlotte, the same exiting truck triggers TS4467 (south lot) then
// C4467 (north gate) within ~30s. Each camera sees a DIFFERENT physical
// placard — TS4467 typically gets the front grille placard, C4467 gets
// the rear license plate. Without this unification, the camera that
// missed the registered placard never closes the pass.
//
// Safety constraints:
//   - Time window: ±60s. Two unrelated vehicles passing both cameras
//     within 60s is rare at a truck stop, but pick the CLOSEST in time
//     to minimize cross-vehicle bleed.
//   - Confidence floor: 0.4 on the cross-camera read. Lower noise.
//   - Returns the BEST candidate (smallest |delta|, then highest confidence).
async function findCrossCameraPassMatch(
  db: SupabaseClient,
  propertyId: string,
  sourceCameraId: string,
  eventTime: Date,
): Promise<{ pass: PassMatch; sourceCameraId: string; sourcePlate: string; deltaSec: number } | null> {
  const lo = new Date(eventTime.getTime() - 60_000).toISOString();
  const hi = new Date(eventTime.getTime() + 60_000).toISOString();
  const { data: otherReads, error } = await db
    .from("plate_events")
    .select("normalized_plate, created_at, confidence, camera_id")
    .eq("property_id", propertyId)
    .neq("camera_id", sourceCameraId)
    .gte("created_at", lo)
    .lte("created_at", hi)
    .gte("confidence", 0.4)
    .order("created_at", { ascending: true })
    .limit(30);
  if (error || !otherReads || otherReads.length === 0) return null;

  // Sort candidates by |delta| ascending — closest in time first.
  const ranked = otherReads
    .filter((r) => r.normalized_plate && r.normalized_plate.length >= 4)
    .map((r) => ({
      plate: r.normalized_plate as string,
      cameraId: r.camera_id as string,
      delta: Math.abs(new Date(r.created_at as string).getTime() - eventTime.getTime()),
    }))
    .sort((a, b) => a.delta - b.delta);

  for (const cand of ranked) {
    const pass = await findActiveUnexitedPass(db, propertyId, cand.plate, eventTime, { exactOnly: false });
    if (pass) {
      return {
        pass: { ...pass, fuzzy: true }, // tag as fuzzy — operator can review
        sourceCameraId: cand.cameraId,
        sourcePlate: cand.plate,
        deltaSec: Math.round(cand.delta / 1000),
      };
    }
  }
  return null;
}

// Verified-pair exit. Last-resort fallback: when both direct match and
// the ±60s cross-camera unification failed, check operator-VERIFIED pairs
// in inferred_plate_pairs. If this read's plate is one side of a verified
// pair and the OTHER side matches an active pass, close that pass.
//
// This is the consumption of the operator's training labels. A pair
// becomes verified only when an operator visually confirmed in the
// Training tab that the two plate strings are the same truck. Without
// this branch, those labels are just stored — they don't close
// anything.
//
// Safety: verified_at is required (not just high confidence). Operator
// ground truth > heuristic confidence. Dismissed pairs are excluded by
// the dismissed_at IS NULL filter (defense-in-depth — they're already
// frozen by the upsert RPC, but never read them here either).
async function findVerifiedPairPassMatch(
  db: SupabaseClient,
  propertyId: string,
  plate: string,
  eventTime: Date,
): Promise<{ pass: PassMatch; pairedPlate: string; pairId: string; verifiedBy: string | null } | null> {
  const { data: pairs, error } = await db
    .from("inferred_plate_pairs")
    .select("id, plate_a, plate_b, verified_at, verified_by")
    .eq("property_id", propertyId)
    .not("verified_at", "is", null)
    .is("dismissed_at", null)
    .or(`plate_a.eq.${plate},plate_b.eq.${plate}`);
  if (error || !pairs || pairs.length === 0) return null;

  // Collect EVERY verified-partner that resolves to an active pass. A plate can
  // be verified-paired with more than one partner (a tractor that swaps
  // trailers, or an operator mis-verify) — and the schema permits it.
  const matches: { pass: PassMatch; pairedPlate: string; pairId: string; verifiedBy: string | null }[] = [];
  for (const p of pairs) {
    const partnerPlate = p.plate_a === plate ? p.plate_b : p.plate_a;
    const pass = await findActiveUnexitedPass(db, propertyId, partnerPlate, eventTime, { exactOnly: true });
    if (pass) {
      matches.push({
        pass: { ...pass, fuzzy: true }, // tag fuzzy for audit; the link is the verified pair
        pairedPlate: partnerPlate,
        pairId: p.id,
        verifiedBy: p.verified_by ?? null,
      });
    }
  }
  // Multi-partner SAFETY: if this plate's verified pairs point at MORE THAN ONE
  // distinct active pass, we cannot know which truck actually left. Auto-closing
  // an arbitrary one would cancel the wrong truck's pass (→ missed tow) and miss
  // the real one (→ false tow). Surface for operator review instead of guessing.
  const distinctPassIds = new Set(matches.map((m) => m.pass.id));
  if (distinctPassIds.size > 1) {
    console.warn(
      `verified_pair: plate "${plate}" maps to ${distinctPassIds.size} distinct active passes — ambiguous, NOT auto-closing (operator review)`,
    );
    return null;
  }
  return matches[0] ?? null;
}

// Tow-truck sighting candidate. property.tow_company_id points at the
// enforcement_partner whose tow_truck_plates array is consulted. Plates
// in the array are stored raw — normalize them client-side, then compare
// against the normalized read.
async function findTowTruckMatch(
  db: SupabaseClient,
  propertyId: string,
  normalized: string,
): Promise<{ partner_id: string } | null> {
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
  const plates = (partner.tow_truck_plates ?? []).map((p: string) => normalizePlate(p));
  if (!plates.includes(normalized)) return null;
  return { partner_id: partner.id };
}

// PR call for low-confidence onboard reads (TS4467). Takes bytes directly
// so we don't have to upload to R2 first — the snapshot may end up dropped
// if PR also fails, no point staging it. Returns null on empty/failed PR.
async function callPlateRecognizerCloud(
  token: string,
  apiUrl: string,
  bytes: Uint8Array,
  mmcEnabled = false,
  mmcBackoffMinutes = 60,
): Promise<{ plate: string; confidence: number; mmc?: PrMmcData; mmcRequested: boolean } | null> {
  if (!token) return null;

  const buildForm = (withMmc: boolean): FormData => {
    const form = new FormData();
    form.append("upload", new Blob([bytes as BlobPart], { type: "image/jpeg" }), "snapshot.jpg");
    form.append("regions", "us");
    if (withMmc) form.append("mmc", "true");
    return form;
  };

  const doCall = async (form: FormData): Promise<
    { ok: true; body: unknown } | { ok: false; status: number }
  > => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { Authorization: `Token ${token}` },
        body: form,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, body: await res.json() };
    } catch (err) {
      clearTimeout(timer);
      console.warn(`callPlateRecognizerCloud failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      return { ok: false, status: 0 };
    }
  };

  const tryMmc = mmcEnabled && !isMmcBlocked();
  let body: unknown;
  let mmcRequested = false;

  if (tryMmc) {
    const first = await doCall(buildForm(true));
    if (!first.ok) {
      handleMmcFailureStatus(first.status, mmcBackoffMinutes);
      console.warn(`callPlateRecognizerCloud: mmc ${first.status}; retrying without mmc`);
      const retry = await doCall(buildForm(false));
      if (!retry.ok) return null;
      body = retry.body;
      mmcRequested = false;
    } else {
      body = first.body;
      mmcRequested = true;
    }
  } else {
    const attempt = await doCall(buildForm(false));
    if (!attempt.ok) return null;
    body = attempt.body;
  }

  const results = ((body as Record<string, unknown>)?.results ?? []) as Array<Record<string, unknown>>;
  if (results.length === 0) return null;
  const best = results.reduce((a, b) =>
    Number(b.score ?? 0) > Number(a.score ?? 0) ? b : a,
  );
  if (!best.plate || typeof best.score !== "number") return null;
  return {
    plate:        best.plate as string,
    confidence:   best.score as number,
    mmc:          mmcRequested ? extractMmc(best) : undefined,
    mmcRequested,
  };
}

export async function handleTruckPlazaExit(args: {
  db: SupabaseClient;
  camera: CameraRow;
  payload: TruckPlazaPayload;
  now: Date;
  uploadJpeg: (bytes: Uint8Array, key: string) => Promise<string | null>;
  prToken: string;
  prApiUrl: string;
  // Sidecar OCR for cameras without onboard LPR (SC211). Returns the
  // best plate above the sidecar's own internal threshold (or null).
  // truck_plaza_exit applies its own SC211_SIDECAR_FLOOR on top.
  sidecarRead?: (bytes: Uint8Array, cameraId: string) => Promise<SidecarRead>;
  // When true, skip the sidecar gate AND skip the weak_plate_reads
  // buffer. Call PR Cloud synchronously on every frame and treat the
  // result like an onboard plate. No row is written for PR-empty
  // results. Used for cameras whose plates are too small/low-res for
  // the sidecar's text detector to find (C4467 at ~30-40px plates),
  // where the buffer flow produced thousands of useless empty weak
  // rows. Configured per-MAC via SKIP_SIDECAR_MACS env var in index.ts.
  bypassSidecarGate?: boolean;
  // Called fire-and-forget after we successfully claim a "left before
  // tow" stamp on an already-dispatched overstay violation. index.ts
  // wires this to tow-dispatch-email with notification_kind set, so
  // the partner gets a "vehicle already gone — stand down" follow-up
  // instead of rolling a truck to an empty space.
  notifyLeftBeforeTow?: (violationId: string) => void;
  // MMC config threaded from index.ts (this module never reads Deno.env for
  // MMC — the boot log in index.ts stays authoritative).
  mmcEnabled?: boolean;
  mmcBackoffMinutes?: number;
}): Promise<TruckPlazaResult> {
  const { db, camera, payload, now } = args;
  const onboard = payload.onboardLpr;

  // 1. Resolve a plate from the onboard LPR if present.
  const onboardRaw = (onboard?.plate ?? "").trim();
  let resolved: ResolvedPlate | null = null;
  if (onboardRaw) {
    const norm = normalizePlate(onboardRaw);
    if (norm.length >= 4) {
      resolved = { raw: onboardRaw, normalized: norm, confidence: onboard?.plateConfidence ?? null, source: "onboard" };
    }
  }

  // 2a. Bypass flow: skip the sidecar gate AND skip weak_plate_reads
  //     buffering. Call PR Cloud synchronously on this exact frame and
  //     treat the result like an onboard read. No row is written for
  //     empty PR results — these cameras (e.g. C4467 with small plates)
  //     produced thousands of useless weak rows under the buffer flow,
  //     and the burst-flush delay swallowed plates we'd rather see
  //     immediately. Configured per-MAC via SKIP_SIDECAR_MACS in index.ts.
  if (!resolved && args.bypassSidecarGate) {
    // Do NOT request MMC here — this call fires on frames that may return no
    // plate at all (the purpose is to check). MMC was reverted per request.
    const prResult = await callPlateRecognizerCloud(args.prToken, args.prApiUrl, payload.bytes);
    if (!prResult || !prResult.plate) {
      return { outcome: "dropped", reason: "pr_empty" };
    }
    const prNorm = normalizePlate(prResult.plate);
    if (prNorm.length < 4) {
      return { outcome: "dropped", reason: "pr_plate_too_short" };
    }
    resolved = { raw: prResult.plate, normalized: prNorm, confidence: prResult.confidence, source: "pr", mmc: undefined, mmcRequested: false };
    // Fall through to section 3 (tow truck + pass matching).
  }

  // 2b. SC211 (no onboard plate) flow: sidecar is the "is this frame worth
  //    saving" gate ONLY. We ignore its plate text (too noisy on dark IR
  //    frames — returns "E", "R", "11" from the timestamp banner). When
  //    sidecar returns nothing → empty_scene → drop. When it returns
  //    anything → there's IR-lit content worth a PR call → buffer the
  //    raw frame with empty plate text. flushGroup picks the frame and
  //    calls PR for the canonical read.
  if (!resolved && args.sidecarRead) {
    const sc = await args.sidecarRead(payload.bytes, camera.id);
    if (!sc) {
      // empty_scene — no text-shaped regions at all. Drop without buffering.
      const stale = await findStaleGroups(db, now);
      const myGroup = groupKeyFor(camera);
      let flushed = 0;
      for (const s of stale) {
        if (s.property_id === camera.property_id && s.group_key === myGroup) {
          const r = await flushGroup({ db, propertyId: s.property_id, groupKey: s.group_key, now, prToken: args.prToken, prApiUrl: args.prApiUrl, mmcEnabled: args.mmcEnabled, mmcBackoffMinutes: args.mmcBackoffMinutes });
          if (r.outcome !== "no_op") flushed++;
        }
      }
      return { outcome: "dropped", reason: "sidecar_empty" };
    }
    // Sidecar saw IR-lit content. Buffer the frame for PR — raw_plate
    // stays empty so flushGroup relies entirely on PR's read of the
    // buffered image.
    const dateStr = now.toISOString().slice(0, 10);
    const r2Key = `${camera.property_id}/${dateStr}/weak-${camera.api_key}-${now.getTime()}.jpg`;
    const imageUrl = await args.uploadJpeg(payload.bytes, r2Key);
    const groupKey = groupKeyFor(camera);
    const weakId = await insertWeakRead(db, {
      property_id: camera.property_id,
      camera_id: camera.id,
      group_key: groupKey,
      raw_plate: "",
      normalized_plate: "",
      confidence: 0,
      image_url: imageUrl,
    });
    // Opportunistic flush: if another burst on this same group has gone
    // quiet for >= BURST_WINDOW_MS, process it now. The newly-inserted
    // row above is NOT eligible since its seen_at is `now`.
    const stale = await findStaleGroups(db, now);
    let flushed = 0;
    for (const s of stale) {
      if (s.property_id === camera.property_id && s.group_key === groupKey) {
        const r = await flushGroup({ db, propertyId: s.property_id, groupKey: s.group_key, now, prToken: args.prToken, prApiUrl: args.prApiUrl, mmcEnabled: args.mmcEnabled, mmcBackoffMinutes: args.mmcBackoffMinutes });
        if (r.outcome !== "no_op") flushed++;
      }
    }
    return { outcome: "buffered", weak_read_id: weakId, opportunistic_flushed: flushed };
  }

  // 3. TS4467 onboard-plate flow.
  //
  // Confidence gate: low-confidence onboard reads (< 0.50) regularly
  // hallucinate plates (e.g. Honda car read as "2R028" at 0.27 conf,
  // fuzzy-matched the registered "24023" — wrong vehicle, wrong exit).
  // For low-conf reads, we send the same JPEG to Plate Recognizer Cloud
  // as an authoritative second opinion. If PR returns a plate, we use
  // it for EXACT-only matching (no fuzzy fallback). If PR also fails,
  // we drop the read entirely rather than trust the bad onboard.
  //
  // Scope: this rescue only applies to ONBOARD-sourced reads. PR-sourced
  // reads (from bypassSidecarGate cameras like C4467) skip the rescue
  // entirely — calling PR again on the same image would just produce
  // the same answer, and we want fuzzy matching enabled for PR so
  // single-char OCR drift (B↔8, O↔0, I↔1, etc.) can still match the
  // registered plate.
  const ONBOARD_CONF_FLOOR = 0.25;
  const PR_RESOLVE_FLOOR = 0.40; // PR cloud's own confidence floor
  let lowConfPath = false;
  if (resolved && resolved.source === "onboard" && resolved.confidence !== null && resolved.confidence < ONBOARD_CONF_FLOOR) {
    lowConfPath = true;
    const prResult = await callPlateRecognizerCloud(
      args.prToken,
      args.prApiUrl,
      payload.bytes,
      args.mmcEnabled ?? false,
      args.mmcBackoffMinutes ?? 60,
    );
    if (prResult && prResult.plate && prResult.confidence >= PR_RESOLVE_FLOOR) {
      const prNorm = normalizePlate(prResult.plate);
      if (prNorm.length >= 4) {
        resolved = { raw: prResult.plate, normalized: prNorm, confidence: prResult.confidence, source: "pr", mmc: prResult.mmc, mmcRequested: prResult.mmcRequested };
      } else {
        return { outcome: "dropped", reason: `low_conf_pr_short_${resolved.confidence.toFixed(2)}` };
      }
    } else {
      return { outcome: "dropped", reason: `low_conf_pr_empty_${resolved.confidence.toFixed(2)}` };
    }
  }

  let tow: { partner_id: string } | null = null;
  let pass: PassMatch | null = null;
  let crossCameraUnification: { sourceCameraId: string; sourcePlate: string; deltaSec: number } | null = null;
  let verifiedPairMatch: { pairedPlate: string; pairId: string; verifiedBy: string | null } | null = null;
  if (resolved) {
    tow = await findTowTruckMatch(db, camera.property_id, resolved.normalized);
    if (!tow) {
      // PR-verified path is exact-only (we trusted PR, no need to fuzzy
      // around its output). Direct onboard at >= 0.50 still allows fuzzy
      // for OCR-confusion drift (ABC1234 → ABG1234), but no partial.
      pass = await findActiveUnexitedPass(
        db, camera.property_id, resolved.normalized, now,
        { exactOnly: lowConfPath },
      );
      // CROSS-CAMERA UNIFICATION. If this camera's read didn't match any
      // pass directly, a truck still might be exiting — the OTHER camera
      // may have just read its other placard (front grille vs rear plate)
      // and that read might match a pass. At Charlotte the same vehicle
      // crosses TS4467 (south lot) then C4467 (north gate) within seconds
      // and each camera sees a different physical plate. Without this
      // unification, the pass never closes via the camera that missed
      // the registered placard.
      if (!pass) {
        const xMatch = await findCrossCameraPassMatch(
          db, camera.property_id, camera.id, now,
        );
        if (xMatch) {
          pass = xMatch.pass;
          crossCameraUnification = {
            sourceCameraId: xMatch.sourceCameraId,
            sourcePlate: xMatch.sourcePlate,
            deltaSec: xMatch.deltaSec,
          };
        }
      }
      // VERIFIED-PAIR FALLBACK. The cross-camera ±60s window misses cases
      // where the other camera fired more than a minute ago, OR didn't
      // fire at all on this transit. If the operator has previously
      // verified that this plate pairs with another (Training tab → ✓
      // Same truck), and that paired plate matches an active pass, close
      // it. Operator ground truth > time-window heuristics.
      if (!pass) {
        const vMatch = await findVerifiedPairPassMatch(
          db, camera.property_id, resolved.normalized, now,
        );
        if (vMatch) {
          pass = vMatch.pass;
          verifiedPairMatch = {
            pairedPlate: vMatch.pairedPlate,
            pairId: vMatch.pairId,
            verifiedBy: vMatch.verifiedBy,
          };
        }
      }
      // CONFIDENCE GATE — fuzzy-direct tier ONLY. A direct ≤1-edit fuzzy match
      // is the one tier that can mis-fire on a garbage read, so require the
      // read's own confidence to clear TRUCK_FUZZY_CANCEL_MIN before it cancels
      // a pass. Exact (pass.fuzzy=false), cross-camera (exact on the OTHER
      // camera's read), and verified-pair (operator ground truth) are NOT
      // gated — they cancel at any confidence. Keying on the tier (not the
      // pass.fuzzy flag, which cross-camera + verified-pair also set true) is
      // critical: gating those would refuse legitimate ground-truth exits.
      if (
        pass && pass.fuzzy && !crossCameraUnification && !verifiedPairMatch &&
        (resolved.confidence ?? 0) < TRUCK_FUZZY_CANCEL_MIN
      ) {
        console.log(
          `truck_plaza_exit: fuzzy match "${resolved.normalized}" → pass ${pass.id} REJECTED, read conf ${(resolved.confidence ?? 0).toFixed(2)} < ${TRUCK_FUZZY_CANCEL_MIN} (no cancel)`,
        );
        pass = null;
      }

      // MINIMUM-DWELL GUARD — applies to ALL match tiers. A read within
      // EXIT_MIN_DWELL_MINUTES of the pass's registration is the truck ARRIVING
      // (no entry/exit direction gate at Charlotte), not leaving — so it must
      // not close the pass. This is the fix for passes being cancelled
      // instantly after registration by their own arrival read.
      if (pass && pass.valid_from) {
        const dwellMin = (now.getTime() - new Date(pass.valid_from).getTime()) / 60000;
        if (dwellMin < EXIT_MIN_DWELL_MINUTES) {
          console.log(
            `truck_plaza_exit: read "${resolved.normalized}" → pass ${pass.id} only ${dwellMin.toFixed(1)}min after registration (< ${EXIT_MIN_DWELL_MINUTES}min dwell) — ARRIVAL, not exit (no cancel)`,
          );
          pass = null;
        }
      }
    }
  }

  // 4. No usable read = drop. Nothing to upload, nothing to insert.
  if (!resolved) return { outcome: "dropped", reason: onboardRaw ? "plate_too_short" : "no_plate" };

  // 5. Always upload + insert plate_event for evidence — even when no tow
  //    and no pass match. Unmatched reads are stored so a later visitor_pass
  //    registration for the same plate can backfill the row as the
  //    "first seen on lot" image on the pass profile.
  const dateStr = now.toISOString().slice(0, 10);
  const kind = tow ? "tow" : (pass ? "exit" : "unmatched");
  const r2Key = `${camera.property_id}/${dateStr}/${kind}-${camera.api_key}-${now.getTime()}-${resolved.normalized}.jpg`;
  const imageUrl = await args.uploadJpeg(payload.bytes, r2Key);

  // Compute overstay before any writes (used by the pass branch only).
  const overstay = pass !== null && now.getTime() > new Date(pass.valid_until).getTime();
  const fuzzyHit = pass?.fuzzy ?? false;
  const matchStatus = tow
    ? "partner_truck"
    : pass
    ? (overstay ? "overstay" : (fuzzyHit ? "visitor_pass_fuzzy" : "visitor_pass"))
    : "unmatched";

  // MMC source reconciliation:
  // - source === "pr": PR cloud analyzed this frame and may have returned MMC.
  // - source === "onboard": TS4467 firmware. Use onboard vehicleBrand/vehicleColor.
  //   No confidence scores available from onboard LPR.
  const insertMmc = resolved.source === "pr" ? resolved.mmc : undefined;
  const vehicleMakeInsert  = insertMmc?.make  ?? onboard?.vehicleBrand  ?? null;
  const vehicleModelInsert = insertMmc?.model ?? null; // onboard has no model field
  const vehicleColorInsert = insertMmc?.color ?? onboard?.vehicleColor  ?? null;
  const vehicleMakeConf    = insertMmc ? (insertMmc.make_score  ?? null) : null;
  const vehicleColorConf   = insertMmc ? (insertMmc.color_score ?? null) : null;
  // vehicle_type: PR's body type if available, else onboard's vehicleType
  // (TS4467 reliably reports Truck/Van/etc). Was previously dropped, leaving
  // vehicle_type null on every onboard read.
  const vehicleTypeInsert  = (insertMmc?.vehicle_type) ?? onboard?.vehicleType ?? null;
  // _mmc_source in raw_data distinguishes PR MMC, onboard LPR, and neither.
  const mmcSource = insertMmc
    ? "pr_cloud"
    : (onboard?.vehicleBrand || onboard?.vehicleColor ? "onboard_lpr" : null);

  const evIns = await db.from("plate_events").insert({
    property_id: camera.property_id,
    camera_id: camera.id,
    plate_text: resolved.raw.toUpperCase(),
    normalized_plate: resolved.normalized,
    image_url: imageUrl,
    vehicle_make:             vehicleMakeInsert,
    vehicle_model:            vehicleModelInsert,
    vehicle_make_confidence:  vehicleMakeConf,
    vehicle_color:            vehicleColorInsert,
    vehicle_color_confidence: vehicleColorConf,
    vehicle_type:             vehicleTypeInsert,
    raw_data: {
      onboardLpr: onboard,
      flow: tow ? "partner_truck_sighting" : "truck_plaza_exit",
      ocr_source: resolved.source,
      direction: onboard?.direction ?? null,
      pass_id: pass?.id ?? null,
      pass_match_fuzzy: fuzzyHit,
      _pr_mmc_requested: resolved.mmcRequested ?? false,
      _mmc: insertMmc ?? null,
      _mmc_source: mmcSource,
      // Audit: was the pass match found via cross-camera unification?
      // If yes, this stores the other camera's plate + delta so the
      // dashboard can show "matched via other camera read X seconds away".
      cross_camera_match: crossCameraUnification,
      // Audit: was the pass match found via an operator-verified pair?
      // If yes, this stores the paired plate + pair id + verifier so the
      // dashboard can show "matched via verified pair NH7016 ↔ DC41892
      // (verified by victor@…)".
      verified_pair_match: verifiedPairMatch,
      overstay,
      ...(payload.rawMeta ?? {}),
    },
    match_status: matchStatus,
    confidence: resolved.confidence,
  }).select("id").single();
  if (evIns.error) throw evIns.error;
  const plateEventId = evIns.data.id as string;

  // 5b. No tow + no pass → return the drop, but the plate_event row above
  //     is now durable. Later visitor_pass registrations at this property
  //     can backfill it as the "first seen on lot" image when their
  //     normalized plate matches (exact or fuzzy).
  if (!tow && !pass) {
    return { outcome: "dropped", reason: "no_match_onboard" };
  }

  // 6a. Tow-truck branch: record the sighting and return. tow-confirm's
  //     correlator picks up the sighting on later violation matching.
  if (tow) {
    const sIns = await db.from("partner_truck_sightings").insert({
      property_id: camera.property_id,
      partner_id: tow.partner_id,
      truck_plate: resolved.normalized,
      plate_event_id: plateEventId,
      seen_at: now.toISOString(),
    }).select("id").single();
    if (sIns.error) throw sIns.error;
    return {
      outcome: "partner_truck_sighting",
      partner_id: tow.partner_id,
      plate_event_id: plateEventId,
      sighting_id: sIns.data.id as string,
      plate: resolved.normalized,
      confidence: resolved.confidence ?? 0,
    };
  }

  // 6b. Pass-exit branch: stamp exited_at + overstay violation if late.
  //
  // Reuse the existing overstay row if the proactive cron already created
  // one. Without this, a sequence of:
  //   1) cron sweep at valid_until+1min creates violation A, dispatches email
  //   2) truck physically leaves, camera fires at valid_until+30min
  //   3) we'd insert violation B and overwrite the link
  // would deliver two emails for one incident and orphan violation A.
  let overstayViolationId: string | null = pass!.overstay_violation_id ?? null;
  if (overstay && overstayViolationId) {
    // Cron sweep already filed this overstay — link the camera evidence
    // onto its row AND atomically claim the "left before tow" state.
    // The .is("left_before_tow_at", null) guard ensures only ONE
    // claimant wins (across concurrent camera reads + this path racing
    // with cron's own auto-cancel). Status flips to dismissed so the
    // partner queue stops showing it as active, and the dispatcher
    // skips it on retry.
    const claim = await db.from("alpr_violations")
      .update({
        plate_event_id: plateEventId,
        left_before_tow_at: now.toISOString(),
        status: "dismissed",
        action_taken: "no_tow",
        action_channel: "auto_left_before_tow",
        notes: `Pass valid until ${pass!.valid_until}; exited at ${now.toISOString()} via camera (${Math.round((now.getTime() - new Date(pass!.valid_until).getTime()) / 60000)} min late). Auto-cancelled — vehicle left before tow.`,
      })
      .eq("id", overstayViolationId)
      .is("left_before_tow_at", null)
      .select("id, dispatched_at")
      .maybeSingle();
    if (claim.error) throw claim.error;
    // Gate on dispatched_at — NOT sms_sent_at (audit M3). sms_sent_at is also
    // stamped by failDispatch / auto-no-tow suppression WITHOUT a tow email
    // ever going out, so keying the stand-down on it pages the partner to
    // "STAND DOWN" on a tow that was never dispatched. dispatched_at is set
    // only by tow-dispatch-email on a real send, so it's the true "they got
    // the dispatch email" signal. If null, nothing was sent — nothing to cancel.
    if (claim.data?.dispatched_at) {
      args.notifyLeftBeforeTow?.(overstayViolationId);
    }
  } else if (overstay) {
    // No prior overstay row. Race-safe insert: INSERT then conditionally
    // claim the pass; if cron got there first (between our SELECT and
    // our claim), delete the duplicate and adopt the cron's violation id.
    // Camera caught the exit before cron ever fired. No partner email
    // was sent for this row, so insert it pre-cancelled — left_before_tow
    // state up front, status=dismissed so the dispatcher skips it.
    const vIns = await db.from("alpr_violations").insert({
      property_id: camera.property_id,
      plate_event_id: plateEventId,
      plate_text: resolved.raw.toUpperCase(),
      status: "dismissed",
      violation_type: "overstay",
      left_before_tow_at: now.toISOString(),
      action_taken: "no_tow",
      action_channel: "auto_left_before_tow",
      notes: `Pass valid until ${pass!.valid_until}; exited at ${now.toISOString()} (${Math.round((now.getTime() - new Date(pass!.valid_until).getTime()) / 60000)} min late). Vehicle left before tow — auto-cancelled at violation creation.`,
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
      // Race lost — cron stamped its own violation id. Delete our
      // duplicate and re-read the winning id off the pass.
      await db.from("alpr_violations").delete().eq("id", candidateId);
      const reread = await db.from("visitor_passes")
        .select("overstay_violation_id")
        .eq("id", pass!.id)
        .single();
      overstayViolationId = (reread.data?.overstay_violation_id as string | null) ?? null;
      // Best-effort: link the camera evidence onto the winning row AND
      // atomically claim left_before_tow state (same as the linked path
      // above). If partner already got the dispatch email, fire the
      // stand-down follow-up.
      if (overstayViolationId) {
        const raceClaim = await db.from("alpr_violations")
          .update({
            plate_event_id: plateEventId,
            left_before_tow_at: now.toISOString(),
            status: "dismissed",
            action_taken: "no_tow",
            action_channel: "auto_left_before_tow",
            notes: `Pass valid until ${pass!.valid_until}; exited at ${now.toISOString()} via camera (race-loser path). Auto-cancelled — vehicle left before tow.`,
          })
          .eq("id", overstayViolationId)
          .is("left_before_tow_at", null)
          .select("id, dispatched_at")
          .maybeSingle();
        // Gate on dispatched_at (a real send) not sms_sent_at — audit M3.
        if (raceClaim.data?.dispatched_at) {
          args.notifyLeftBeforeTow?.(overstayViolationId);
        }
      }
    } else {
      overstayViolationId = candidateId;
    }
  }

  // Status filter is critical: between our SELECT and this UPDATE, an
  // operator may have cancelled the pass. We match `status IN
  // ('active','expired')` — NOT just 'active' (widened 2026-05-29, bug C2):
  // pass_expiry.py may have soft-expired the pass before the camera caught
  // the exit, and we must still close it out. cancelled/revoked/towed stay
  // excluded so we never stamp exited_at over an operator-killed pass. The
  // exited_at IS NULL guard is necessary too: another flusher may have
  // stamped exit already (e.g. weak_reads).
  //
  // STATUS TRANSITION: we now flip status='cancelled' on every camera
  // exit per the truck-plaza pass lifecycle (see
  // memory/project_truck_plaza_pass_lifecycle.md). The user-facing rule
  // is "we cancel the parking pass when the camera sees them leave."
  // Previously status stayed 'active' until pass_expiry.py noticed
  // valid_until had passed — that left a window where downstream checks
  // (cooldown, re-registration, pre-flight check-active) treated an
  // exited truck as still on the lot. cancelled_by='camera_exit'
  // distinguishes auto-cancels from operator overrides.
  //
  // If this exit was found via a verified pair, mark the pair as resolved
  // so the dashboard can show "this verified pair closed a pass" — and
  // future analytics can see how operator labels are paying off.
  const upd = await db.from("visitor_passes")
    .update({
      exited_at: now.toISOString(),
      exited_via_camera_id: camera.id,
      exited_via_plate_event_id: plateEventId,
      status: "cancelled",
      cancelled_at: now.toISOString(),
      cancelled_by: "camera_exit",
      // overstay_violation_id already correct from the race-safe
      // branches above. Don't touch it here.
    })
    .eq("id", pass!.id)
    .in("status", ["active", "expired"])
    .is("exited_at", null)
    .select("id");
  if (upd.error) throw upd.error;

  // If this exit was found via a verified pair, mark the pair as resolved so
  // the dashboard can show "this verified pair closed a pass" — but ONLY if the
  // UPDATE actually closed a row. The UPDATE can no-op (operator cancelled the
  // pass between our SELECT and here); stamping resolved_pass_id then would be
  // a lie downstream consumers might trust.
  if (verifiedPairMatch && upd.data && upd.data.length > 0) {
    await db.from("inferred_plate_pairs")
      .update({ resolved_pass_id: pass!.id, resolved_at: now.toISOString() })
      .eq("id", verifiedPairMatch.pairId);
  }

  // overstayViolationId can be null in the triple-race where cron deleted
  // its own duplicate violation between our claim-failed UPDATE and our
  // re-read. Return exit_clean rather than a misleading exit_overstay
  // with violation_id=undefined.
  if (overstay && overstayViolationId) {
    return { outcome: "exit_overstay", pass_id: pass!.id, plate_event_id: plateEventId, violation_id: overstayViolationId, plate: resolved.normalized, confidence: resolved.confidence ?? 0 };
  }
  return { outcome: "exit_clean", pass_id: pass!.id, plate_event_id: plateEventId, plate: resolved.normalized, confidence: resolved.confidence ?? 0 };
}
