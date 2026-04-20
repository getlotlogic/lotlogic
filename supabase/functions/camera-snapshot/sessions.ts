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

export type ResidentRow = { id: string };
export async function findActiveResident(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
): Promise<ResidentRow | null> {
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
