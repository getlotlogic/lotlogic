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
import { plateSimilar } from "./sessions.ts";
import { insertWeakRead, findStaleGroups, flushGroup } from "./weak_plate_reads.ts";

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

export type TruckPlazaResult =
  | { outcome: "dropped"; reason: string }
  | { outcome: "exit_clean"; pass_id: string; plate_event_id: string }
  | { outcome: "exit_overstay"; pass_id: string; plate_event_id: string; violation_id: string }
  | { outcome: "partner_truck_sighting"; partner_id: string; plate_event_id: string; sighting_id: string }
  | { outcome: "buffered"; weak_read_id: string; opportunistic_flushed: number };

type ResolvedPlate = { raw: string; normalized: string; confidence: number | null; source: "onboard" | "pr" };

// Sidecar threshold. Below this confidence we drop the frame outright;
// at-or-above buffers into weak_plate_reads for best-of-N selection in
// flushGroup() at end of burst. Operator request 2026-05-13: filter less,
// buffer everything the sidecar produces. Best-of-N over a burst window
// will surface the strongest read across multiple frames anyway.
export const SC211_SIDECAR_FLOOR = 0.0;

// Group key for burst dedup. SC211s at the same gate share a group so
// the best frame across cameras gets chosen as the winning read.
function groupKeyFor(camera: CameraRow): string {
  return camera.gate_id ?? camera.id;
}

