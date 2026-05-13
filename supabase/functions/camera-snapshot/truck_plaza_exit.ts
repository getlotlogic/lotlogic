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

export type CameraRow = {
  id: string;
  property_id: string;
  api_key: string;
};

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
  | { outcome: "partner_truck_sighting"; partner_id: string; plate_event_id: string; sighting_id: string };

type ResolvedPlate = { raw: string; normalized: string; confidence: number | null; source: "onboard" | "pr" };

// Active visitor_pass that hasn't been marked exited. Front OR back plate
// match. Most-recent first so a driver mid-renewal exits the latest pass.
async function findActiveUnexitedPass(
  db: SupabaseClient,
  propertyId: string,
  normalized: string,
): Promise<{ id: string; valid_until: string } | null> {
  const { data, error } = await db
    .from("visitor_passes")
    .select("id,valid_until")
    .eq("property_id", propertyId)
    .eq("status", "active")
    .is("exited_at", null)
    .or(`plate_text.eq.${normalized},normalized_back_plate.eq.${normalized}`)
    .order("valid_from", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0];
  return row ? { id: row.id, valid_until: row.valid_until } : null;
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

// Single Plate Recognizer call against /v1/plate-reader/. Returns the
// highest-confidence plate, or null on no-plate / API failure. Used as a
// second-opinion OCR after onboard LPR misses every list — most reads
// don't pay this cost since most reads ARE registered passes or partner
// trucks that hit on the onboard read.
async function callPlateRecognizer(
  bytes: Uint8Array,
  token: string,
  apiUrl: string,
): Promise<{ plate: string; confidence: number | null } | null> {
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
    if (!best.plate) return null;
    return { plate: best.plate, confidence: typeof best.score === "number" ? best.score : null };
  } catch (_) {
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
}): Promise<TruckPlazaResult> {
  const { db, camera, payload, now } = args;
  const onboard = payload.onboardLpr;

  // 1. Resolve a plate to look up. Onboard LPR is the primary source; if
  //    the camera doesn't have onboard ANPR (SC211 cloud-OCR), fall
  //    through to a PR call directly. Direction is preserved when known —
  //    only Leave reads count as exits, but tow trucks count both ways.
  const direction = onboard?.direction ?? null;
  const onboardRaw = (onboard?.plate ?? "").trim();
  let resolved: ResolvedPlate | null = null;
  if (onboardRaw) {
    const norm = normalizePlate(onboardRaw);
    if (norm.length >= 4) {
      resolved = { raw: onboardRaw, normalized: norm, confidence: onboard?.plateConfidence ?? null, source: "onboard" };
    }
  }

  // 2. Look up tow-truck and pass with the onboard plate (cheap).
  let tow: { partner_id: string } | null = null;
  let pass: { id: string; valid_until: string } | null = null;
  if (resolved) {
    tow = await findTowTruckMatch(db, camera.property_id, resolved.normalized);
    if (!tow && direction === "Leave") {
      pass = await findActiveUnexitedPass(db, camera.property_id, resolved.normalized);
    }
  }

  // 3. PR fallback. Only fires when we have NO onboard plate at all
  //    (SC211 cloud-OCR cameras) — PR is the only OCR available there.
  //    When onboard returned a plate but it didn't match either list,
  //    we no longer second-opinion via PR. Trade-off: an onboard
  //    misread of a registered driver's exit becomes a missed exit;
  //    the proactive overstay cron fires at valid_until and the
  //    operator can dispute. Saves the per-read PR cost at high
  //    truck-plaza volume.
  if (!resolved && args.prToken && args.prApiUrl) {
    const pr = await callPlateRecognizer(payload.bytes, args.prToken, args.prApiUrl);
    if (pr) {
      const norm = normalizePlate(pr.plate);
      if (norm.length >= 4) {
        tow = await findTowTruckMatch(db, camera.property_id, norm);
        if (!tow && direction === "Leave") {
          pass = await findActiveUnexitedPass(db, camera.property_id, norm);
        }
        if (tow || pass) {
          resolved = { raw: pr.plate, normalized: norm, confidence: pr.confidence, source: "pr" };
        }
      }
    }
  }

  // 4. No usable read = drop. Nothing to upload, nothing to insert.
  if (!resolved) return { outcome: "dropped", reason: onboardRaw ? "plate_too_short" : "no_plate" };
  if (!tow && !pass) {
    return { outcome: "dropped", reason: direction === "Leave" ? "no_active_pass" : `unmatched_${direction ?? "null"}` };
  }

  // 5. Matched — upload snapshot + insert plate_event for evidence.
  const dateStr = now.toISOString().slice(0, 10);
  const kind = tow ? "tow" : "exit";
  const r2Key = `${camera.property_id}/${dateStr}/${kind}-${camera.api_key}-${now.getTime()}-${resolved.normalized}.jpg`;
  const imageUrl = await args.uploadJpeg(payload.bytes, r2Key);

  // Compute overstay before any writes (used by the pass branch only).
  const overstay = pass !== null && now.getTime() > new Date(pass.valid_until).getTime();
  const matchStatus = tow ? "partner_truck" : (overstay ? "overstay" : "visitor_pass");

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
      direction,
      pass_id: pass?.id ?? null,
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
  let overstayViolationId: string | null = null;
  if (overstay) {
    const vIns = await db.from("alpr_violations").insert({
      property_id: camera.property_id,
      plate_event_id: plateEventId,
      plate_text: resolved.raw.toUpperCase(),
      status: "pending",
      violation_type: "overstay",
      notes: `Pass valid until ${pass!.valid_until}; exited at ${now.toISOString()} (${Math.round((now.getTime() - new Date(pass!.valid_until).getTime()) / 60000)} min late)`,
    }).select("id").single();
    if (vIns.error) throw vIns.error;
    overstayViolationId = vIns.data.id as string;
  }

  const upd = await db.from("visitor_passes")
    .update({
      exited_at: now.toISOString(),
      exited_via_camera_id: camera.id,
      exited_via_plate_event_id: plateEventId,
      overstay_violation_id: overstayViolationId,
    })
    .eq("id", pass!.id)
    .is("exited_at", null);
  if (upd.error) throw upd.error;

  return overstay
    ? { outcome: "exit_overstay", pass_id: pass!.id, plate_event_id: plateEventId, violation_id: overstayViolationId! }
    : { outcome: "exit_clean", pass_id: pass!.id, plate_event_id: plateEventId };
}
