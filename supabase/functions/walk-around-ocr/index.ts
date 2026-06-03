// walk-around-ocr
//
// Operator-driven plate OCR for the in-app walk-around feature.
//
// Flow:
//   1. Operator on the Parking Log taps the camera button, takes a photo
//      of a truck plate with their phone.
//   2. Frontend POSTs the photo here (multipart: `upload` + `property_id`).
//   3. We verify their JWT, upload the photo to the private
//      `tow-evidence` Supabase Storage bucket under
//      `{property_id}/{yyyymmdd}/{uuid}.jpg`, and call Plate Recognizer
//      synchronously with the same image.
//   4. Return `{ photo_path, photo_signed_url, plate_text, plate_confidence,
//      candidates }`. The frontend stages this as a walk-queue entry and
//      decides what to do with it (match an existing pass, attach to an
//      open violation, or open a new towable).
//
// What this function does NOT do:
//   - Decide whether to tow. That's a deliberate human tap on the
//     frontend after seeing the OCR result + match.
//   - Write to alpr_violations. The tow action does that, through the
//     existing backend `/violations/{id}/force-bill` or the new
//     `/walk-around/tow` route (separate patch).
//   - Insert plate_events / plate_sessions. Walk-around photos are
//     evidence, not ALPR feed entries.
//
// Auth:
//   verify_jwt=true. The operator's session JWT must be present on the
//   Authorization header. We re-validate it here so the property scope
//   check has the operator's claims.
//
// Env:
//   PLATE_RECOGNIZER_TOKEN — same token camera-snapshot uses.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — for storage + RLS bypass
//     when we mint the signed URL (we already verified scope above).
//   PR_MIN_SCORE (default 0.5 — lower than the camera path because the
//     operator's phone tends to land cleaner shots, and we want to
//     surface low-confidence reads for human review rather than drop).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PR_TOKEN = Deno.env.get("PLATE_RECOGNIZER_TOKEN") ?? "";
const PR_MIN_SCORE = Number(Deno.env.get("PR_MIN_SCORE") ?? "0.5");
const TOW_EVIDENCE_BUCKET = "tow-evidence";
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24h for the operator + report

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Connection": "keep-alive" },
  });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

function normalizePlate(s: string | null | undefined): string {
  if (!s) return "";
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function yyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// Verify the caller's JWT against Supabase auth + extract the owner_id /
// partner_id claims we use for property-scope checks. Mirrors what the
// backend's require_subject dep does.
async function resolveSubject(req: Request): Promise<
  | { ok: true; ownerId: string | null; partnerId: string | null; userId: string }
  | { ok: false; status: number; error: string }
> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "missing_bearer_token" };
  }
  const token = auth.slice("Bearer ".length).trim();
  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data?.user) {
    return { ok: false, status: 401, error: "invalid_token" };
  }
  const claims = (data.user.app_metadata ?? {}) as Record<string, unknown>;
  const ownerId = typeof claims.owner_id === "string" ? claims.owner_id : null;
  const partnerId = typeof claims.partner_id === "string" ? claims.partner_id : null;
  if (!ownerId && !partnerId) {
    return { ok: false, status: 403, error: "no_property_scope" };
  }
  return { ok: true, ownerId, partnerId, userId: data.user.id };
}

// Check the operator's JWT can see this property_id. owner_id direct match,
// or partner_id via lots.partner_id join. Returns true on access granted.
async function canAccessProperty(
  propertyId: string,
  ownerId: string | null,
  partnerId: string | null,
): Promise<boolean> {
  if (ownerId) {
    const { data, error } = await adminClient
      .from("properties")
      .select("id")
      .eq("id", propertyId)
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (!error && data) return true;
  }
  if (partnerId) {
    const { data, error } = await adminClient
      .from("lots")
      .select("id")
      .eq("property_id", propertyId)
      .eq("partner_id", partnerId)
      .limit(1);
    if (!error && data && data.length > 0) return true;
  }
  return false;
}

