import { AwsClient } from "aws4fetch";

// URL layouts accepted:
//   /functions/v1/camera-snapshot/<secret>                      (identity from body)
//   /functions/v1/camera-snapshot/<api_key>/<secret>             (identity from path)
// The Supabase runtime delivers the path without the `/functions/v1` prefix,
// so we strip both forms.

export function parsePath(url: URL): { apiKey: string | null; secret: string | null } {
  const stripped = url.pathname
    .replace(/^\/functions\/v1\/camera-snapshot\/?/, "")
    .replace(/^\/camera-snapshot\/?/, "");
  const parts = stripped.split("/").filter(Boolean);
  if (parts.length === 1) {
    return { apiKey: null, secret: parts[0] };
  }
  if (parts.length >= 2) {
    return { apiKey: parts[0], secret: parts[1] };
  }
  return { apiKey: null, secret: null };
}

// ---------------------------------------------------------------------------
// R2 object keys (Wave 2.5 retention, Task 8a)
//
// Every camera frame this function writes to R2 is prefixed by kind, so a
// Cloudflare lifecycle rule can target each one independently:
//   reads/   the record of what happened — long-retention (365d)
//   diag/    sidecar/PR rejection diagnostics — short-lived
//   debug/   raw-frame captures for onboarding new cameras — short-lived
// `objectKey` is the ONE place that composes the kind/property/day/rest
// shape so a fifth writer can't invent a sixth. `rest` is everything after
// the property/day segments (camera + epoch + whatever else identifies the
// frame).
// ---------------------------------------------------------------------------

export type ObjectKind = "reads" | "diag" | "debug";

export function objectKey(kind: ObjectKind, propertyId: string, dateStr: string, rest: string): string {
  return `${kind}/${propertyId}/${dateStr}/${rest}`;
}

// The evidence copy has its own shape: no date segment, keyed by the
// violation id (not camera/epoch) because it is meant to outlive the read's
// own lifecycle for as long as the violation itself is retained.
export function evidenceKey(propertyId: string, violationId: string): string {
  return `evidence/${propertyId}/${violationId}.jpg`;
}

export function encodeR2Key(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------
// R2 CopyObject (Wave 2.5 retention, Task 8a)
//
// Mirrors ../pr-ingest/r2.ts's makeR2Uploader (same AwsClient/SigV4 setup,
// same fetchImpl injection point for tests) but issues an S3-compatible
// CopyObject instead of a PutObject — metadata-only, no bytes re-uploaded.
// Lives here rather than in the shared pr-ingest/r2.ts because it is a
// camera-snapshot-only concern (pr-ingest never writes an evidence/ copy).
// ---------------------------------------------------------------------------

export type R2CopyConfig = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
};

export type R2Copier = (sourceKey: string, destKey: string) => Promise<
  { ok: true } | { ok: false; error: string }
>;

export function makeR2Copier(cfg: R2CopyConfig): R2Copier {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
  const f = cfg.fetchImpl ?? fetch;

  return async (sourceKey, destKey) => {
    const url = `${endpoint}/${encodeR2Key(destKey)}`;
    const signed = await aws.sign(new Request(url, {
      method: "PUT",
      headers: { "x-amz-copy-source": `/${cfg.bucket}/${encodeR2Key(sourceKey)}` },
    }));
    const res = await f(signed);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `R2 CopyObject ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  };
}
