// Plate Recognizer -> LotLogic webhook bridge.
//
// Receives webhooks from api.platerecognizer.com after the Milesight SC211 (or
// any other PR-integrated camera) posts a snapshot. Translates PR's envelope
// into the shape that our existing `alpr-webhook` edge function already
// understands, then fires-and-forgets the invocation so we 2xx back to PR
// quickly — PR auto-disables the hook if the target_url consistently errors.
//
// Content-Type handling:
//   - "Data Only" dashboard setting -> application/json, no image
//   - "Webhook with Image" -> multipart/form-data with a JSON field and an
//     `upload` blob containing the JPEG. When present we stash the image in
//     the `plate-snapshots` Supabase Storage bucket and pass its public URL
//     downstream. Storage failures are non-fatal.
//
// Failure philosophy: every error path returns HTTP 200 with a `status` field
// so PR doesn't rip down the webhook. Real errors go to the Supabase function
// logs; ops watches `alpr_cameras.last_seen_at` to confirm a camera is live.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SNAPSHOT_BUCKET = "plate-snapshots";

type PRResult = {
  plate: string;
  score: number;
  dscore?: number;
  box?: Record<string, unknown>;
  region?: Record<string, unknown>;
  vehicle?: Record<string, unknown>;
  candidates?: Array<Record<string, unknown>>;
  color?: unknown;
  orientation?: unknown;
  year?: unknown;
  direction?: number;
  direction_score?: number;
};

type PRPayload = {
  hook?: { target_url?: string; id?: string; event?: string };
  data?: {
    filename?: string;
    timestamp?: string;
    camera_id?: string;
    results?: PRResult[];
    usage?: Record<string, unknown>;
    processing_time?: number;
  };
};

function jsonOk(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Parse either the raw JSON body (Data Only mode) or the multipart form
// (Webhook with Image mode). PR sends the JSON envelope in a form field —
// common field names are "json" or "data"; we scan every text field as a
// fallback so firmware quirks don't break us.
async function parsePayload(
  req: Request,
): Promise<{ payload: PRPayload; imageBytes: Uint8Array | null; imageMime: string | null }> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("application/json")) {
    const payload = (await req.json()) as PRPayload;
    return { payload, imageBytes: null, imageMime: null };
  }

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    let payload: PRPayload | null = null;
    let imageBytes: Uint8Array | null = null;
    let imageMime: string | null = null;

    for (const [key, value] of form.entries()) {
      if (value instanceof File) {
        if (key === "upload" || !imageBytes) {
          imageBytes = new Uint8Array(await value.arrayBuffer());
          imageMime = value.type || "image/jpeg";
        }
        continue;
      }
      if (typeof value === "string" && !payload) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === "object" && "data" in parsed) {
            payload = parsed as PRPayload;
          }
        } catch {
          // Not JSON; keep looking.
        }
      }
    }

    if (!payload) {
      throw new Error("multipart body contained no JSON envelope");
    }
    return { payload, imageBytes, imageMime };
  }

  // Fallback: try JSON anyway. PR docs are definitive on the two modes above
  // but defensively handle a raw text/plain-ish body before giving up.
  const text = await req.text();
  try {
    return { payload: JSON.parse(text) as PRPayload, imageBytes: null, imageMime: null };
  } catch {
    throw new Error(`unsupported content-type: ${contentType || "(none)"}`);
  }
}