// Plate Recognizer call — same shape as camera-snapshot, but tuned for
// operator-quality phone photos.
async function callPlateRecognizer(imageBytes: Uint8Array): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; bodyText: string }
> {
  if (!PR_TOKEN) {
    return { ok: false, status: 500, bodyText: "PLATE_RECOGNIZER_TOKEN missing" };
  }
  const fd = new FormData();
  const imagePart = imageBytes.buffer.slice(
    imageBytes.byteOffset,
    imageBytes.byteOffset + imageBytes.byteLength,
  ) as ArrayBuffer;
  fd.append("upload", new Blob([imagePart], { type: "image/jpeg" }), "walkaround.jpg");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch("https://api.platerecognizer.com/v1/plate-reader/", {
      method: "POST",
      headers: { Authorization: `Token ${PR_TOKEN}` },
      body: fd,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = (err as Error)?.name === "AbortError" ? "timeout" : ((err as Error)?.message ?? "fetch_failed");
    return { ok: false, status: 0, bodyText: reason };
  }
  clearTimeout(timer);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return { ok: false, status: res.status, bodyText };
  }
  return { ok: true, data: await res.json() };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  const subject = await resolveSubject(req);
  if (!subject.ok) {
    return json(subject.status, { ok: false, error: subject.error });
  }

  // multipart parse
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { ok: false, error: "invalid_multipart_body" });
  }
  const propertyId = String(form.get("property_id") ?? "").trim();
  const file = form.get("upload");
  if (!propertyId) return json(400, { ok: false, error: "missing_property_id" });
  if (!(file instanceof File)) return json(400, { ok: false, error: "missing_upload" });
  if (file.size === 0) return json(400, { ok: false, error: "empty_upload" });
  if (file.size > 4 * 1024 * 1024) return json(413, { ok: false, error: "upload_too_large" });

  const canAccess = await canAccessProperty(propertyId, subject.ownerId, subject.partnerId);
  if (!canAccess) {
    return json(403, { ok: false, error: "property_access_denied" });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Upload to tow-evidence bucket first so we have evidence even if PR fails.
  const now = new Date();
  const uuid = crypto.randomUUID();
  const objectPath = `${propertyId}/${yyyymmdd(now)}/${uuid}.jpg`;
  const uploadRes = await adminClient.storage
    .from(TOW_EVIDENCE_BUCKET)
    .upload(objectPath, bytes, {
      contentType: file.type || "image/jpeg",
      upsert: false,
    });
  if (uploadRes.error) {
    return json(500, { ok: false, error: "storage_upload_failed", detail: uploadRes.error.message });
  }

  // Sign the URL so the frontend can preview the photo without exposing
  // the bucket. TTL covers the operator's working day + the report cycle.
  const signed = await adminClient.storage
    .from(TOW_EVIDENCE_BUCKET)
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
  const photoSignedUrl = signed.data?.signedUrl ?? null;

  // OCR. We continue and return the photo even if PR fails — the
  // operator can still manually type the plate and tow.
  const pr = await callPlateRecognizer(bytes);

  if (!pr.ok) {
    return json(200, {
      ok: true,
      property_id: propertyId,
      photo_path: objectPath,
      photo_signed_url: photoSignedUrl,
      ocr: { ok: false, status: pr.status, error: pr.bodyText },
      plate_text: null,
      plate_confidence: 0,
      candidates: [],
    });
  }

  const results = Array.isArray((pr.data as { results?: unknown[] }).results)
    ? ((pr.data as { results: Array<{ plate?: string; score?: number; candidates?: Array<{ plate?: string; score?: number }> }> }).results)
    : [];

  // Pick the highest-scoring read, gated by PR_MIN_SCORE.
  const ranked = results
    .map((r) => ({ plate: normalizePlate(r.plate), score: Number(r.score ?? 0) }))
    .filter((r) => r.plate.length > 0)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? { plate: "", score: 0 };

  // Capture the top 3 candidates per read so the operator can choose if
  // the top hit looks wrong on screen vs the photo.
  const candidates = results
    .flatMap((r) => r.candidates ?? [])
    .map((c) => ({ plate: normalizePlate(c.plate), score: Number(c.score ?? 0) }))
    .filter((c) => c.plate.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return json(200, {
    ok: true,
    property_id: propertyId,
    photo_path: objectPath,
    photo_signed_url: photoSignedUrl,
    plate_text: best.score >= PR_MIN_SCORE ? best.plate : "",
    plate_confidence: best.score,
    candidates,
    ocr: { ok: true, used_threshold: PR_MIN_SCORE },
  });
});