type PassMatch = {
  id: string;
  valid_until: string;
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
//   2. FUZZY — same-length plates that differ only in OCR-confusion
//      pairs (C↔G, O↔0, I↔1, etc., curated from production drift) plus
//      up to one true edit. plateSimilar(anchored=true) — the tight
//      variant. Catches TS4467 onboard drift like "ABC1234" → "ABG1234".
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
    .eq("status", "active")
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
      if (candidates(r).some((p) => plateSimilar(p, normalized, true))) return wrap(r, true);
    }
  }
  // 3) Partial substring path REMOVED for onboard / camera matching —
  //    it was the path that mismatched 2R028 onto 24023 via shared "02".
  //    Sidecar (SC211) flows that need this fallback are not on this
  //    function; they have their own best-of-burst PR-resolved matcher.
  return null;
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
): Promise<{ plate: string; confidence: number } | null> {
  if (!token) return null;
  try {
    const form = new FormData();
    form.append("upload", new Blob([bytes as BlobPart], { type: "image/jpeg" }), "snapshot.jpg");
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
    if (!best.plate || typeof best.score !== "number") return null;
    return { plate: best.plate, confidence: best.score };
  } catch (err) {
    console.warn(`callPlateRecognizerCloud failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return null;
  }
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

  // 2. SC211 (no onboard plate) flow: run sidecar, buffer for best-of-N
  //    burst flush. The actual lookup happens inside flushGroup at end
  //    of burst window (cron-driven or opportunistic). Returns early.
  if (!resolved && args.sidecarRead) {
    const sc = await args.sidecarRead(payload.bytes, camera.id);
    if (!sc || sc.confidence < SC211_SIDECAR_FLOOR) {
      // No usable read — drop. Opportunistic flush still gets a chance
      // since we're at a camera that's part of a burst group.
      const stale = await findStaleGroups(db, now);
      const myGroup = groupKeyFor(camera);
      let flushed = 0;
      for (const s of stale) {
        if (s.property_id === camera.property_id && s.group_key === myGroup) {
          const r = await flushGroup({ db, propertyId: s.property_id, groupKey: s.group_key, now, prToken: args.prToken, prApiUrl: args.prApiUrl });
          if (r.outcome !== "no_op") flushed++;
        }
      }
      return { outcome: "dropped", reason: sc ? `sidecar_below_floor_${sc.confidence.toFixed(2)}` : "sidecar_empty" };
    }
    // Sidecar has a read >= floor — upload snapshot + buffer the row.
    // Accept short reads (even single characters) so partial OCR results
    // still land in weak_plate_reads where best-of-N can promote a fuller
    // read from the same burst. The downstream match step requires full
    // plates to find a pass, but partial reads are useful evidence.
    const normalized = normalizePlate(sc.plate);
    if (normalized.length < 1) return { outcome: "dropped", reason: "sidecar_plate_empty_normalized" };
    const dateStr = now.toISOString().slice(0, 10);
    const r2Key = `${camera.property_id}/${dateStr}/weak-${camera.api_key}-${now.getTime()}-${normalized}.jpg`;
    const imageUrl = await args.uploadJpeg(payload.bytes, r2Key);
    const groupKey = groupKeyFor(camera);
    const weakId = await insertWeakRead(db, {
      property_id: camera.property_id,
      camera_id: camera.id,
      group_key: groupKey,
      raw_plate: sc.plate,
      normalized_plate: normalized,
      confidence: sc.confidence,
      image_url: imageUrl,
    });
    // Opportunistic flush: if another burst on this same group has gone
    // quiet for >= BURST_WINDOW_MS, process it now. The newly-inserted
    // row above is NOT eligible since its seen_at is `now`.
    const stale = await findStaleGroups(db, now);
    let flushed = 0;
    for (const s of stale) {
      if (s.property_id === camera.property_id && s.group_key === groupKey) {
        const r = await flushGroup({ db, propertyId: s.property_id, groupKey: s.group_key, now, prToken: args.prToken, prApiUrl: args.prApiUrl });
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
  const ONBOARD_CONF_FLOOR = 0.50;
  const PR_RESOLVE_FLOOR = 0.40; // PR cloud's own confidence floor
  let lowConfPath = false;
  if (resolved && resolved.confidence !== null && resolved.confidence < ONBOARD_CONF_FLOOR) {
    lowConfPath = true;
    const prResult = await callPlateRecognizerCloud(
      args.prToken,
      args.prApiUrl,
      payload.bytes,
    );
    if (prResult && prResult.plate && prResult.confidence >= PR_RESOLVE_FLOOR) {
      const prNorm = normalizePlate(prResult.plate);
      if (prNorm.length >= 4) {
        resolved = { raw: prResult.plate, normalized: prNorm, confidence: prResult.confidence, source: "pr" };
      } else {
        return { outcome: "dropped", reason: `low_conf_pr_short_${resolved.confidence.toFixed(2)}` };
      }
    } else {
      return { outcome: "dropped", reason: `low_conf_pr_empty_${resolved.confidence.toFixed(2)}` };
    }
  }

  let tow: { partner_id: string } | null = null;
  let pass: PassMatch | null = null;
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
    }
  }

  // 4. No usable read = drop. Nothing to upload, nothing to insert.
  if (!resolved) return { outcome: "dropped", reason: onboardRaw ? "plate_too_short" : "no_plate" };
  if (!tow && !pass) {
    return { outcome: "dropped", reason: "no_match_onboard" };
  }

  // 5. Matched — upload snapshot + insert plate_event for evidence.
  const dateStr = now.toISOString().slice(0, 10);
  const kind = tow ? "tow" : "exit";
  const r2Key = `${camera.property_id}/${dateStr}/${kind}-${camera.api_key}-${now.getTime()}-${resolved.normalized}.jpg`;
  const imageUrl = await args.uploadJpeg(payload.bytes, r2Key);

  // Compute overstay before any writes (used by the pass branch only).
  const overstay = pass !== null && now.getTime() > new Date(pass.valid_until).getTime();
  const fuzzyHit = pass?.fuzzy ?? false;
  const matchStatus = tow
    ? "partner_truck"
    : (overstay ? "overstay" : (fuzzyHit ? "visitor_pass_fuzzy" : "visitor_pass"));

  const evIns = await db.from("plate_events").insert({
    property_id: camera.property_id,
    camera_id: camera.id,
    plate_text: resolved.raw.toUpperCase(),
    normalized_plate: resolved.normalized,
    image_url: imageUrl,
    raw_data: {
      onboardLpr: onboard,
      flow: tow ? "partner_truck_sighting" : "truck_plaza_exit",
      ocr_source: resolved.source,
      direction: onboard?.direction ?? null,
      pass_id: pass?.id ?? null,
      pass_match_fuzzy: fuzzyHit,
      overstay,
      ...(payload.rawMeta ?? {}),
    },
    match_status: matchStatus,
    confidence: resolved.confidence,
  }).select("id").single();
  if (evIns.error) throw evIns.error;
  const plateEventId = evIns.data.id as string;

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
    // onto its row instead of inserting a duplicate.
    const vUpd = await db.from("alpr_violations")
      .update({
        plate_event_id: plateEventId,
        notes: `Pass valid until ${pass!.valid_until}; exited at ${now.toISOString()} via camera (${Math.round((now.getTime() - new Date(pass!.valid_until).getTime()) / 60000)} min late). Originally fired by overstay sweep.`,
      })
      .eq("id", overstayViolationId);
    if (vUpd.error) throw vUpd.error;
  } else if (overstay) {
    // No prior overstay row. Race-safe insert: INSERT then conditionally
    // claim the pass; if cron got there first (between our SELECT and
    // our claim), delete the duplicate and adopt the cron's violation id.
    const vIns = await db.from("alpr_violations").insert({
      property_id: camera.property_id,
      plate_event_id: plateEventId,
      plate_text: resolved.raw.toUpperCase(),
      status: "pending",
      violation_type: "overstay",
      notes: `Pass valid until ${pass!.valid_until}; exited at ${now.toISOString()} (${Math.round((now.getTime() - new Date(pass!.valid_until).getTime()) / 60000)} min late)`,
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
      // Best-effort: link the camera evidence onto the winning row.
      if (overstayViolationId) {
        await db.from("alpr_violations")
          .update({
            plate_event_id: plateEventId,
            notes: `Pass valid until ${pass!.valid_until}; exited at ${now.toISOString()} via camera (race-loser path).`,
          })
          .eq("id", overstayViolationId);
      }
    } else {
      overstayViolationId = candidateId;
    }
  }

  // Status filter is critical: between our SELECT and this UPDATE, an
  // operator may have cancelled the pass. Without `.eq("status", "active")`
  // we'd stamp exited_at on a cancelled pass — the pass would then show
  // both cancelled AND camera-exited, confusing the dashboard and
  // breaking the close-clean flow. exited_at IS NULL is necessary too:
  // another flusher may have stamped exit already (e.g. weak_reads).
  const upd = await db.from("visitor_passes")
    .update({
      exited_at: now.toISOString(),
      exited_via_camera_id: camera.id,
      exited_via_plate_event_id: plateEventId,
      // overstay_violation_id already correct from the race-safe
      // branches above. Don't touch it here.
    })
    .eq("id", pass!.id)
    .eq("status", "active")
    .is("exited_at", null);
  if (upd.error) throw upd.error;

  // overstayViolationId can be null in the triple-race where cron deleted
  // its own duplicate violation between our claim-failed UPDATE and our
  // re-read. Return exit_clean rather than a misleading exit_overstay
  // with violation_id=undefined.
  if (overstay && overstayViolationId) {
    return { outcome: "exit_overstay", pass_id: pass!.id, plate_event_id: plateEventId, violation_id: overstayViolationId };
  }
  return { outcome: "exit_clean", pass_id: pass!.id, plate_event_id: plateEventId };
}
