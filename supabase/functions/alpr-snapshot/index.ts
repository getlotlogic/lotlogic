import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PLATE_RECOGNIZER_URL = "https://api.platerecognizer.com/v1/plate-reader/";

type PlateRecognizerResult = {
  plate: string;
  score: number;
  dscore?: number;
  box?: { xmin: number; ymin: number; xmax: number; ymax: number };
  region?: { code: string; score: number };
  vehicle?: { type: string; score: number };
  candidates?: Array<{ plate: string; score: number }>;
};

type PlateRecognizerResponse = {
  processing_time: number;
  results: PlateRecognizerResult[];
  filename?: string;
  version?: number;
  camera_id?: string;
  timestamp?: string;
  image_width?: number;
  image_height?: number;
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function callPlateRecognizer(
  token: string,
  opts: { imageUrl?: string; imageBytes?: Uint8Array; regions?: string[]; cameraId?: string; mmc?: boolean },
): Promise<PlateRecognizerResponse> {
  const form = new FormData();
  if (opts.imageUrl) {
    form.append("upload_url", opts.imageUrl);
  } else if (opts.imageBytes) {
    form.append("upload", new Blob([opts.imageBytes]), "snapshot.jpg");
  } else {
    throw new Error("Either imageUrl or imageBytes must be provided");
  }
  if (opts.regions && opts.regions.length) {
    for (const r of opts.regions) form.append("regions", r);
  }
  if (opts.cameraId) form.append("camera_id", opts.cameraId);
  if (opts.mmc) form.append("mmc", "true");

  const res = await fetch(PLATE_RECOGNIZER_URL, {
    method: "POST",
    headers: { Authorization: `Token ${token}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PlateRecognizer ${res.status}: ${text}`);
  }
  return await res.json() as PlateRecognizerResponse;
}

function decodeBase64(b64: string): Uint8Array {
  const cleaned = b64.replace(/^data:image\/\w+;base64,/, "");
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const token = Deno.env.get("PLATE_RECOGNIZER_TOKEN");
  if (!token) return jsonResponse({ error: "PLATE_RECOGNIZER_TOKEN not configured" }, 500);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const webhookUrl = `${supabaseUrl}/functions/v1/alpr-webhook`;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const minScore = Number(Deno.env.get("PLATE_RECOGNIZER_MIN_SCORE") ?? "0.8");
  const regions = (Deno.env.get("PLATE_RECOGNIZER_REGIONS") ?? "us-ga")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  let body: {
    api_key?: string;
    image_url?: string;
    image_base64?: string;
    event_type?: "entry" | "exit" | "patrol";
    mmc?: boolean;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { api_key, image_url, image_base64, event_type, mmc } = body;

  if (!api_key) return jsonResponse({ error: "api_key is required" }, 400);
  if (!image_url && !image_base64) {
    return jsonResponse({ error: "image_url or image_base64 is required" }, 400);
  }

  let prResponse: PlateRecognizerResponse;
  try {
    prResponse = await callPlateRecognizer(token, {
      imageUrl: image_url,
      imageBytes: image_base64 ? decodeBase64(image_base64) : undefined,
      regions,
      mmc: mmc ?? false,
    });
  } catch (err) {
    return jsonResponse({ error: "PlateRecognizer call failed", detail: String(err) }, 502);
  }

  const plates = prResponse.results
    .filter((r) => r.score >= minScore)
    .map((r) => ({
      plate_text: r.plate,
      confidence: r.score,
      region: r.region?.code,
      vehicle: r.vehicle?.type,
      box: r.box,
    }));

  if (plates.length === 0) {
    return jsonResponse(
      { status: "no_plates", processing_time_ms: prResponse.processing_time, results: prResponse.results },
      200,
    );
  }

  const forwarded: Array<{ plate_text: string; webhook_status: number; webhook_body: unknown }> = [];
  for (const p of plates) {
    const hookRes = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        api_key,
        plate_text: p.plate_text,
        confidence: p.confidence,
        image_url: image_url ?? null,
        event_type: event_type ?? "entry",
        raw_data: {
          source: "platerecognizer",
          region: p.region,
          vehicle: p.vehicle,
          box: p.box,
          pr_processing_time: prResponse.processing_time,
          pr_version: prResponse.version,
        },
      }),
    });
    let hookBody: unknown;
    try {
      hookBody = await hookRes.json();
    } catch {
      hookBody = null;
    }
    forwarded.push({ plate_text: p.plate_text, webhook_status: hookRes.status, webhook_body: hookBody });
  }

  return jsonResponse(
    {
      status: "forwarded",
      detected_plates: plates.length,
      processing_time_ms: prResponse.processing_time,
      forwarded,
    },
    200,
  );
});
