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

// Real endpoint per OpenAPI (GET https://usdot.parkpow.com/api/v1/schema/).
// An earlier marketing page mentioned `usdot-api.parkpow.com` which does not
// resolve — ignore that.
const USDOT_ENDPOINT = "https://usdot.parkpow.com/api/v1/predict/";

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
  if (cfg.cameraId) fd.append("camera_id", cfg.cameraId);

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

  // Real response shape (from https://usdot.parkpow.com/api/v1/schema/):
  //   { results: [ { texts: [{value, score}], object: {label, score, value:{...}} } ],
  //     original_width, original_height, processing_time, timestamp }
  type OcrText = { value?: string; score?: number };
  type SinglePrediction = { texts?: OcrText[]; object?: { label?: string } };
  type PredictionResult = { results?: SinglePrediction[] };

  let payload: PredictionResult;
  try {
    payload = await res.json() as PredictionResult;
  } catch (err) {
    console.warn(`usdot-ocr json parse failed: ${String(err)}`);
    return { kind: "none" };
  }

  // Flatten every text from every detection so the regex search doesn't care
  // which detection box it came from. Keep the parent label in case we want
  // to log it for tuning.
  const allTexts: Array<{ text: OcrText; label: string }> = [];
  for (const r of payload.results ?? []) {
    const label = r.object?.label ?? "";
    for (const t of r.texts ?? []) allTexts.push({ text: t, label });
  }

  // First pass: DOT regex on any text above the score threshold.
  for (const { text: t, label } of allTexts) {
    const score = typeof t.score === "number" ? t.score : 0;
    if (score < cfg.minScore) continue;
    const val = String(t.value ?? "");
    const m = val.match(DOT_RE);
    if (m) {
      console.log(`usdot-ocr matched DOT from label=${label} score=${score}`);
      return { kind: "dot", number: m[1], plate: `DOT-${m[1]}`, raw_score: score, raw_text: val };
    }
  }

  // Second pass: MC regex.
  for (const { text: t, label } of allTexts) {
    const score = typeof t.score === "number" ? t.score : 0;
    if (score < cfg.minScore) continue;
    const val = String(t.value ?? "");
    const m = val.match(MC_RE);
    if (m) {
      console.log(`usdot-ocr matched MC from label=${label} score=${score}`);
      return { kind: "mc", number: m[1], plate: `MC-${m[1]}`, raw_score: score, raw_text: val };
    }
  }

  // Third pass: labels include strings like "USDOT"; if the OCR returned a
  // pure-digit value alongside a USDOT-ish label, synthesize a match.
  for (const { text: t, label } of allTexts) {
    const score = typeof t.score === "number" ? t.score : 0;
    if (score < cfg.minScore) continue;
    const val = String(t.value ?? "").trim();
    if (!/^\d{5,8}$/.test(val)) continue;
    const labelUp = label.toUpperCase();
    if (labelUp.includes("USDOT") || labelUp.includes("US DOT") || labelUp.includes("DOT ")) {
      console.log(`usdot-ocr matched digits-with-label label=${label} score=${score}`);
      return { kind: "dot", number: val, plate: `DOT-${val}`, raw_score: score, raw_text: val };
    }
    if (labelUp.includes("MC ") || labelUp === "MC") {
      return { kind: "mc", number: val, plate: `MC-${val}`, raw_score: score, raw_text: val };
    }
  }

  return { kind: "none" };
}
