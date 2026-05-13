// Registration-as-entrance model: a visitor_pass IS the entry record, and
// exits are detected by an exit-camera plate read that matches an active
// pass. This module handles that exit flow end-to-end, replacing the
// session state machine for property_type='truck_plaza'.
//
// Flow (per plate read):
//   1. Direction filter — only `Leave` reads count. `Approach` (truck
//      pulling IN past the camera) is dropped to avoid false-exits.
//   2. Plate text comes from the camera's onboard LPR — no PR call.
//      Cameras without onboard LPR aren't currently wired at truck plaza
//      properties; their reads are dropped by the direction filter
//      because they don't supply direction info.
//   3. Lookup: an active visitor_pass whose plate_text or
//      normalized_back_plate matches the read, AND exited_at IS NULL.
//      Resident plates and unregistered plates are silently ignored —
//      we only enforce overstays on registered visitors.
//   4. If match: stamp visitor_passes.exited_at + the camera/event that
//      recorded the exit. If now > valid_until, also insert an
//      alpr_violations row (type='overstay') and fire the partner email.

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
  | { outcome: "exit_overstay"; pass_id: string; plate_event_id: string; violation_id: string };

// Active pass that hasn't been marked exited yet. Front OR back plate
// match. Cooldown-style ordering (most-recent first) — if a driver has
// multiple consecutive passes the most-recent gets the exit stamp.
async function findActiveUnexitedPass(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
): Promise<{ id: string; valid_until: string } | null> {
  const { data, error } = await db
    .from("visitor_passes")
    .select("id,valid_until,plate_text,back_plate,normalized_back_plate,exited_at,status")
    .eq("property_id", propertyId)
    .eq("status", "active")
    .is("exited_at", null)
    .or(`plate_text.eq.${normalizedPlate},normalized_back_plate.eq.${normalizedPlate}`)
    .order("valid_from", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0];
  if (!row) return null;
  return { id: row.id, valid_until: row.valid_until };
}

export async function handleTruckPlazaExit(args: {
  db: SupabaseClient;
  camera: CameraRow;
  payload: TruckPlazaPayload;
  now: Date;
  uploadJpeg: (bytes: Uint8Array, key: string) => Promise<string | null>;
  fireDispatchEmail?: (violationId: string) => Promise<void>;
}): Promise<TruckPlazaResult> {
  const { db, camera, payload, now } = args;
  const onboard = payload.onboardLpr;

  // 1. Direction filter — Leave-only. Drop Approach (entries) and reads
  //    with no direction info; we only enforce on observed exits.
  if (!onboard || onboard.direction !== "Leave") {
    return { outcome: "dropped", reason: !onboard ? "no_onboard_lpr" : `direction_${onboard.direction ?? "null"}` };
  }
  const rawPlate = (onboard.plate ?? "").trim();
  if (!rawPlate) return { outcome: "dropped", reason: "empty_plate" };
  const normalized = normalizePlate(rawPlate);
  if (normalized.length < 4) return { outcome: "dropped", reason: "plate_too_short" };

  // 2. Lookup an active, unexited pass for this plate at this property.
  //    Match against front (plate_text) OR back (normalized_back_plate).
  //    Misses include: residents (always allowed), unregistered drivers,
  //    already-exited passes, and cancelled/expired passes. All four
  //    are silently dropped — we don't enforce against any of them.
  const pass = await findActiveUnexitedPass(db, camera.property_id, normalized);
  if (!pass) return { outcome: "dropped", reason: "no_active_pass" };

  // 3. Upload the snapshot to R2 so the operator dashboard can show
  //    evidence for the exit (and the overstay violation if applicable).
  const dateStr = now.toISOString().slice(0, 10);
  const r2Key = `${camera.property_id}/${dateStr}/exit-${camera.api_key}-${now.getTime()}-${normalized}.jpg`;
  const imageUrl = await args.uploadJpeg(payload.bytes, r2Key);

  // 4. Determine overstay before any writes — used by both branches.
  const validUntilMs = new Date(pass.valid_until).getTime();
  const overstay = now.getTime() > validUntilMs;

  // 5. Insert the plate_event recording the exit observation.
  const evIns = await db.from("plate_events").insert({
    property_id: camera.property_id,
    camera_id: camera.id,
    plate_text: rawPlate.toUpperCase(),
    normalized_plate: normalized,
    image_url: imageUrl,
    raw_data: {
      onboardLpr: onboard,
      flow: "truck_plaza_exit",
      pass_id: pass.id,
      overstay,
      ...(payload.rawMeta ?? {}),
    },
    match_status: overstay ? "overstay" : "visitor_pass",
    confidence: onboard.plateConfidence,
  }).select("id").single();
  if (evIns.error) throw evIns.error;
  const plateEventId = evIns.data.id as string;

  // 6. Overstay path: create the violation row and queue the dispatch
  //    email. dispatchPendingViolations in cron-sessions-sweep handles
  //    the actual send after the post-violation hold window.
  let overstayViolationId: string | null = null;
  if (overstay) {
    const vIns = await db.from("alpr_violations").insert({
      property_id: camera.property_id,
      plate_event_id: plateEventId,
      plate_text: rawPlate.toUpperCase(),
      status: "pending",
      violation_type: "overstay",
      notes: `Pass valid until ${pass.valid_until}; exited at ${now.toISOString()} (${Math.round((now.getTime() - validUntilMs) / 60000)} min late)`,
    }).select("id").single();
    if (vIns.error) throw vIns.error;
    overstayViolationId = vIns.data.id as string;
  }

  // 7. Stamp the pass with the exit. status stays 'active' — exited_at
  //    being non-null is the cross-check for "no longer on property",
  //    and the soft-expire cron will flip to 'expired' at valid_until
  //    anyway. Overstay violation id linked back for join queries.
  const upd = await db.from("visitor_passes")
    .update({
      exited_at: now.toISOString(),
      exited_via_camera_id: camera.id,
      exited_via_plate_event_id: plateEventId,
      overstay_violation_id: overstayViolationId,
    })
    .eq("id", pass.id)
    .is("exited_at", null);
  if (upd.error) throw upd.error;

  if (overstay) {
    return { outcome: "exit_overstay", pass_id: pass.id, plate_event_id: plateEventId, violation_id: overstayViolationId! };
  }
  return { outcome: "exit_clean", pass_id: pass.id, plate_event_id: plateEventId };
}
