import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleSystemPaused, heartbeat, redactError } from "./heartbeat.ts";

Deno.test("handleSystemPaused: stamps ok:true before returning, not ok:false or a skip", async () => {
  // A deliberate pause is the sweep correctly doing nothing, not a failure —
  // it must stamp ok:true so a pause held longer than the dead-man's 2x
  // window doesn't page as a false alarm.
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, params: Record<string, unknown>) {
      calls.push({ fn, params });
      return Promise.resolve({ error: null });
    },
  };

  const res = await handleSystemPaused(client);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].fn, "ops_job_heartbeat");
  assertEquals(calls[0].params.p_ok, true);
  assertEquals(calls[0].params.p_error, null);

  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.paused, true);
});

Deno.test("heartbeat: success path calls rpc with ok=true and no error", async () => {
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, params: Record<string, unknown>) {
      calls.push({ fn, params });
      return Promise.resolve({ error: null });
    },
  };

  await heartbeat(client, true, null);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].fn, "ops_job_heartbeat");
  assertEquals(calls[0].params.p_job_name, "plate_sessions_sweep");
  assertEquals(calls[0].params.p_source, "edge");
  assertEquals(calls[0].params.p_expected_interval_s, 180);
  assertEquals(calls[0].params.p_ok, true);
  assertEquals(calls[0].params.p_error, null);
});

Deno.test("heartbeat: failure path forwards ok=false and the given error text", async () => {
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, params: Record<string, unknown>) {
      calls.push({ fn, params });
      return Promise.resolve({ error: null });
    },
  };

  await heartbeat(client, false, "boom");

  assertEquals(calls[0].params.p_ok, false);
  assertEquals(calls[0].params.p_error, "boom");
});

Deno.test("heartbeat: a thrown rpc call is swallowed, never thrown to the caller", async () => {
  const client = {
    rpc(_fn: string, _params: Record<string, unknown>): Promise<{ error: unknown }> {
      throw new Error("network is down");
    },
  };

  // Must not throw — a heartbeat that cannot be written must not fail the sweep.
  await heartbeat(client, true, null);
});

Deno.test("heartbeat: an rpc error response (not a throw) is also swallowed", async () => {
  const client = {
    rpc(_fn: string, _params: Record<string, unknown>) {
      return Promise.resolve({ error: { message: "permission denied" } });
    },
  };

  await heartbeat(client, false, "sweep failed");
});

Deno.test("redactError: strips a Postgres DETAIL line that could embed a plate", () => {
  const err = new Error(
    'duplicate key value violates unique constraint "plate_sessions_pkey"\n' +
      "DETAIL:  Key (normalized_plate)=(ABC1234) already exists.",
  );
  const out = redactError(err);
  assertMatch(out, /duplicate key value violates unique constraint/);
  assertEquals(out.includes("ABC1234"), false);
  assertEquals(out.includes("DETAIL"), false);
});

Deno.test("redactError: strips URLs and Supabase/lotlogic hostnames", () => {
  const err = new Error(
    "fetch failed: https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/tow-dispatch-email timed out",
  );
  const out = redactError(err);
  assertEquals(out.includes("supabase.co"), false);
  assertEquals(out.includes("https://"), false);
  assertMatch(out, /\[url\]/);
});

Deno.test("redactError: strips a bearer token", () => {
  const err = new Error("request failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def was rejected");
  const out = redactError(err);
  assertEquals(out.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false);
  assertMatch(out, /Bearer \[redacted\]/);
});

Deno.test("redactError: strips a phone-shaped digit run", () => {
  const err = new Error("SMS to +1 704-555-1234 failed");
  const out = redactError(err);
  assertEquals(out.includes("704-555-1234"), false);
  assertMatch(out, /\[redacted\]/);
});

Deno.test("redactError: truncates a long message to 300 chars", () => {
  const err = new Error("x".repeat(5000));
  const out = redactError(err);
  assertEquals(out.length, 300);
});

Deno.test("redactError: handles a non-Error thrown value", () => {
  const out = redactError("plain string failure");
  assertEquals(out, "plain string failure");
});
