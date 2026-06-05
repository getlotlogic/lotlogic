// camera-watchdog
//
// Ingest endpoint for the RUT-hosted pollers. Each RUT pings its camera every
// ~2 min and POSTs the result here; we write a row to public.heartbeats. The
// cloud can't reach the cameras (private ZeroTier mesh), so this push from the
// always-on RUT is our only true uptime signal. When a RUT loses power its
// POSTs stop entirely -> the absence is the site-brownout signal (detected by
// camera-down-check).
//
// Auth: shared secret stored in public.integration_secrets['rut_watchdog']
// (not in code/git). Sent as the `secret` body field or X-Watchdog-Secret.
//
// Body: { api_key: string (camera MAC), up: boolean, latency_ms?: number,
//         secret?: string, note?: string }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  let body: { api_key?: string; up?: boolean; latency_ms?: number; secret?: string; note?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const provided = body.secret || req.headers.get("x-watchdog-secret") || "";
  const { data: sec } = await db.from("integration_secrets").select("value").eq("key", "rut_watchdog").maybeSingle();
  if (!sec?.value || provided !== sec.value) return json({ error: "unauthorized" }, 401);

  if (!body.api_key || typeof body.up !== "boolean") return json({ error: "api_key and up required" }, 400);

  const { data: cam } = await db.from("alpr_cameras").select("id").eq("api_key", body.api_key).maybeSingle();
  if (!cam) return json({ error: "unknown_camera", api_key: body.api_key }, 404);

  const now = new Date().toISOString();
  const { error: hbErr } = await db.from("heartbeats").insert({
    camera_id: cam.id,
    received_at: now,
    status: body.up ? "up" : "down",
    latency_ms: body.latency_ms ?? null,
    note: body.note ?? "rut",
  });
  if (hbErr) return json({ error: "insert_failed", detail: hbErr.message }, 500);

  // Keep alpr_cameras.last_seen_at fresh on an up beat (drives existing health UI).
  if (body.up) await db.from("alpr_cameras").update({ last_seen_at: now }).eq("id", cam.id);

  return json({ ok: true, camera_id: cam.id, status: body.up ? "up" : "down" });
});
