// Wave 2.7 dead-man helpers for cron-sessions-sweep, split out of index.ts
// (M-5) so heartbeat.test.ts can import them without instantiating a Supabase
// client — index.ts creates one at module scope from SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY (`Deno.env.get(...)!`), which is undefined (or
// throws downstream) when a test process runs with no env set. Nothing here
// touches Deno.env or createClient.
//
// pg_cron pokes cron-sessions-sweep via net.http_post, which is fire-and-
// forget — the cron job only ever learns "a request was sent", never whether
// the sweep actually did anything. Stamping the heartbeat here, on the
// success path only, is what makes "the sweep failed and reported done" (the
// exact 2026-08-30 failure, AUTO-2) visible to the dead-man instead of hidden
// behind a green cron.job_run_details row.

export type HeartbeatClient = { rpc(fn: string, params: Record<string, unknown>): PromiseLike<{ error: unknown }> };

export const HEARTBEAT_JOB_NAME = "plate_sessions_sweep";
export const HEARTBEAT_INTERVAL_S = 180; // matches the */3 * * * * pg_cron schedule

// Postgres/JS error messages can carry a plate, a phone, a URL or a token
// (a PostgREST DETAIL line embeds the offending column VALUE; a fetch error
// embeds the target URL). last_error is free text an alerting path emails —
// strip anything shaped like that before it ever reaches ops_job_runs.
export function redactError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let msg = raw.split(/\bDETAIL:/i)[0];
  msg = msg.replace(/https?:\/\/\S+/gi, "[url]");
  msg = msg.replace(/\b[\w-]+\.(?:supabase\.co|lotlogicparking\.com)\S*/gi, "[host]");
  msg = msg.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  msg = msg.replace(/\+?\d[\d\-\s]{8,}\d/g, "[redacted]"); // phone-ish digit runs
  return msg.trim().slice(0, 300);
}

// Never throws — a heartbeat that cannot be written must not turn a
// successful sweep into a 500, and must not mask the sweep's own error on a
// failed run.
export async function heartbeat(client: HeartbeatClient, ok: boolean, error: string | null): Promise<void> {
  try {
    const { error: rpcErr } = await client.rpc("ops_job_heartbeat", {
      p_job_name: HEARTBEAT_JOB_NAME,
      p_source: "edge",
      p_expected_interval_s: HEARTBEAT_INTERVAL_S,
      p_ok: ok,
      p_error: error,
    });
    if (rpcErr) console.error("ops heartbeat rpc error:", rpcErr);
  } catch (e) {
    console.error("ops heartbeat failed:", e);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Exported for testing: what the paused branch does, parameterized by client
// so a test doesn't need a live Supabase connection. A deliberate pause is
// the sweep correctly doing nothing, not an outage — a pause held longer than
// 2x the interval must not trip the dead-man as a false alarm, so this stamps
// ok:true just like a normal successful tick.
export async function handleSystemPaused(client: HeartbeatClient): Promise<Response> {
  await heartbeat(client, true, null);
  return json(200, { ok: true, paused: true });
}
