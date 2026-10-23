import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { emailProvider, sendEmail } from "./email.ts";

const envOf = (m: Record<string, string>) => (k: string) => m[k];

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }) {
  return ((url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
}

Deno.test("provider order: twilio beats resend, half-set twilio falls back", () => {
  assertEquals(emailProvider(envOf({ TWILIO_EMAIL_API_KEY_SID: "SK", TWILIO_EMAIL_API_KEY_SECRET: "s", RESEND_API_KEY: "re" })), "twilio");
  assertEquals(emailProvider(envOf({ TWILIO_EMAIL_API_KEY_SID: "SK", RESEND_API_KEY: "re" })), "resend");
  assertEquals(emailProvider(envOf({})), "none");
});

Deno.test("twilio request shape, cc folded into to, operationId returned", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const res = await sendEmail(
    { from: "dispatch@lotlogicparking.com", to: ["a@x.com"], cc: ["b@x.com"], subject: "S", html: "<p>h</p>", text: "t" },
    envOf({ TWILIO_EMAIL_API_KEY_SID: "SKid", TWILIO_EMAIL_API_KEY_SECRET: "sec" }),
    fakeFetch(202, { operationId: "op_1" }, seen),
  );
  assertEquals(res, { ok: true, provider: "twilio", messageId: "op_1" });
  assertEquals(seen.url, "https://comms.twilio.com/v1/Emails");
  const headers = seen.init!.headers as Record<string, string>;
  assertEquals(headers.Authorization, `Basic ${btoa("SKid:sec")}`);
  const body = JSON.parse(String(seen.init!.body));
  assertEquals(body.from, { address: "dispatch@lotlogicparking.com", name: "LotLogic" });
  assertEquals(body.to, [{ address: "a@x.com" }, { address: "b@x.com" }]);
  assertEquals(body.content, { subject: "S", html: "<p>h</p>", text: "t" });
});

Deno.test("twilio non-2xx surfaces status and body", async () => {
  const seen = {};
  const res = await sendEmail(
    { from: "f@x.com", to: ["a@x.com"], subject: "S", text: "t" },
    envOf({ TWILIO_EMAIL_API_KEY_SID: "SKid", TWILIO_EMAIL_API_KEY_SECRET: "sec" }),
    fakeFetch(401, { message: "bad" }, seen),
  );
  assertEquals(res, { ok: false, provider: "twilio", status: 401, body: { message: "bad" } });
});

Deno.test("resend path unchanged: bearer key, cc kept, id returned", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const res = await sendEmail(
    { from: "f@x.com", to: ["a@x.com"], cc: ["b@x.com"], subject: "S", html: "<p>h</p>" },
    envOf({ RESEND_API_KEY: "re_key" }),
    fakeFetch(200, { id: "re_1" }, seen),
  );
  assertEquals(res, { ok: true, provider: "resend", messageId: "re_1" });
  assertEquals(seen.url, "https://api.resend.com/emails");
  assertEquals((seen.init!.headers as Record<string, string>).Authorization, "Bearer re_key");
  const body = JSON.parse(String(seen.init!.body));
  assertEquals(body, { from: "f@x.com", to: ["a@x.com"], subject: "S", html: "<p>h</p>", cc: ["b@x.com"] });
});

Deno.test("no provider: ok=false, provider none, nothing fetched", async () => {
  let called = false;
  const res = await sendEmail(
    { from: "f@x.com", to: ["a@x.com"], subject: "S", text: "t" },
    envOf({}),
    ((..._a: unknown[]) => { called = true; return Promise.resolve(new Response("")); }) as typeof fetch,
  );
  assertEquals(res.ok, false);
  assertEquals(res.provider, "none");
  assertEquals(called, false);
});
