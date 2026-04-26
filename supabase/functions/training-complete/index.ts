// Modal calls this when a training run finishes. We pull the freshly-uploaded
// ONNX from R2 and commit it to GitHub at openalpr-sidecar/models/lotlogic-plate.onnx.
// The push to main triggers Railway to redeploy the sidecar with the new model.
//
// Required secrets:
//   - WEBHOOK_TOKEN          shared with Modal; we reject requests without it
//   - GITHUB_PAT             fine-grained PAT with contents:write to getlotlogic/lotlogic
//   - GITHUB_OWNER           "getlotlogic"
//   - GITHUB_REPO            "lotlogic"
//   - GITHUB_BRANCH          "main"
//   - R2_ACCOUNT_ID
//   - R2_ACCESS_KEY_ID
//   - R2_SECRET_ACCESS_KEY
//   - R2_BUCKET_NAME         "parking-snapshots"
//
// Modal POST body shape (see scripts/modal-train-yolo.py):
//   {
//     ok: true,
//     model_key_versioned: "models/lotlogic-plate-20260426T120000Z.onnx",
//     model_key_latest: "models/lotlogic-plate-latest.onnx",
//     model_size_bytes: 8800000,
//     labeled_count, train_count, val_count, metrics, ...
//   }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const WEBHOOK_TOKEN = Deno.env.get("WEBHOOK_TOKEN") ?? "";
const GITHUB_PAT = Deno.env.get("GITHUB_PAT") ?? "";
const GITHUB_OWNER = Deno.env.get("GITHUB_OWNER") ?? "getlotlogic";
const GITHUB_REPO = Deno.env.get("GITHUB_REPO") ?? "lotlogic";
const GITHUB_BRANCH = Deno.env.get("GITHUB_BRANCH") ?? "main";
const TARGET_PATH = "openalpr-sidecar/models/lotlogic-plate.onnx";

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID") ?? "";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") ?? "";
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "";
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") ?? "parking-snapshots";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  // Bearer-token auth — Modal includes this header per scripts/modal-train-yolo.py.
  const auth = req.headers.get("authorization") || "";
  const provided = auth.replace(/^Bearer\s+/i, "");
  if (!WEBHOOK_TOKEN || provided !== WEBHOOK_TOKEN) {
    return json(401, { ok: false, error: "invalid_token" });
  }

  let payload: {
    ok: boolean;
    model_key_versioned?: string;
    model_key_latest?: string;
    model_size_bytes?: number;
    labeled_count?: number;
    train_count?: number;
    val_count?: number;
    metrics?: Record<string, number>;
    wall_time_sec?: number;
    trained_at?: string;
    reason?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  if (!payload.ok) {
    console.log("[training-complete] training reported failure:", payload.reason);
    return json(200, { ok: true, note: "training_skipped_or_failed", reason: payload.reason });
  }
  if (!payload.model_key_latest) {
    return json(400, { ok: false, error: "missing_model_key_latest" });
  }
  if (!GITHUB_PAT) {
    return json(500, { ok: false, error: "GITHUB_PAT missing" });
  }

  // 1. Pull the ONNX from R2.
  const r2 = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const r2Url = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${payload.model_key_latest}`;
  const r2Res = await r2.fetch(r2Url, { method: "GET" });
  if (!r2Res.ok) {
    const txt = await r2Res.text().catch(() => "");
    return json(502, { ok: false, error: "r2_fetch_failed", r2_status: r2Res.status, r2_body: txt.slice(0, 500) });
  }
  const onnxBytes = new Uint8Array(await r2Res.arrayBuffer());
  const onnxB64 = encodeBase64(onnxBytes);
  console.log(`[training-complete] pulled ${onnxBytes.length} bytes from R2`);

  // 2. Commit to GitHub. Use the contents API: GET to fetch the existing
  // file's sha, then PUT to update it. PUT with no sha would create.
  const ghHeaders = {
    "Authorization": `Bearer ${GITHUB_PAT}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lotlogic-training-complete",
  };
  const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${TARGET_PATH}`;
  const getRes = await fetch(`${apiBase}?ref=${GITHUB_BRANCH}`, { headers: ghHeaders });
  let existingSha: string | undefined;
  if (getRes.ok) {
    const cur = await getRes.json() as { sha?: string };
    existingSha = cur.sha;
  } else if (getRes.status !== 404) {
    const txt = await getRes.text().catch(() => "");
    return json(502, { ok: false, error: "github_get_failed", gh_status: getRes.status, gh_body: txt.slice(0, 500) });
  }

  const m = payload.metrics || {};
  const metricsLine = m.map50
    ? `mAP50=${m.map50.toFixed(3)} mAP50-95=${(m.map50_95 ?? 0).toFixed(3)} P=${(m.precision ?? 0).toFixed(3)} R=${(m.recall ?? 0).toFixed(3)}`
    : "metrics unavailable";
  const commitMessage =
    `chore(sidecar): retrained YOLO detector (${payload.labeled_count} labels)\n\n` +
    `Auto-generated by training-complete edge function.\n` +
    `Train/val: ${payload.train_count}/${payload.val_count}\n` +
    `Wall time: ${payload.wall_time_sec ?? 0}s\n` +
    `Validation: ${metricsLine}\n` +
    `Versioned key: r2://${R2_BUCKET_NAME}/${payload.model_key_versioned}\n` +
    `Trained at: ${payload.trained_at}\n`;

  const putBody: Record<string, unknown> = {
    message: commitMessage,
    content: onnxB64,
    branch: GITHUB_BRANCH,
  };
  if (existingSha) putBody.sha = existingSha;

  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(putBody),
  });
  if (!putRes.ok) {
    const txt = await putRes.text().catch(() => "");
    return json(502, { ok: false, error: "github_put_failed", gh_status: putRes.status, gh_body: txt.slice(0, 500) });
  }
  const putJson = await putRes.json() as { commit?: { sha?: string; html_url?: string } };
  const commitSha = putJson.commit?.sha;
  const commitUrl = putJson.commit?.html_url;
  console.log(`[training-complete] committed ${commitSha} -> ${commitUrl}`);

  // Railway is configured to auto-deploy on push to main, so no further
  // action needed here. The new model goes live in ~2-5 min after this commit.
  return json(200, {
    ok: true,
    commit_sha: commitSha,
    commit_url: commitUrl,
    message: "ONNX committed; Railway will redeploy automatically",
    metrics: m,
  });
});
