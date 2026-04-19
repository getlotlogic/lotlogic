import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { runPipeline } from "./pipeline.ts";
import { makeR2Uploader } from "./r2.ts";

const URL_SECRET = Deno.env.get("PR_INGEST_URL_SECRET") ?? "";
const PR_MIN_SCORE = Number(Deno.env.get("PR_MIN_SCORE") ?? "0.8");
const PR_DEDUP_WINDOW_SECONDS = Number(Deno.env.get("PR_DEDUP_WINDOW_SECONDS") ?? "0");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID")!;
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") ?? "parking-snapshots";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID")!;
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY")!;
const R2_PUBLIC_BASE_URL = Deno.env.get("R2_PUBLIC_BASE_URL")!;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const r2 = makeR2Uploader({
  accountId: R2_ACCOUNT_ID,
  bucket: R2_BUCKET_NAME,
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  publicBaseUrl: R2_PUBLIC_BASE_URL,
});

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  // The function is mounted at /functions/v1/pr-ingest. Anything after that is treated as the secret.
  const url = new URL(req.url);
  const trailing = url.pathname.replace(/^\/functions\/v1\/pr-ingest\/?/, "");
  if (!URL_SECRET || trailing !== URL_SECRET) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  try {
    const { status, body } = await runPipeline(req, {
      db,
      r2,
      env: { PR_MIN_SCORE, PR_DEDUP_WINDOW_SECONDS },
      now: () => new Date(),
    });
    return json(status, body);
  } catch (err) {
    // DB/insert errors get 500 so PR retries. Anything else should already have been
    // converted to 200 inside runPipeline. We log loudly so it shows up in `supabase functions logs`.
    console.error("pr-ingest unhandled error:", err);
    return json(500, { ok: false, error: "internal_error", detail: String(err) });
  }
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
