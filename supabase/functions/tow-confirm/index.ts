import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function normalizePlate(s: string): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const MIN_CONFIDENCE = Number(Deno.env.get("TOW_CONFIRM_MIN_CONFIDENCE") ?? "0.85");
const LOOKBACK_MIN   = Number(Deno.env.get("TOW_CONFIRM_LOOKBACK_MINUTES") ?? "180");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let body: {
    plate_event_id?: string;
    property_id?: string;
    plate_text?: string;
    event_type?: "entry" | "exit";
    confidence?: number;
    seen_at?: string;
  };
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const {
    plate_event_id, property_id, plate_text,
    event_type, confidence = 0, seen_at,
  } = body;

  if (!plate_event_id || !property_id || !plate_text || !event_type || !seen_at) {
    return json({ error: "missing fields" }, 400);
  }
  if (confidence < MIN_CONFIDENCE) {
    return json({ status: "skipped_low_confidence", confidence }, 200);
  }

  const plate = normalizePlate(plate_text);

  // ─── ENTRY EVENT: maybe record a partner truck sighting ─────────────────
  if (event_type === "entry") {
    const { data: prop } = await supabase
      .from("properties")
      .select("id, tow_company_id")
      .eq("id", property_id)
      .maybeSingle();
    if (!prop || !prop.tow_company_id) {
      return json({ status: "property_has_no_partner" }, 200);
    }

    const { data: partner } = await supabase
      .from("enforcement_partners")
      .select("id, tow_truck_plates")
      .eq("id", prop.tow_company_id)
      .maybeSingle();
    if (!partner) return json({ status: "partner_not_found" }, 200);

    const truckPlates = (partner.tow_truck_plates || []).map(normalizePlate);
    if (!truckPlates.includes(plate)) {
      return json({ status: "not_a_partner_truck" }, 200);
    }

    const { error: insErr } = await supabase
      .from("partner_truck_sightings")
      .insert({
        property_id,
        partner_id: partner.id,
        truck_plate: plate,
        plate_event_id,
        seen_at,
      });
    if (insErr) return json({ status: "sighting_insert_failed", detail: insErr.message }, 500);

    return json({ status: "sighting_recorded", partner_id: partner.id, truck_plate: plate }, 200);
  }

  if (event_type !== "exit") {
    return json({ status: "ignored_non_entry_non_exit", event_type }, 200);
  }

  // ─── EXIT EVENT: confirm any matching pending violation. ────────────────
  // Match against violations in ANY status (including 'resolved') as long as
  // tow_confirmed_at is still NULL. This is what enables the 'disputed' and
  // post-hoc 'confirmed' cells — the partner may have already responded but
  // the camera signal is independent.
  const { data: candidates, error: candErr } = await supabase
    .from("alpr_violations")
    .select("id, plate_text, status, dispatched_at, created_at, tow_confirmed_at, property_id")
    .eq("property_id", property_id)
    .eq("plate_text", plate)
    .is("tow_confirmed_at", null)
    .order("created_at", { ascending: true });

  if (candErr) return json({ status: "candidate_query_failed", detail: candErr.message }, 500);
  if (!candidates || candidates.length === 0) {
    return json({ status: "no_pending_violation_for_plate", plate }, 200);
  }

  const { data: prop } = await supabase
    .from("properties")
    .select("id, tow_company_id")
    .eq("id", property_id)
    .maybeSingle();
  if (!prop || !prop.tow_company_id) {
    return json({ status: "property_has_no_partner" }, 200);
  }

  const exitTs = new Date(seen_at).getTime();
  const lookbackTs = exitTs - LOOKBACK_MIN * 60 * 1000;

  for (const v of candidates) {
    const violationCreatedTs = new Date(v.created_at).getTime();
    const sightingFloor = Math.max(violationCreatedTs, lookbackTs);

    const { data: sighting } = await supabase
      .from("partner_truck_sightings")
      .select("id, truck_plate, plate_event_id, seen_at")
      .eq("property_id", property_id)
      .eq("partner_id", prop.tow_company_id)
      .is("consumed_by_violation_id", null)
      .gte("seen_at", new Date(sightingFloor).toISOString())
      .lte("seen_at", new Date(exitTs).toISOString())
      .order("seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sighting) continue;

    const { error: claimErr } = await supabase
      .from("partner_truck_sightings")
      .update({ consumed_by_violation_id: v.id })
      .eq("id", sighting.id)
      .is("consumed_by_violation_id", null);
    if (claimErr) continue;

    const deltaSeconds = Math.round(
      (exitTs - new Date(sighting.seen_at).getTime()) / 1000
    );

    const { data: updated, error: updErr } = await supabase
      .from("alpr_violations")
      .update({
        tow_confirmed_at: seen_at,
        tow_confirmation: {
          truck_plate: sighting.truck_plate,
          truck_sighting_id: sighting.id,
          truck_entry_event_id: sighting.plate_event_id,
          violator_exit_event_id: plate_event_id,
          delta_seconds: deltaSeconds,
          matched_at: new Date().toISOString(),
          min_read_confidence: confidence,
          matched_via: "live",
        },
      })
      .eq("id", v.id)
      .is("tow_confirmed_at", null)
      .select("id")
      .maybeSingle();

    if (updErr || !updated) {
      await supabase
        .from("partner_truck_sightings")
        .update({ consumed_by_violation_id: null })
        .eq("id", sighting.id);
      continue;
    }

    return json(
      {
        status: "confirmed",
        violation_id: v.id,
        truck_plate: sighting.truck_plate,
        delta_seconds: deltaSeconds,
      },
      200
    );
  }

  return json({ status: "no_matching_sighting_in_window" }, 200);
});
