import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlate } from "../pr-ingest/normalize.ts";

export type OpenSessionRow = {
  id: string;
  property_id: string;
  normalized_plate: string;
  plate_text: string;
  state: "grace" | "registered" | "resident" | "expired";
  entered_at: string;
  visitor_pass_id: string | null;
  resident_plate_id: string | null;
  violation_id: string | null;
};

export async function findOpenSession(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
): Promise<OpenSessionRow | null> {
  const { data, error } = await db
    .from("plate_sessions")
    .select("id,property_id,normalized_plate,plate_text,state,entered_at,visitor_pass_id,resident_plate_id,violation_id")
    .eq("property_id", propertyId)
    .eq("normalized_plate", normalizedPlate)
    .is("exited_at", null)
    .limit(1);
  if (error) throw error;
  return (data ?? [])[0] ?? null;
}

// Extract a pure DOT or MC number from a synthesized plate like "DOT-1234567"
// or "MC-789012". Returns null if the plate is a real license plate (no
// prefix).
function extractFmcsaNumber(normalizedPlate: string): { kind: "dot" | "mc"; number: string } | null {
  // normalizedPlate is already uppercase-alphanumeric-only via normalizePlate,
  // so "DOT-1234567" becomes "DOT1234567". We also accept the raw form.
  const dotM = normalizedPlate.match(/^DOT(\d{5,8})$/);
  if (dotM) return { kind: "dot", number: dotM[1] };
  const mcM = normalizedPlate.match(/^MC(\d{5,8})$/);
  if (mcM) return { kind: "mc", number: mcM[1] };
  return null;
}

export type ResidentRow = { id: string };
export async function findActiveResident(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
): Promise<ResidentRow | null> {
  const fmcsa = extractFmcsaNumber(normalizedPlate);

  // DOT/MC path: match resident_plates by usdot_number / mc_number instead of
  // plate_text. This is how a truck plaza employee driving a plateless
  // tractor gets allowlisted — they register with USDOT, and the camera's
  // synthesized DOT-xxx plate matches back to their resident row.
  if (fmcsa) {
    const col = fmcsa.kind === "dot" ? "usdot_number" : "mc_number";
    const { data, error } = await db
      .from("resident_plates")
      .select("id")
      .eq("property_id", propertyId)
      .eq("active", true)
      .eq(col, fmcsa.number)
      .limit(1);
    if (error) throw error;
    return (data ?? [])[0] ? { id: data![0].id } : null;
  }

  // Standard plate path.
  const { data, error } = await db
    .from("resident_plates")
    .select("id,plate_text,active,property_id")
    .eq("property_id", propertyId)
    .eq("active", true)
    .limit(200);
  if (error) throw error;
  for (const r of data ?? []) {
    if (normalizePlate(r.plate_text ?? "") === normalizedPlate) return { id: r.id };
  }
  return null;
}

export type PassRow = { id: string; valid_until: string };
export async function findActiveVisitorPass(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
  now: Date,
): Promise<PassRow | null> {
  const fmcsa = extractFmcsaNumber(normalizedPlate);

  // DOT/MC path: visitor_passes.usdot_number or .mc_number.
  if (fmcsa) {
    const col = fmcsa.kind === "dot" ? "usdot_number" : "mc_number";
    const { data, error } = await db
      .from("visitor_passes")
      .select("id,valid_from,valid_until,cancelled_at")
      .eq("property_id", propertyId)
      .eq(col, fmcsa.number)
      .is("cancelled_at", null)
      .limit(10);
    if (error) throw error;
    for (const r of data ?? []) {
      if (r.valid_from && new Date(r.valid_from) > now) continue;
      if (!r.valid_until || new Date(r.valid_until) <= now) continue;
      return { id: r.id, valid_until: r.valid_until };
    }
    return null;
  }

  // Standard plate path.
  const { data, error } = await db
    .from("visitor_passes")
    .select("id,plate_text,valid_from,valid_until,cancelled_at,property_id")
    .eq("property_id", propertyId)
    .limit(500);
  if (error) throw error;
  for (const r of data ?? []) {
    if (r.cancelled_at) continue;
    if (r.valid_from && new Date(r.valid_from) > now) continue;
    if (!r.valid_until || new Date(r.valid_until) <= now) continue;
    if (normalizePlate(r.plate_text ?? "") === normalizedPlate) {
      return { id: r.id, valid_until: r.valid_until };
    }
  }
  return null;
}

