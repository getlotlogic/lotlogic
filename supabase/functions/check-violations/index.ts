import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceRoleKey);

  try {
    // 1. Find all active passes that have expired beyond grace period
    // We need to join with properties to get the grace_period_minutes
    const { data: properties, error: propErr } = await sb
      .from("properties")
      .select("id, grace_period_minutes");

    if (propErr) throw new Error(`Failed to fetch properties: ${propErr.message}`);

    let totalExpired = 0;
    let totalViolationsCreated = 0;

    for (const property of properties || []) {
      const graceMins = property.grace_period_minutes || 15;
      const cutoff = new Date(Date.now() - graceMins * 60 * 1000).toISOString();

      // Find active passes where expires_at + grace period has passed
      const { data: expiredPasses, error: passErr } = await sb
        .from("visitor_passes")
        .select("id, plate_number, property_id, started_at, expires_at")
        .eq("property_id", property.id)
        .eq("status", "active")
        .lt("expires_at", cutoff);

      if (passErr || !expiredPasses?.length) continue;
      totalExpired += expiredPasses.length;

      for (const pass of expiredPasses) {
        // Check if there's an exit event after the pass started
        const { data: exitEvent } = await sb
          .from("plate_events")
          .select("id")
          .eq("property_id", pass.property_id)
          .eq("plate_number", pass.plate_number)
          .eq("direction", "exit")
          .gte("timestamp", pass.started_at)
          .limit(1)
          .maybeSingle();

        if (exitEvent) {
          // Vehicle has exited — mark pass as completed
          await sb
            .from("visitor_passes")
            .update({ status: "completed", completed_at: new Date().toISOString() })
            .eq("id", pass.id);
          continue;
        }

        // No exit event — check if violation already exists (idempotency)
        const { data: existingViolation } = await sb
          .from("alpr_violations")
          .select("id")
          .eq("visitor_pass_id", pass.id)
          .limit(1)
          .maybeSingle();

        if (existingViolation) {
          // Already flagged, just update the pass status
          await sb
            .from("visitor_passes")
            .update({ status: "expired" })
            .eq("id", pass.id);
          continue;
        }

        // Find the entry event for this plate
        const { data: entryEvent } = await sb
          .from("plate_events")
          .select("id, image_url")
          .eq("property_id", pass.property_id)
          .eq("plate_number", pass.plate_number)
          .eq("direction", "entry")
          .gte("timestamp", pass.started_at)
          .order("timestamp", { ascending: false })
          .limit(1)
          .maybeSingle();

        // Update pass status to expired
        await sb
          .from("visitor_passes")
          .update({ status: "expired" })
          .eq("id", pass.id);

        // Create violation
        await sb.from("alpr_violations").insert({
          property_id: pass.property_id,
          visitor_pass_id: pass.id,
          plate_number: pass.plate_number,
          plate_event_entry_id: entryEvent?.id || null,
          violation_type: "expired_pass",
          image_url: entryEvent?.image_url || null,
        });

        totalViolationsCreated++;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        expired_passes_found: totalExpired,
        violations_created: totalViolationsCreated,
        checked_at: new Date().toISOString(),
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
