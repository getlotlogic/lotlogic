// USDOT OCR fallback via ParkPow (Plate Recognizer's parent company).
// Fires when PR Snapshot returns zero plates. Reads USDOT / MC numbers off
// the truck side panel and synthesizes a plate-shaped result (DOT-1234567)
// so the state machine, sessions, holds, and email pipeline work unchanged.
//
// Spec: docs/superpowers/specs/2026-04-20-usdot-ocr-fallback-design.md
//
// Activation:
//   supabase secrets set PARKPOW_USDOT_TOKEN=<token from parkpow.com trial>
//   supabase secrets set ENABLE_USDOT_FALLBACK=true

const USDOT_ENDPOINT = "https://usdot-api.parkpow.com/api/v1/predict/";

// 5-8 digits per FMCSA. Accept USDOT / U.S.DOT / US DOT / USDOT# forms.
const DOT_RE = /\b(?:U\.?\s?S\.?\s?D\.?O\.?T\.?|USDOT)\s*#?\s*(\d{5,8})\b/i;
// MC (Motor Carrier) numbers — secondary identifier, also carrier-unique.
const MC_RE  = /\bMC\s*#?\s*(\d{5,8})\b/i;

export type UsdotResult =
  | { kind: "dot"; number: string; plate: string; raw_score: number; raw_text: string }
  | { kind: "mc";  number: string; plate: string; raw_score: number; raw_text: string }
  | { kind: "none" };

export type UsdotConfig = {
  token: string;
  minScore: number;
  cameraId?: string;       // optional passthrough to ParkPow for their analytics
  fetchImpl?: typeof fetch;
};

/**
 * Call ParkPow USDOT OCR on the image bytes. Extract the first DOT or MC
 * number from the response's `texts[]` that meets the score threshold.
 * Returns { kind: "none" } on any failure: the caller falls through to
 * "no-plate" behaviour. Errors are logged, never thrown — the plate
 * ingest must never fail because of a USDOT call.
 */
export async function extractUsdot(
  imageBytes: Uint8Array,
  cfg: UsdotConfig,
): Promise<UsdotResult> {
  const f = cfg.fetchImpl ?? fetch;
  const fd = new FormData();
  fd.append("image", new Blob([imageBytes as BlobPart], { type: "image/jpeg" }), "snap.jpg");
  if (cfg.cameraId) fd.append("camera", cfg.cameraId);

  let res: Response;
  try {
    res = await f(USDOT_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Token ${cfg.token}` },
      body: fd,
    });
  } catch (err) {
    console.warn(`usdot-ocr fetch failed: ${String(err)}`);
    return { kind: "none" };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`usdot-ocr non-2xx ${res.status}: ${text.slice(0, 200)}`);
    return { kind: "none" };
  }

  let payload: { texts?: Array<{ value?: string; score?: number }> };
  try {
    payload = await res.json();
  } catch (err) {
    console.warn(`usdot-ocr json parse failed: ${String(err)}`);
    return { kind: "none" };
  }

  const texts = Array.isArray(payload.texts) ? payload.texts : [];

  // First pass: DOT regex on any text above the score threshold.
  for (const t of texts) {
    const score = typeof t.score === "number" ? t.score : 0;
    if (score < cfg.minScore) continue;
    const val = String(t.value ?? "");
    const m = val.match(DOT_RE);
    if (m) {
      return {
        kind: "dot",
        number: m[1],
        plate: `DOT-${m[1]}`,
        raw_score: score,
        raw_text: val,
      };
    }
  }

  // Second pass: MC regex.
  for (const t of texts) {
    const score = typeof t.score === "number" ? t.score : 0;
    if (score < cfg.minScore) continue;
    const val = String(t.value ?? "");
    const m = val.match(MC_RE);
    if (m) {
      return {
        kind: "mc",
        number: m[1],
        plate: `MC-${m[1]}`,
        raw_score: score,
        raw_text: val,
      };
    }
  }

  return { kind: "none" };
}
