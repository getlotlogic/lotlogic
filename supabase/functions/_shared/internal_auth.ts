// The one gate for functions that are invoked by pg_cron, the GitHub scheduler
// or the backend — never by a browser.
//
// Why it has to exist: verify_jwt=true is NOT authentication for these. The key
// it accepts is the publishable anon key, which ships in every page of
// lotlogicparking.com. A function holding SUPABASE_SERVICE_ROLE_KEY behind
// verify_jwt=true is, in practice, open to anyone who reads the page source.
//
// INTERNAL_TOKEN is already set as a Supabase edge secret and as a GitHub
// Actions secret (see RECOVERY.md §5) — this adds no new secret.

/** 401 Response to return immediately, or null when the caller is authorised. */
export function requireInternalToken(req: Request): Response | null {
  const expected = Deno.env.get("INTERNAL_TOKEN") ?? "";
  const provided = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  // Empty expected means the secret is not set. Fail CLOSED: an unconfigured
  // deployment must not be an open one.
  if (!expected || !timingSafeEqual(expected, provided)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

/** Constant-time compare. Length still leaks; the token is fixed-length. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
