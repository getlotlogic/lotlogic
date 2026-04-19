import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { makeR2Uploader } from "../pr-ingest/r2.ts";
import { matchPlate } from "../pr-ingest/match.ts";
import { normalizePlate } from "../pr-ingest/normalize.ts";
import { extractImageBytes } from "./extract.ts";
import { parsePath } from "./path.ts";

const URL_SECRET = Deno.env.get("CAMERA_SNAPSHOT_URL_SECRET") ?? Deno.env.get("PR_INGEST_URL_SECRET") ?? "";
const PR_TOKEN = Deno.env.get("PLATE_RECOGNIZER_TOKEN") ?? "";
const PR_MIN_SCORE = Number(Deno.env.get("PR_MIN_SCORE") ?? "0.8");
const PR_DEDUP_WINDOW_SECONDS = Number(Deno.env.get("PR_DEDUP_WINDOW_SECONDS") ?? "0");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID")!;
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") ?? "parking-snapshots";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID")!;
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY")!;
const R2_PUBLIC_BASE_URL = Deno.env.get("R2_PUBLIC_BASE_URL")!;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const r2 = makeR2Uploader({
  accountId: R2_ACCOUNT_ID,
  bucket: R2_BUCKET_NAME,
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  publicBaseUrl: R2_PUBLIC_BASE_URL,
});

Deno.serve(async (req: Request) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return json(200, { ok: true, fn: "camera-snapshot", accepts: "POST image bytes" });
  }
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const { apiKey, secret } = parsePath(new URL(req.url));
  if (!URL_SECRET || secret !== URL_SECRET) return json(401, { ok: false, error: "unauthorized" });
  if (!apiKey) return json(400, { ok: false, error: "missing_camera_api_key" });

  try {
    const cameraQ = await db
      .from("alpr_cameras")
      .select("id,property_id,api_key,active")
      .eq("api_key", apiKey)
      .eq("active", true)
      .limit(1);
    if (cameraQ.error) throw cameraQ.error;
    const camera = (cameraQ.data ?? [])[0];
    if (!camera) return json(200, { ok: false, reason: "unknown_camera", api_key: apiKey });

    const imageBytes = await extractImageBytes(req);
    if (!imageBytes) return json(200, { ok: false, reason: "no_image_bytes" });

    // Call Plate Recognizer synchronously. Network failure → 500 so the
    // camera retries; PR non-200 → log and 200 (don't punish the camera for
    // PR outages — we just drop the frame).
    const prResp = await callPlateRecognizer(imageBytes, apiKey);
    if (!prResp.ok) {
      console.warn("camera-snapshot PR call failed:", prResp.status, prResp.bodyText.slice(0, 200));
      return json(200, { ok: false, reason: "pr_call_failed", status: prResp.status });
    }

    const results = Array.isArray(prResp.data?.results) ? prResp.data.results : [];
    const surviving = results.filter((r: { score: number }) => r.score >= PR_MIN_SCORE);
    if (surviving.length === 0) {
      return json(200, { ok: true, events: 0, reason: "all_below_threshold", pr_results: results.length });
    }

    let eventCount = 0;
    let violationCount = 0;
    const now = new Date();

    for (const result of surviving) {
      const plateUpper = (result.plate as string).toUpperCase();
      const normalized = normalizePlate(result.plate as string);
      const epochMs = now.getTime();
      const dateStr = now.toISOString().slice(0, 10);
      const key = `${camera.property_id}/${dateStr}/${camera.api_key}-${epochMs}-${plateUpper}.jpg`;

      let imageUrl: string | null = null;
      let imageError: string | null = null;
      const upRes = await r2(key, imageBytes);
      if (upRes.ok) imageUrl = upRes.url;
      else imageError = upRes.error;

      let dedupSuppressed = false;
      if (PR_DEDUP_WINDOW_SECONDS > 0) {
        const since = new Date(now.getTime() - PR_DEDUP_WINDOW_SECONDS * 1000).toISOString();
        const recent = await db
          .from("plate_events")
          .select("id")
          .eq("property_id", camera.property_id)
          .eq("normalized_plate", normalized)
          .gte("created_at", since)
          .limit(1);
        if (recent.error) throw recent.error;
        if ((recent.data ?? []).length > 0) dedupSuppressed = true;
      }

      const outcome = dedupSuppressed
        ? { kind: "dedup_suppressed" as const }
        : await matchPlate(db, camera.property_id, normalized, now);

      const eventRow: Record<string, unknown> = {
        camera_id: camera.id,
        property_id: camera.property_id,
        plate_text: plateUpper,
        normalized_plate: normalized,
        confidence: result.score,
        image_url: imageUrl,
        event_type: "entry",
        raw_data: {
          ...result,
          _pr_response: prResp.data,
          _source: "camera-snapshot",
          ...(imageError ? { image_upload_error: imageError } : {}),
        },
        match_status: outcome.kind,
        match_reason: outcome.kind === "dedup_suppressed" ? "within window" : null,
        matched_at: outcome.kind !== "unmatched" && outcome.kind !== "dedup_suppressed" ? now.toISOString() : null,
        ...(outcome.kind === "resident" ? { resident_plate_id: outcome.resident_plate_id } : {}),
        ...(outcome.kind === "visitor_pass" ? { visitor_pass_id: outcome.visitor_pass_id } : {}),
      };

      const evIns = await db.from("plate_events").insert(eventRow).select().single();
      if (evIns.error) throw evIns.error;
      eventCount++;

      if (outcome.kind === "unmatched") {
        const vIns = await db.from("alpr_violations").insert({
          property_id: camera.property_id,
          plate_event_id: evIns.data.id,
          plate_text: plateUpper,
          status: "pending",
          violation_type: "alpr_unmatched",
        }).select().single();
        if (vIns.error) throw vIns.error;
        violationCount++;
      }
    }

    return json(200, { ok: true, events: eventCount, violations: violationCount });
  } catch (err) {
    console.error("camera-snapshot unhandled error:", err instanceof Error ? err.stack ?? err.message : err);
    return json(500, { ok: false, error: "internal_error" });
  }
});

async function callPlateRecognizer(
  imageBytes: Uint8Array,
  cameraId: string,
): Promise<{ ok: true; data: any } | { ok: false; status: number; bodyText: string }> {
  if (!PR_TOKEN) return { ok: false, status: 0, bodyText: "PLATE_RECOGNIZER_TOKEN missing" };
  const fd = new FormData();
  fd.append("upload", new Blob([imageBytes], { type: "image/jpeg" }), "snap.jpg");
  fd.append("camera_id", cameraId);
  const res = await fetch("https://api.platerecognizer.com/v1/plate-reader/", {
    method: "POST",
    headers: { Authorization: `Token ${PR_TOKEN}` },
    body: fd,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return { ok: false, status: res.status, bodyText };
  }
  const data = await res.json();
  return { ok: true, data };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
