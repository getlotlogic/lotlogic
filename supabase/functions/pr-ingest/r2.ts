import { AwsClient } from "aws4fetch";
import type { R2Uploader } from "./types.ts";

export type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  fetchImpl?: typeof fetch;
};

export function makeR2Uploader(cfg: R2Config): R2Uploader {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
  const f = cfg.fetchImpl ?? fetch;

  return async (key, bytes) => {
    const url = `${endpoint}/${encodeKey(key)}`;
    const signed = await aws.sign(new Request(url, {
      method: "PUT",
      body: bytes as BodyInit,
      headers: { "Content-Type": "image/jpeg" },
    }));
    const res = await f(signed);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `R2 PutObject ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, url: `${cfg.publicBaseUrl}/${encodeKey(key)}` };
  };
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
