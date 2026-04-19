import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlate } from "./normalize.ts";
import type { MatchOutcome } from "./types.ts";

export async function matchPlate(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
  now: Date,
): Promise<MatchOutcome> {
  // resident_plates: property_id + active + normalized plate match
  const residents = await db
    .from("resident_plates")
    .select("id,plate_text,active,property_id")
    .eq("property_id", propertyId)
    .eq("active", true)
    .limit(50);
  if (residents.error) throw residents.error;
  for (const row of residents.data ?? []) {
    if (normalizePlate(row.plate_text ?? "") === normalizedPlate) {
      return { kind: "resident", resident_plate_id: row.id };
    }
  }

  // visitor_passes: property_id + plate normalized match + valid_from <= now < valid_until + cancelled_at IS NULL
  const passes = await db
    .from("visitor_passes")
    .select("id,plate_text,property_id,valid_from,valid_until,cancelled_at")
    .eq("property_id", propertyId)
    .limit(200);
  if (passes.error) throw passes.error;
  for (const row of passes.data ?? []) {
    if (row.cancelled_at) continue;
    const from = row.valid_from ? new Date(row.valid_from) : null;
    const until = row.valid_until ? new Date(row.valid_until) : null;
    if (from && now < from) continue;
    if (until && now >= until) continue;
    if (normalizePlate(row.plate_text ?? "") === normalizedPlate) {
      return { kind: "visitor_pass", visitor_pass_id: row.id };
    }
  }

  // parking_registrations: same property_id + plate_number match + status='active' + now < expires_at
  const regs = await db
    .from("parking_registrations")
    .select("id,plate_number,property_id,status,expires_at")
    .eq("property_id", propertyId)
    .eq("status", "active")
    .limit(200);
  if (regs.error) throw regs.error;
  for (const row of regs.data ?? []) {
    const expires = row.expires_at ? new Date(row.expires_at) : null;
    if (expires && now >= expires) continue;
    if (normalizePlate(row.plate_number ?? "") === normalizedPlate) {
      return { kind: "self_registered" };
    }
  }

  return { kind: "unmatched" };
}
