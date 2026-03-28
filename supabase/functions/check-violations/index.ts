import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const now = new Date().toISOString();
    let totalExpired = 0;
    const batchSize = 500;

    // Expire visitor passes in batches to avoid timeouts on large datasets
    while (true) {
      const { data: batch, error: batchErr } = await supabase
        .from("visitor_passes")
        .update({ status: "expired" })
        .eq("status", "active")
        .lt("valid_until", now)
        .select("id")
        .limit(batchSize);

      if (batchErr) {
        console.error("Error expiring passes:", batchErr.message);
        return new Response(
          JSON.stringify({ error: "Failed to expire passes", detail: batchErr.message, expired_so_far: totalExpired }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      totalExpired += batch?.length ?? 0;
      // If we got fewer than batchSize, we're done
      if (!batch || batch.length < batchSize) break;
    }

    return new Response(
      JSON.stringify({
        expired_count: totalExpired,
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
