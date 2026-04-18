import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Window for matching a camera sighting back to an open "tow" violation.
// Tow trucks usually arrive within an hour or two; 7 days is a generous
// ceiling that still keeps us from stamping confirmation on unrelated,
// much later dispatches for the same plate at the same property.
const TOW_MATCH_WINDOW = "7 days";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Supabase env not configured" }, 500);
  }

  // Service role is required — we write to partner_truck_sightings and
  // update alpr_violations across property boundaries. Both tables are
  // locked down by RLS; anon would silently no-op the update.
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let body: { plate_event_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const plateEventId = body.plate_event_id;
  if (!plateEventId) return json({ error: "plate_event_id is required" }, 400);

  // 1) Load the plate event.
  const { data: plateEvent, error: peErr } = await supabase
    .from("plate_events")
    .select("id, property_id, plate_text, camera_id, created_at")
    .eq("id", plateEventId)
    .maybeSingle();

  if (peErr) {
    return json({ error: "Failed to load plate event", detail: peErr.message }, 500);
  }
  if (!plateEvent) {
    return json({ confirmed: false, reason: "plate_event_not_found" }, 404);
  }

  // plate_events.plate_text is already the normalized (uppercase, stripped)
  // value per alpr-webhook. We use it for both the sighting row and the
  // partner lookup so there is no re-normalization drift.
  const normalizedPlate = plateEvent.plate_text;
  if (!normalizedPlate) {
    return json({ confirmed: false, reason: "empty_plate" }, 200);
  }

  // 2) Find any enforcement partner whose tow_truck_plates array contains
  //    this plate. @> is the Postgres "contains" operator on arrays; it
  //    matches when the right-hand single-element array is a subset of the
  //    partner's configured truck plate list.
  const { data: partners, error: partErr } = await supabase
    .from("enforcement_partners")
    .select("id, tow_truck_plates")
    .not("tow_truck_plates", "is", null)
    .contains("tow_truck_plates", [normalizedPlate]);

  if (partErr) {
    return json({ error: "Failed to query partners", detail: partErr.message }, 500);
  }
  if (!partners || partners.length === 0) {
    return json({ confirmed: false, reason: "no_partner_match" }, 200);
  }

  // If multiple partners happen to share a plate (shouldn't, but be safe),
  // pick the first deterministic match. Also stamp the sighting for each.
  const partner = partners[0];

  // 3) Insert a sighting row.
  const { data: sighting, error: sightErr } = await supabase
    .from("partner_truck_sightings")
    .insert({
      partner_id: partner.id,
      property_id: plateEvent.property_id,
      plate_text: normalizedPlate,
      normalized_plate: normalizedPlate,
      camera_id: plateEvent.camera_id,
      plate_event_id: plateEvent.id,
      seen_at: plateEvent.created_at,
    })
    .select("id")
    .single();

  if (sightErr) {
    return json(
      { error: "Failed to insert sighting", detail: sightErr.message },
      500,
    );
  }

  // 4) Look for an open tow violation that this sighting confirms.
  //    Gate on:
  //      - same property + same plate
  //      - action_taken = 'tow' (dashboard/email/SMS already marked it)
  //      - tow_confirmed_at IS NULL (not already confirmed)
  //      - action_at within the last 7 days (sanity window)
  const windowCutoff = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: violation, error: violErr } = await supabase
    .from("alpr_violations")
    .select("id, action_at")
    .eq("property_id", plateEvent.property_id)
    .eq("plate_text", normalizedPlate)
    .eq("action_taken", "tow")
    .is("tow_confirmed_at", null)
    .gt("action_at", windowCutoff)
    .order("action_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (violErr) {
    // Don't fail the whole call — the sighting is still useful telemetry.
    console.error("tow-confirm: violation lookup failed:", violErr.message);
    return json(
      {
        confirmed: false,
        sighting_id: sighting.id,
        reason: "violation_lookup_failed",
      },
      200,
    );
  }

  if (!violation) {
    return json(
      {
        confirmed: false,
        sighting_id: sighting.id,
        reason: "no_open_tow_violation",
      },
      200,
    );
  }

  // 5) Stamp the confirmation.
  const nowIso = new Date().toISOString();
  const confirmation = {
    method: "camera_sighting",
    partner_id: partner.id,
    plate_event_id: plateEvent.id,
    camera_id: plateEvent.camera_id,
    seen_at: plateEvent.created_at,
  };

  const { error: updErr } = await supabase
    .from("alpr_violations")
    .update({
      tow_confirmed_at: nowIso,
      tow_confirmation: confirmation,
    })
    .eq("id", violation.id)
    .is("tow_confirmed_at", null); // belt-and-suspenders race guard

  if (updErr) {
    console.error("tow-confirm: violation update failed:", updErr.message);
    return json(
      {
        confirmed: false,
        sighting_id: sighting.id,
        reason: "violation_update_failed",
      },
      500,
    );
  }

  return json(
    {
      confirmed: true,
      sighting_id: sighting.id,
      violation_id: violation.id,
    },
    200,
  );
});