function safeFilename(input: string | undefined, fallbackExt: string): string {
  const base = (input ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (base) return base;
  return `snapshot-${Date.now()}.${fallbackExt}`;
}

function extFromMime(mime: string | null): string {
  if (!mime) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

// Uploads the snapshot to Supabase Storage and returns its public URL. Any
// failure is swallowed — the caller passes null downstream so the pipeline
// still fires. We log so ops can spot persistent upload problems.
async function uploadSnapshot(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  bytes: Uint8Array,
  mime: string | null,
  cameraId: string,
  filenameHint: string | undefined,
): Promise<string | null> {
  try {
    const ext = extFromMime(mime);
    const cleanHint = safeFilename(filenameHint, ext);
    const key = `${cameraId}/${Date.now()}-${cleanHint}`;
    const { error } = await supabase.storage
      .from(SNAPSHOT_BUCKET)
      .upload(key, bytes, {
        contentType: mime ?? "image/jpeg",
        upsert: false,
      });
    if (error) {
      console.error("plate-snapshots upload failed:", error.message);
      return null;
    }
    const { data } = supabase.storage.from(SNAPSHOT_BUCKET).getPublicUrl(key);
    return data?.publicUrl ?? null;
  } catch (err) {
    console.error("plate-snapshots upload threw:", err);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    // Still 200 so PR doesn't disable the hook if something external probes us.
    return jsonOk({ status: "method_not_allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const minScore = Number(Deno.env.get("PR_WEBHOOK_MIN_SCORE") ?? "0.8");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("alpr-pr-webhook missing SUPABASE_URL / SERVICE_ROLE_KEY");
    return jsonOk({ status: "server_misconfigured" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let payload: PRPayload;
  let imageBytes: Uint8Array | null = null;
  let imageMime: string | null = null;
  try {
    const parsed = await parsePayload(req);
    payload = parsed.payload;
    imageBytes = parsed.imageBytes;
    imageMime = parsed.imageMime;
  } catch (err) {
    console.error("alpr-pr-webhook parse failed:", err);
    return jsonOk({ status: "invalid_payload", detail: String(err) });
  }

  const data = payload.data ?? {};
  const cameraId = typeof data.camera_id === "string" ? data.camera_id.trim() : "";
  const results = Array.isArray(data.results) ? data.results : [];

  if (!cameraId) {
    return jsonOk({ status: "missing_camera_id" });
  }

  // PR sends webhooks for every frame in some configurations, including empty
  // reads. This is the common case, not an error.
  if (results.length === 0) {
    return jsonOk({ status: "no_plate_detected", camera_id: cameraId });
  }

  const top = results[0];
  if (!top || typeof top.plate !== "string" || !top.plate) {
    return jsonOk({ status: "no_plate_detected", camera_id: cameraId });
  }

  const score = typeof top.score === "number" ? top.score : 0;

  // Camera provisioning check — we intentionally return 200 on "not found" and
  // "disabled" so PR keeps the webhook alive while ops fixes the camera row.
  const { data: camera, error: camErr } = await supabase
    .from("alpr_cameras")
    .select("id, property_id, active, name")
    .eq("api_key", cameraId)
    .maybeSingle();

  if (camErr) {
    console.error("alpr_cameras lookup failed:", camErr.message);
    return jsonOk({ status: "camera_lookup_failed" });
  }
  if (!camera) {
    return jsonOk({ status: "camera_not_provisioned", camera_id: cameraId });
  }
  if (!camera.active) {
    return jsonOk({ status: "camera_disabled", camera_id: cameraId });
  }

  // Heartbeat — best-effort, don't block.
  supabase
    .from("alpr_cameras")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", camera.id)
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) console.error("last_seen_at update failed:", error.message);
    });

  // Confidence gate — matches alpr-snapshot's PLATE_RECOGNIZER_MIN_SCORE=0.8.
  if (score < minScore) {
    return jsonOk({
      status: "skipped_low_confidence",
      score,
      min_score: minScore,
      plate_text: top.plate,
    });
  }

  // Snapshot — Data Only webhooks skip this entirely.
  let imageUrl: string | null = null;
  if (imageBytes && imageBytes.length > 0) {
    imageUrl = await uploadSnapshot(supabase, imageBytes, imageMime, camera.id, data.filename);
  }

  // Translate the PR envelope into what alpr-webhook accepts. We trim the
  // raw_data to the top result plus the surrounding context (timestamp,
  // filename, processing_time) so we don't bloat plate_events.raw_data.
  const alprWebhookBody = {
    plate_text: top.plate,
    confidence: score,
    image_url: imageUrl,
    api_key: cameraId,
    event_type: "platerecognizer",
    raw_data: {
      source: "platerecognizer_webhook",
      filename: data.filename ?? null,
      timestamp: data.timestamp ?? null,
      processing_time: data.processing_time ?? null,
      pr_hook: payload.hook ?? null,
      result: top,
    },
  };

  // Fire-and-forget invocation of the existing webhook. alpr-webhook does its
  // own dedup + resident/visitor match + violation creation — we do NOT want
  // to block the PR response on all of that.
  const invokePromise = fetch(`${supabaseUrl}/functions/v1/alpr-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify(alprWebhookBody),
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`alpr-webhook invoke ${res.status}: ${text}`);
      }
    })
    .catch((err) => console.error("alpr-webhook invoke threw:", err));

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(invokePromise);
  }

  return jsonOk({
    status: "accepted",
    plate_text: top.plate,
    confidence: score,
    camera_id: cameraId,
    image_stored: imageUrl !== null,
  });
});
