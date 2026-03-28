import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const now = new Date().toISOString();

    // Expire visitor passes that have passed their valid_until time
    const { data: expired, error: expErr } = await supabase
      .from("visitor_passes")
      .update({ status: "expired" })
      .eq("status", "active")
      .lt("valid_until", now)
      .select("id, property_id, plate_text");

    if (expErr) {
      console.error("Error expiring passes:", expErr.message);
      return new Response(
        JSON.stringify({ error: "Failed to expire passes", detail: expErr.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        expired_count: expired?.length ?? 0,
        expired_passes: expired ?? [],
        checked_at: now,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
