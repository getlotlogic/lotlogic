// Cloudflare Email Worker: receives reply emails sent from the tow-dispatch
// "Tow Confirmed" / "Stand Down" mailto: buttons and resolves the violation
// by calling the backend's GET /violations/action endpoint.
//
// Routing setup (Cloudflare → Email Routing): all mail to
// tow-action@lotlogicparking.com is delivered to this worker (no forwarding).
//
// Subject grammar (case-insensitive, prefix match — anything trailing is
// ignored so phone autocorrect and signature lines don't break parsing):
//   TOW   <jwt-token>
//   NOTOW <jwt-token>
//
// The token is the same HS256 JWT minted by tow-dispatch-email and verified
// by the backend's services.auth.decode_violation_action_token. We do not
// verify it here — we just shuttle it to the backend, which is the source
// of truth for token validity. That keeps JWT_SECRET out of the Cloudflare
// edge entirely.

interface Env {
  BACKEND_URL: string;
}

interface EmailMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream;
  rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

// Cloudflare Workers runtime provides ExecutionContext globally; the
// workerd runtime type isn't always installed locally. Minimal stub keeps
// IDEs quiet without affecting wrangler build.
type ExecutionContext = { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void };

const SUBJECT_RE = /^\s*(TOW|NOTOW)\s+([A-Za-z0-9._\-]+)/i;

export default {
  async email(message: EmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    const subject = message.headers.get("subject") || "";
    const match = subject.match(SUBJECT_RE);

    if (!match) {
      console.warn(`unrecognized subject from ${message.from}: ${subject.slice(0, 80)}`);
      // Don't reject — Cloudflare logs the drop. Rejecting bounces back to
      // the partner's inbox, which is noisier than a silent drop.
      return;
    }

    const verb = match[1].toUpperCase();
    const token = match[2];

    const url = `${env.BACKEND_URL}/violations/action?token=${encodeURIComponent(token)}`;
    let status = 0;
    let bodySnippet = "";
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual" });
      status = res.status;
      bodySnippet = (await res.text().catch(() => "")).slice(0, 200);
    } catch (err) {
      console.error(`backend fetch failed: ${String(err)}`);
      return;
    }

    console.log(`email-action from=${message.from} verb=${verb} status=${status} body=${bodySnippet}`);
  },
};