export type NewSessionInput = {
  propertyId: string;
  normalizedPlate: string;
  plateText: string;
  vehicleType: string | null;
  entryCameraId: string;
  entryPlateEventId: string;
  state: "grace" | "registered" | "resident";
  visitorPassId?: string | null;
  residentPlateId?: string | null;
  enteredAt: Date;
};

export async function insertSession(
  db: SupabaseClient,
  input: NewSessionInput,
): Promise<{ id: string }> {
  const row = {
    property_id: input.propertyId,
    normalized_plate: input.normalizedPlate,
    plate_text: input.plateText,
    vehicle_type: input.vehicleType,
    entry_camera_id: input.entryCameraId,
    entry_plate_event_id: input.entryPlateEventId,
    entered_at: input.enteredAt.toISOString(),
    state: input.state,
    visitor_pass_id: input.visitorPassId ?? null,
    resident_plate_id: input.residentPlateId ?? null,
  };
  const { data, error } = await db
    .from("plate_sessions")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id };
}

export type ExitOutcome =
  | { kind: "closed_clean" }
  | { kind: "closed_early"; visitorPassId: string; holdUntil: Date }
  | { kind: "closed_post_violation"; violationId: string; leftBeforeTow: boolean };

export type ExitCloseInput = {
  session: OpenSessionRow;
  exitCameraId: string;
  exitPlateEventId: string;
  exitedAt: Date;
  holdDurationHours: number; // 24 for now; kept configurable for tests
};

/**
 * Decide the new state + side effects based on the open session's current
 * state. Pure: returns what should happen. The caller performs the writes.
 */
export function decideExitOutcome(
  session: OpenSessionRow,
  passValidUntil: Date | null,
  exitedAt: Date,
  holdDurationHours: number,
): ExitOutcome {
  if (session.state === "registered" && passValidUntil && passValidUntil > exitedAt && session.visitor_pass_id) {
    const holdUntil = new Date(exitedAt.getTime() + holdDurationHours * 3600 * 1000);
    return { kind: "closed_early", visitorPassId: session.visitor_pass_id, holdUntil };
  }
  if (session.state === "expired" && session.violation_id) {
    return { kind: "closed_post_violation", violationId: session.violation_id, leftBeforeTow: true };
  }
  return { kind: "closed_clean" };
}

export async function applyExitOutcome(
  db: SupabaseClient,
  input: ExitCloseInput,
  outcome: ExitOutcome,
): Promise<void> {
  const nowIso = input.exitedAt.toISOString();

  let newState: "closed_clean" | "closed_early" | "closed_post_violation";
  switch (outcome.kind) {
    case "closed_early":
      newState = "closed_early";
      break;
    case "closed_post_violation":
      newState = "closed_post_violation";
      break;
    default:
      newState = "closed_clean";
  }

  const sessionUpdate = await db
    .from("plate_sessions")
    .update({
      state: newState,
      exited_at: nowIso,
      exit_camera_id: input.exitCameraId,
      exit_plate_event_id: input.exitPlateEventId,
      updated_at: nowIso,
    })
    .eq("id", input.session.id);
  if (sessionUpdate.error) throw sessionUpdate.error;

  if (outcome.kind === "closed_early") {
    const cancelPass = await db
      .from("visitor_passes")
      .update({ cancelled_at: nowIso, cancelled_by: "exited_early" })
      .eq("id", outcome.visitorPassId);
    if (cancelPass.error) throw cancelPass.error;

    const holdInsert = await db
      .from("plate_holds")
      .insert({
        property_id: input.session.property_id,
        normalized_plate: input.session.normalized_plate,
        source_session_id: input.session.id,
        held_at: nowIso,
        hold_until: outcome.holdUntil.toISOString(),
        reason: "early_exit",
      });
    if (holdInsert.error) throw holdInsert.error;
  }

  if (outcome.kind === "closed_post_violation" && outcome.leftBeforeTow) {
    // Only flag if tow_confirmed_at is still null. Check & set atomically.
    const update = await db
      .from("alpr_violations")
      .update({ left_before_tow_at: nowIso })
      .eq("id", outcome.violationId)
      .is("tow_confirmed_at", null);
    if (update.error) throw update.error;
  }
}
