import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalizePlate(plate: string): string {
  return (plate || "").toUpperCase().replace(/[\s\-\.]/g, "").trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceRoleKey);

  try {
    // 1. Validate API key
    const apiKey = req.headers.get("x-api-key");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing x-api-key header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: camera, error: camErr } = await sb
      .from("alpr_cameras")
      .select("id, property_id, direction, is_active")
      .eq("api_key", apiKey)
      .single();

    if (camErr || !camera) {
      return new Response(JSON.stringify({ error: "Invalid API key" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!camera.is_active) {
      return new Response(JSON.stringify({ error: "Camera is deactivated" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Parse request body
    const body = await req.json();
    const plateRaw = body.plate || body.plate_number || body.license_plate || "";
    const plate = normalizePlate(plateRaw);
    if (!plate) {
      return new Response(JSON.stringify({ error: "Missing plate number" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const confidence = body.confidence || body.confidence_score || null;
    const direction = body.direction || camera.direction;
    const propertyId = camera.property_id;

    // 3. Store ALPR image if provided (base64 or URL)
    let imageUrl: string | null = body.image_url || null;
    if (body.image_base64 && !imageUrl) {
      const imageBytes = Uint8Array.from(atob(body.image_base64), (c) => c.charCodeAt(0));
      const fileName = `${propertyId}/${Date.now()}_${plate}.jpg`;
      const { data: upload } = await sb.storage
        .from("alpr-images")
        .upload(fileName, imageBytes, { contentType: "image/jpeg" });
      if (upload?.path) {
        const { data: urlData } = sb.storage.from("alpr-images").getPublicUrl(upload.path);
        imageUrl = urlData?.publicUrl || null;
      }
    }

    // 4. Classify the plate
    let plateType = "unknown";

    // Check resident plates
    const { data: resident } = await sb
      .from("resident_plates")
      .select("id")
      .eq("property_id", propertyId)
      .eq("plate_number", plate)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (resident) {
      plateType = "resident";
    } else {
      // Check active visitor passes
      const { data: activePass } = await sb
        .from("visitor_passes")
        .select("id, status, expires_at")
        .eq("property_id", propertyId)
        .eq("plate_number", plate)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activePass) {
        const isExpired = new Date(activePass.expires_at).getTime() < Date.now();
        if (isExpired) {
          plateType = "visitor_expired";
        } else {
          plateType = "visitor_active";

          // If exit event, mark pass as completed
          if (direction === "exit") {
            await sb
              .from("visitor_passes")
              .update({ status: "completed", completed_at: new Date().toISOString() })
              .eq("id", activePass.id);
          }
        }
      } else {
        // Check for any expired pass
        const { data: expiredPass } = await sb
          .from("visitor_passes")
          .select("id")
          .eq("property_id", propertyId)
          .eq("plate_number", plate)
          .eq("status", "expired")
          .limit(1)
          .maybeSingle();

        if (expiredPass) {
          plateType = "visitor_expired";
        }
      }
    }

    // 5. Insert plate event
    const { data: event, error: eventErr } = await sb
      .from("plate_events")
      .insert({
        camera_id: camera.id,
        property_id: propertyId,
        plate_number: plate,
        direction,
        confidence_score: confidence,
        image_url: imageUrl,
        plate_type: plateType,
      })
      .select("id")
      .single();

    if (eventErr) {
      throw new Error(`Failed to insert plate event: ${eventErr.message}`);
    }

    // 6. Create violation for unknown plates (no_pass type)
    if (plateType === "unknown" && direction === "entry") {
      // Check if there's already a pending violation for this plate at this property
      const { data: existingViolation } = await sb
        .from("alpr_violations")
        .select("id")
        .eq("property_id", propertyId)
        .eq("plate_number", plate)
        .in("status", ["pending", "dispatched"])
        .limit(1)
        .maybeSingle();

      if (!existingViolation) {
        await sb.from("alpr_violations").insert({
          property_id: propertyId,
          plate_number: plate,
          plate_event_entry_id: event.id,
          violation_type: "no_pass",
          image_url: imageUrl,
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        plate_number: plate,
        plate_type: plateType,
        direction,
        event_id: event.id,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
