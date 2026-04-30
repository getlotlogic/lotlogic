// Dashboard "Retrain detector" button → this function → Modal training job.
//
// The dashboard hits this with a Supabase auth header. We verify the caller
// is an admin (lot_owners.is_admin = true), then forward the call to Modal's
// public training endpoint with our trigger token. Modal kicks off a GPU
// training run asynchronously and returns a job id immediately.
//
// Why a fronting edge function instead of calling Modal directly from the
// browser:
//   1. Hides the Modal trigger token from the browser bundle.
//   2. Lets us enforce admin-only invocation via JWT inspection.
//   3. Lets us write an audit row to plate_events_training_runs (future).
//   4. If Modal moves or we swap to RunPod, only this function changes.
//
// Required secrets:
//   - MODAL_TRAINING_URL: https://<workspace>--lotlogic-train-kick-off-training.modal.run
//   - MODAL_TRIGGER_TOKEN: bearer token (we pick a random secret; Modal also
//     stores it and rejects requests without it — see kick_off_training)
//
// Caller contract:
//   POST /functions/v1/yolo-retrain
//   Authorization: Bearer <user-jwt>          (must be is_admin)
//   { "epochs": 100, "imgsz": 640 }           (optional)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MODAL_TRAINING_URL = Deno.env.get("MODAL_TRAINING_URL") ?? "";
// Modal proxy auth — Modal validates these headers server-side before
// invoking the kick_off_training function (requires_proxy_auth=True).
const MODAL_KEY = Deno.env.get("MODAL_KEY") ?? "";
const MODAL_SECRET = Deno.env.get("MODAL_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  // Browser preflight — must respond with CORS headers before the actual POST.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!MODAL_TRAINING_URL) return json(500, { ok: false, error: "MODAL_TRAINING_URL missing" });

  // Require an admin JWT. We use the service role to read lot_owners.is_admin
  // for the caller's owner_id claim — RLS would also work but this is more
  // explicit.
  const auth = req.headers.get("authorization") || "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { ok: false, error: "missing_jwt" });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let payload: { sub?: string; owner_id?: string };
  try {
    const segments = jwt.split(".");
    payload = JSON.parse(atob(segments[1]));
  } catch {
    return json(401, { ok: false, error: "invalid_jwt" });
  }

  const ownerId = payload.owner_id || payload.sub;
  if (!ownerId) return json(401, { ok: false, error: "no_owner_id_claim" });

  const { data: owner, error: ownerErr } = await sb
    .from("lot_owners")
    .select("is_admin")
    .eq("id", ownerId)
    .maybeSingle();
  if (ownerErr || !owner?.is_admin) {
    return json(403, { ok: false, error: "admin_only" });
  }

  // Concurrency guard. Refuse to kick off a new run if an in-flight one
  // started in the last hour. Two admins clicking "Retrain" within seconds
  // would otherwise spawn duplicate Modal runs (~$0.20 each in GPU spend)
  // and race the GitHub PUT — second commit gets a 422 on stale SHA.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: openRun } = await sb
    .from("training_runs")
    .select("id, started_at")
    .is("finished_at", null)
    .gte("started_at", oneHourAgo)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (openRun) {
    return json(409, {
      ok: false,
      error: "training_already_in_flight",
      open_run_id: openRun.id,
      open_run_started_at: openRun.started_at,
      hint: "Wait for it to finish (or mark failed) before retrying.",
    });
  }

  // Pull tunables from request body (optional)
  let body: { epochs?: number; imgsz?: number } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }

  // Insert audit row — also serves as the lock the next click will see.
  const { data: runRow, error: runErr } = await sb
    .from("training_runs")
    .insert({
      triggered_by_owner: ownerId,
      status: "running",
    })
    .select("id")
    .single();
  if (runErr || !runRow) {
    return json(500, { ok: false, error: "audit_insert_failed", db_err: runErr?.message });
  }
  const runId = runRow.id;

  // Fire Modal. Don't await the training itself — Modal's kick-off endpoint
  // returns in <1s with a call_id; the actual GPU job runs asynchronously
  // and Modal's train_yolo() commits the trained ONNX directly to GitHub.
  const modalRes = await fetch(MODAL_TRAINING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(MODAL_KEY ? { "Modal-Key": MODAL_KEY } : {}),
      ...(MODAL_SECRET ? { "Modal-Secret": MODAL_SECRET } : {}),
    },
    body: JSON.stringify({
      epochs: body.epochs ?? 100,
      imgsz: body.imgsz ?? 640,
    }),
  });

  const modalBody = await modalRes.text();
  if (!modalRes.ok) {
    // Mark the audit row failed so the lock is released.
    await sb
      .from("training_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        notes: `modal_kickoff_failed status=${modalRes.status}`,
      })
      .eq("id", runId);
    return json(502, {
      ok: false,
      error: "modal_kickoff_failed",
      modal_status: modalRes.status,
      modal_body: modalBody.slice(0, 500),
      run_id: runId,
    });
  }

  let modalJson: { call_id?: string; ok?: boolean } = {};
  try { modalJson = JSON.parse(modalBody); } catch {}

  // Stamp the modal call id on the audit row so we can correlate logs.
  await sb
    .from("training_runs")
    .update({ modal_call_id: modalJson.call_id ?? null })
    .eq("id", runId);

  return json(200, {
    ok: true,
    run_id: runId,
    call_id: modalJson.call_id || null,
    started_at: new Date().toISOString(),
    epochs: body.epochs ?? 100,
    imgsz: body.imgsz ?? 640,
    note: "Training running on Modal GPU. Modal will commit the trained ONNX directly to GitHub in 5-15 min.",
  });
});
