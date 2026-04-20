import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Returns true if the plate currently has an unexpired hold at the property.
 * Used by:
 *  - camera-snapshot on entry: does not change behaviour (held plate still
 *    opens a grace session; cron will tow them at t+15m because the backend
 *    will block any registration attempt in the meantime), but we record the
 *    hold context on the session for operator visibility.
 *  - (future) backend visitor_pass POST: rejects new registrations.
 */
export async function isPlateHeld(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
  now: Date,
): Promise<boolean> {
  const { data, error } = await db
    .from("plate_holds")
    .select("id")
    .eq("property_id", propertyId)
    .eq("normalized_plate", normalizedPlate)
    .gt("hold_until", now.toISOString())
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}
