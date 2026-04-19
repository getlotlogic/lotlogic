// Diagnostic endpoint that captures *whatever* a camera sends and dumps it
// to R2 + structured logs so we can inspect the exact wire format.
//
// Intended only for bringing up a new camera model. Delete or disable once
// camera-snapshot is known to work for that model.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AwsClient } from "aws4fetch";

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID")!;
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") ?? "parking-snapshots";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID")!;
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY")!;
const R2_PUBLIC_BASE_URL = Deno.env.get("R2_PUBLIC_BASE_URL")!;

const aws = new AwsClient({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  service: "s3",
  region: "auto",
});
const r2Endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}`;

Deno.serve(async (req: Request) => {
  // Probe: any non-POST returns a simple 200 so Milesight's URL-validation check
  // (if any) can't be what blocks us.
  if (req.method !== "POST") {
    return jsonResp(200, { ok: true, fn: "camera-debug", accepts: "any POST" });
  }

  const ts = Date.now();
  const reqId = crypto.randomUUID();
  const contentType = req.headers.get("content-type") ?? "(none)";
  const contentLength = req.headers.get("content-length") ?? "(unset)";
  const userAgent = req.headers.get("user-agent") ?? "(none)";
  const urlObj = new URL(req.url);

  // Collect all headers (case-insensitive dump)
  const headersObj: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headersObj[k] = v;

  const summary: Record<string, unknown> = {
    request_id: reqId,
    received_at: new Date(ts).toISOString(),
    method: req.method,
    url_path: urlObj.pathname + urlObj.search,
    content_type: contentType,
    content_length_header: contentLength,
    user_agent: userAgent,
    headers: headersObj,
  };

  try {
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      // Clone so we can inspect as formData and also store the raw body bytes.
      const bodyBytes = new Uint8Array(await req.arrayBuffer());
      summary.body_size_bytes = bodyBytes.byteLength;

      // Parse the multipart payload by re-constructing a Request on the bytes.
      const parts: Array<Record<string, unknown>> = [];
      try {
        const reconstructed = new Request("http://x/", {
          method: "POST",
          headers: { "content-type": contentType },
          body: bodyBytes,
        });
        const fd = await reconstructed.formData();
        let idx = 0;
        for (const [name, value] of fd.entries()) {
          if (value instanceof Blob) {
            const partBytes = new Uint8Array(await value.arrayBuffer());
            const partKey = `camera-debug/${reqId}/part-${idx}-${safeName(name)}.bin`;
            await putR2(partKey, partBytes, value.type || "application/octet-stream");
            parts.push({
              kind: "blob",
              field_name: name,
              filename: (value as File).name ?? null,
              mime: value.type || null,
              size_bytes: partBytes.byteLength,
              stored_url: `${R2_PUBLIC_BASE_URL}/${partKey}`,
            });
          } else {
            parts.push({ kind: "text", field_name: name, value: String(value).slice(0, 500) });
          }
          idx++;
        }
      } catch (e) {
        parts.push({ kind: "error", parse_error: String(e) });
      }
      summary.multipart_parts = parts;

      // Also stash the raw multipart bytes for byte-level inspection.
      const rawKey = `camera-debug/${reqId}/raw-multipart.bin`;
      await putR2(rawKey, bodyBytes, contentType);
      summary.raw_body_url = `${R2_PUBLIC_BASE_URL}/${rawKey}`;
    } else {
      // Binary / JSON / text — store raw, include a short text/hex preview.
      const bodyBytes = new Uint8Array(await req.arrayBuffer());
      summary.body_size_bytes = bodyBytes.byteLength;

      const looksTextual = contentType.startsWith("text/") ||
        contentType.includes("json") ||
        contentType.includes("xml") ||
        contentType.includes("form-urlencoded");
      if (looksTextual) {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes.slice(0, 2000));
        summary.body_text_preview = text;
      } else {
        // First 64 bytes as hex so we can eyeball the magic number.
        summary.body_hex_preview = Array.from(bodyBytes.slice(0, 64))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }

      const ext = guessExt(contentType, bodyBytes);
      const rawKey = `camera-debug/${reqId}/raw.${ext}`;
      await putR2(rawKey, bodyBytes, contentType || "application/octet-stream");
      summary.raw_body_url = `${R2_PUBLIC_BASE_URL}/${rawKey}`;
    }
  } catch (err) {
    summary.error = String(err);
  }

  // One JSON line in the function logs — grep-friendly.
  console.log(JSON.stringify({ camera_debug: summary }));

  return jsonResp(200, { ok: true, captured: summary });
});

async function putR2(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const url = `${r2Endpoint}/${encodeKey(key)}`;
  const signed = await aws.sign(new Request(url, {
    method: "PUT",
    body: bytes as BodyInit,
    headers: { "Content-Type": contentType || "application/octet-stream" },
  }));
  const res = await fetch(signed);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 PutObject ${res.status}: ${text.slice(0, 200)}`);
  }
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "unnamed";
}

function guessExt(contentType: string, bytes: Uint8Array): string {
  if (contentType.includes("jpeg") || (bytes[0] === 0xff && bytes[1] === 0xd8)) return "jpg";
  if (contentType.includes("png") || (bytes[0] === 0x89 && bytes[1] === 0x50)) return "png";
  if (contentType.includes("json")) return "json";
  if (contentType.startsWith("text/")) return "txt";
  return "bin";
}

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
