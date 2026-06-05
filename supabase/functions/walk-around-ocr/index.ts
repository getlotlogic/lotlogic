// walk-around-ocr — operator-driven plate OCR for the in-app walk-around.
// Auth: verifies the backend-issued HS256 JWT directly (dashboard does NOT use
// Supabase Auth — auth.users is empty; tokens signed by FastAPI backend with
// JWT_SECRET, top-level owner_id/partner_id claims). Uploads photo to private
// tow-evidence bucket, OCRs via Plate Recognizer, returns plate + candidates +
// vehicle attributes (make/model/color/type/region/orientation via mmc=true).
// Does NOT write violations. Partner scope = properties.tow_company_id.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const JWT_SECRET = Deno.env.get("JWT_SECRET") ?? "";
const PR_TOKEN = Deno.env.get("PLATE_RECOGNIZER_TOKEN") ?? Deno.env.get("PLATE_RECOGNIZER_API_KEY") ?? "";
const PR_MIN_SCORE = Number(Deno.env.get("PR_MIN_SCORE") ?? "0.5");
// MMC = make/model/color (a paid Plate Recognizer add-on). Default on; set
// PR_MMC=false to disable without a redeploy if the plan doesn't include it.
const PR_MMC = (Deno.env.get("PR_MMC") ?? "true").toLowerCase() !== "false";
const TOW_EVIDENCE_BUCKET = "tow-evidence";
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Connection": "keep-alive" },
  });
}
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}
function normalizePlate(s) {
  if (!s) return "";
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function yyyymmdd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function bytesToB64url(arr) {
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function verifyBackendJwt(token) {
  if (!JWT_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`)),
  );
  if (bytesToB64url(expected) !== sig) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) return null;
  return payload;
}
async function resolveSubject(req) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return { ok: false, status: 401, error: "missing_bearer_token" };
  const token = auth.slice("Bearer ".length).trim();
  const claims = await verifyBackendJwt(token);
  if (!claims) return { ok: false, status: 401, error: "invalid_token" };
  const ownerId = typeof claims.owner_id === "string" ? claims.owner_id : null;
  const partnerId = typeof claims.partner_id === "string" ? claims.partner_id : null;
  if (!ownerId && !partnerId) return { ok: false, status: 403, error: "no_property_scope" };
  return { ok: true, ownerId, partnerId, userId: String(claims.sub ?? "") };
}
async function canAccessProperty(propertyId, ownerId, partnerId) {
  if (ownerId) {
    const { data, error } = await adminClient
      .from("properties").select("id").eq("id", propertyId).eq("owner_id", ownerId).maybeSingle();
    if (!error && data) return true;
  }
  if (partnerId) {
    const { data, error } = await adminClient
      .from("properties").select("id").eq("id", propertyId).eq("tow_company_id", partnerId).maybeSingle();
    if (!error && data) return true;
  }
  return false;
}
async function callPlateRecognizer(imageBytes) {
  if (!PR_TOKEN) return { ok: false, status: 500, bodyText: "PLATE_RECOGNIZER_TOKEN missing" };
  const fd = new FormData();
  const imagePart = imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength);
  fd.append("upload", new Blob([imagePart], { type: "image/jpeg" }), "walkaround.jpg");
  // Ask Plate Recognizer for make/model/color (paid MMC add-on). If the plan
  // doesn't include it, PR still returns the plate; the mmc fields just come
  // back empty. Toggle off via PR_MMC=false.
  if (PR_MMC) fd.append("mmc", "true");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let res;
  try {
    res = await fetch("https://api.platerecognizer.com/v1/plate-reader/", {
      method: "POST", headers: { Authorization: `Token ${PR_TOKEN}` }, body: fd, signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err?.name === "AbortError" ? "timeout" : (err?.message ?? "fetch_failed");
    return { ok: false, status: 0, bodyText: reason };
  }
  clearTimeout(timer);
  if (!res.ok) return { ok: false, status: res.status, bodyText: await res.text().catch(() => "") };
  return { ok: true, data: await res.json() };
}

// Pull the vehicle make/model/color/type/region/orientation out of a single
// Plate Recognizer result object. All fields optional (depend on MMC plan +
// what PR could see in the frame).
function extractVehicle(r) {
  if (!r || typeof r !== "object") return null;
  const mm = Array.isArray(r.model_make) && r.model_make[0] ? r.model_make[0] : null;
  const col = Array.isArray(r.color) && r.color[0] ? r.color[0] : null;
  const ori = Array.isArray(r.orientation) && r.orientation[0] ? r.orientation[0] : null;
  const v = {
    type: r.vehicle?.type ?? null,
    make: mm?.make ?? null,
    model: mm?.model ?? null,
    make_model_score: mm?.score ?? null,
    color: col?.color ?? null,
    color_score: col?.score ?? null,
    region: r.region?.code ?? null,
    orientation: ori?.orientation ?? null,
  };
  // Return null if PR gave us nothing useful, so the frontend can skip the row.
  const hasAny = v.type || v.make || v.model || v.color || v.region || v.orientation;
  return hasAny ? v : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const subject = await resolveSubject(req);
  if (!subject.ok) return json(subject.status, { ok: false, error: subject.error });

  let form;
  try { form = await req.formData(); } catch { return json(400, { ok: false, error: "invalid_multipart_body" }); }
  const propertyId = String(form.get("property_id") ?? "").trim();
  const file = form.get("upload");
  if (!propertyId) return json(400, { ok: false, error: "missing_property_id" });
  if (!(file instanceof File)) return json(400, { ok: false, error: "missing_upload" });
  if (file.size === 0) return json(400, { ok: false, error: "empty_upload" });
  if (file.size > 4 * 1024 * 1024) return json(413, { ok: false, error: "upload_too_large" });

  if (!(await canAccessProperty(propertyId, subject.ownerId, subject.partnerId))) {
    return json(403, { ok: false, error: "property_access_denied" });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const now = new Date();
  const objectPath = `${propertyId}/${yyyymmdd(now)}/${crypto.randomUUID()}.jpg`;
  const uploadRes = await adminClient.storage.from(TOW_EVIDENCE_BUCKET)
    .upload(objectPath, bytes, { contentType: file.type || "image/jpeg", upsert: false });
  if (uploadRes.error) return json(500, { ok: false, error: "storage_upload_failed", detail: uploadRes.error.message });

  const signed = await adminClient.storage.from(TOW_EVIDENCE_BUCKET).createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
  const photoSignedUrl = signed.data?.signedUrl ?? null;

  const pr = await callPlateRecognizer(bytes);
  if (!pr.ok) {
    return json(200, {
      ok: true, property_id: propertyId, photo_path: objectPath, photo_signed_url: photoSignedUrl,
      ocr: { ok: false, status: pr.status, error: pr.bodyText },
      plate_text: null, plate_confidence: 0, candidates: [], vehicle: null,
    });
  }
  const results = Array.isArray(pr.data.results) ? pr.data.results : [];
  // Keep the full result object for the top read so we can pull its vehicle
  // attributes (make/model/color/type) — they live alongside the plate.
  const scored = results
    .map((r) => ({ r, plate: normalizePlate(r.plate), score: Number(r.score ?? 0) }))
    .filter((x) => x.plate.length > 0)
    .sort((a, b) => b.score - a.score);
  const top = scored[0] ?? null;
  const best = top ? { plate: top.plate, score: top.score } : { plate: "", score: 0 };
  const vehicle = extractVehicle(top?.r);
  const candidates = results
    .flatMap((r) => r.candidates ?? [])
    .map((c) => ({ plate: normalizePlate(c.plate), score: Number(c.score ?? 0) }))
    .filter((c) => c.plate.length > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return json(200, {
    ok: true, property_id: propertyId, photo_path: objectPath, photo_signed_url: photoSignedUrl,
    plate_text: best.score >= PR_MIN_SCORE ? best.plate : "",
    plate_confidence: best.score, candidates, vehicle,
    ocr: { ok: true, used_threshold: PR_MIN_SCORE, mmc: PR_MMC },
  });
});
