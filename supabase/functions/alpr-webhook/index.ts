import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json();
    const { plate_text, confidence, image_url, api_key, event_type, raw_data } = body;

    if (!plate_text || !api_key) {
      return new Response(
        JSON.stringify({ error: "plate_text and api_key are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate API key and get camera info
    const { data: camera, error: camErr } = await supabase
      .from("alpr_cameras")
      .select("id, property_id, active")
      .eq("api_key", api_key)
      .single();

    if (camErr || !camera) {
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!camera.active) {
      return new Response(
        JSON.stringify({ error: "Camera is disabled" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update camera last_seen_at
    await supabase
      .from("alpr_cameras")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", camera.id);

    // Normalize and validate plate text
    const normalizedPlate = plate_text.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalizedPlate.length < 2) {
      return new Response(
        JSON.stringify({ error: "plate_text too short after normalization" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Dedup: skip if same plate was seen at this property in the last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: recentEvent } = await supabase
      .from("plate_events")
      .select("id")
      .eq("property_id", camera.property_id)
      .eq("plate_text", normalizedPlate)
      .gte("created_at", fiveMinAgo)
      .limit(1);

    if (recentEvent && recentEvent.length > 0) {
      return new Response(
        JSON.stringify({ status: "duplicate_skipped", plate_text: normalizedPlate }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const { data: plateEvent, error: eventErr } = await supabase
      .from("plate_events")
      .insert({
        camera_id: camera.id,
        property_id: camera.property_id,
        plate_text: normalizedPlate,
        confidence: confidence ?? null,
        image_url: image_url ?? null,
        event_type: event_type ?? "entry",
        raw_data: raw_data ?? null,
      })
      .select()
      .single();

    if (eventErr) {
      return new Response(
        JSON.stringify({ error: "Failed to create plate event", detail: eventErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fire-and-forget: ask tow-confirm whether this plate belongs to an
    // enforcement partner's tow truck. If so, it records a sighting and
    // may stamp tow_confirmed_at on an open violation. We never block the
    // webhook response on this — a slow partner-lookup shouldn't delay the
    // resident/visitor/violation decision path below.
    const supabaseUrlForConfirm = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKeyForConfirm = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const towConfirmController = new AbortController();
    const towConfirmTimeoutId = setTimeout(() => towConfirmController.abort(), 1500);
    const towConfirmPromise = fetch(`${supabaseUrlForConfirm}/functions/v1/tow-confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKeyForConfirm}`,
      },
      body: JSON.stringify({ plate_event_id: plateEvent.id }),
      signal: towConfirmController.signal,
    })
      .catch((err) => console.error("tow-confirm invoke failed:", err))
      .finally(() => clearTimeout(towConfirmTimeoutId));
    // deno-lint-ignore no-explicit-any
    const edgeRuntimeForConfirm = (globalThis as any).EdgeRuntime;
    if (edgeRuntimeForConfirm?.waitUntil) {
      edgeRuntimeForConfirm.waitUntil(towConfirmPromise);
    }

    // Check against approved resident plates (pending registrations are not authorized)
    const { data: residentMatch } = await supabase
      .from("resident_plates")
      .select("id")
      .eq("property_id", camera.property_id)
      .eq("plate_text", normalizedPlate)
      .eq("active", true)
      .eq("status", "approved")
      .limit(1);

    if (residentMatch && residentMatch.length > 0) {
      return new Response(
        JSON.stringify({ status: "authorized", type: "resident", plate_event_id: plateEvent.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check against active visitor passes
    const now = new Date().toISOString();
    const { data: visitorMatch } = await supabase
      .from("visitor_passes")
      .select("id")
      .eq("property_id", camera.property_id)
      .eq("plate_text", normalizedPlate)
      .eq("status", "active")
      .lte("valid_from", now)
      .gte("valid_until", now)
      .limit(1);

    if (visitorMatch && visitorMatch.length > 0) {
      return new Response(
        JSON.stringify({ status: "authorized", type: "visitor", plate_event_id: plateEvent.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // No match — create ALPR violation
    const { data: violation, error: violErr } = await supabase
      .from("alpr_violations")
      .insert({
        property_id: camera.property_id,
        plate_event_id: plateEvent.id,
        plate_text: normalizedPlate,
        status: "pending",
      })
      .select()
      .single();

    if (violErr) {
      return new Response(
        JSON.stringify({ error: "Failed to create violation", detail: violErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const dispatchPromise = fetch(`${supabaseUrl}/functions/v1/tow-dispatch-sms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ violation_id: violation.id }),
    }).catch((err) => console.error("tow-dispatch-sms invoke failed:", err));
    // deno-lint-ignore no-explicit-any
    const edgeRuntime = (globalThis as any).EdgeRuntime;
    if (edgeRuntime?.waitUntil) {
      edgeRuntime.waitUntil(dispatchPromise);
    }

    return new Response(
      JSON.stringify({ status: "violation_created", violation_id: violation.id, plate_event_id: plateEvent.id }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
