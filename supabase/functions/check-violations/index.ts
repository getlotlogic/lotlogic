import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

serve(async (req) => {
  try {
    if (req.method !== "POST") return json(405, { error: "Method not allowed" });

    const internalToken = Deno.env.get("INTERNAL_TOKEN") ?? "";
    const provided = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!internalToken || provided !== internalToken) {
      return json(401, { error: "unauthorized" });
    }

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
        return json(500, { error: "Failed to expire passes", detail: batchErr.message, expired_so_far: totalExpired });
      }

      totalExpired += batch?.length ?? 0;
      // If we got fewer than batchSize, we're done
      if (!batch || batch.length < batchSize) break;
    }

    return json(200, {
      expired_count: totalExpired,
      checked_at: now,
    });
  } catch (err) {
    return json(500, { error: "Internal server error", detail: String(err) });
  }
});
