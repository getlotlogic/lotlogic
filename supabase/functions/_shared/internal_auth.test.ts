// SEC-3 (Wave 2.9 Task 4). The four pg_cron-driven functions that hold
// SUPABASE_SERVICE_ROLE_KEY now return 401 to anyone who is not the cron. The
// only interesting failure mode is the gate quietly opening, so every case
// below asserts a rejection except the one that must not reject.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { requireInternalToken } from "./internal_auth.ts";

const TOKEN = "s3cret-internal-token-fixed-length";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/weather-pull", { method: "POST", headers });
}

function withToken(value: string | null, fn: () => void) {
  const prior = Deno.env.get("INTERNAL_TOKEN");
  if (value === null) Deno.env.delete("INTERNAL_TOKEN");
  else Deno.env.set("INTERNAL_TOKEN", value);
  try {
    fn();
  } finally {
    if (prior === undefined) Deno.env.delete("INTERNAL_TOKEN");
    else Deno.env.set("INTERNAL_TOKEN", prior);
  }
}

Deno.test("a matching Bearer token is authorised", () => {
  withToken(TOKEN, () => {
    assertEquals(requireInternalToken(req({ authorization: `Bearer ${TOKEN}` })), null);
  });
});

Deno.test("the Bearer prefix is optional and case-insensitive", () => {
  withToken(TOKEN, () => {
    assertEquals(requireInternalToken(req({ authorization: TOKEN })), null);
    assertEquals(requireInternalToken(req({ authorization: `bearer ${TOKEN}` })), null);
  });
});

Deno.test("no Authorization header is rejected", async () => {
  await withTokenAsync(TOKEN, async () => {
    const denied = requireInternalToken(req());
    assertEquals(denied?.status, 401);
    assertEquals(await denied!.json(), { error: "unauthorized" });
  });
});

Deno.test("a wrong token is rejected", () => {
  withToken(TOKEN, () => {
    assertEquals(requireInternalToken(req({ authorization: "Bearer nope" }))?.status, 401);
    // Same length as TOKEN, one byte different — the constant-time compare must
    // still say no.
    const nearMiss = TOKEN.slice(0, -1) + "X";
    assertEquals(requireInternalToken(req({ authorization: `Bearer ${nearMiss}` }))?.status, 401);
  });
});

// The whole point of failing closed: a deploy that forgot to set the secret is
// the case where "" === "" would otherwise wave everyone through.
Deno.test("an unset INTERNAL_TOKEN rejects everyone, including an empty header", () => {
  withToken(null, () => {
    assertEquals(requireInternalToken(req())?.status, 401);
    assertEquals(requireInternalToken(req({ authorization: "" }))?.status, 401);
    assertEquals(requireInternalToken(req({ authorization: "Bearer " }))?.status, 401);
  });
});

Deno.test("an empty-string INTERNAL_TOKEN also rejects everyone", () => {
  withToken("", () => {
    assertEquals(requireInternalToken(req())?.status, 401);
    assertEquals(requireInternalToken(req({ authorization: "Bearer " }))?.status, 401);
  });
});

async function withTokenAsync(value: string, fn: () => Promise<void>) {
  const prior = Deno.env.get("INTERNAL_TOKEN");
  Deno.env.set("INTERNAL_TOKEN", value);
  try {
    await fn();
  } finally {
    if (prior === undefined) Deno.env.delete("INTERNAL_TOKEN");
    else Deno.env.set("INTERNAL_TOKEN", prior);
  }
}
