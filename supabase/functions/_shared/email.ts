// Shared outbound-email helper for the edge functions.
//
// Provider order (mirrors lotlogic-backend/services/email.py):
//   1. Twilio Email (https://comms.twilio.com/v1/Emails) when both
//      TWILIO_EMAIL_API_KEY_SID and TWILIO_EMAIL_API_KEY_SECRET are set.
//      This is the LotLogic Twilio account under gabriel@lotlogicparking.com;
//      lotlogicparking.com is domain-authenticated there (DKIM selector llp).
//   2. Resend (https://api.resend.com/emails) when RESEND_API_KEY is set.
//   3. Nothing configured → { ok: false, provider: "none" } so callers can
//      dry-run / skip without marking anything as sent.
//
// Callers pass plain addresses. Twilio has no CC field on this endpoint, so
// CC recipients are folded into `to` there; Resend keeps them as CC.

export type EmailProvider = "twilio" | "resend" | "none";

export interface SendEmailInput {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  html?: string;
  text?: string;
}

export type SendEmailResult =
  | { ok: true; provider: EmailProvider; messageId: string | null }
  | { ok: false; provider: EmailProvider; status: number; body: unknown };

export function emailProvider(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): EmailProvider {
  if (env("TWILIO_EMAIL_API_KEY_SID") && env("TWILIO_EMAIL_API_KEY_SECRET")) return "twilio";
  if (env("RESEND_API_KEY")) return "resend";
  return "none";
}

export async function sendEmail(
  input: SendEmailInput,
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
  fetchFn: typeof fetch = fetch,
): Promise<SendEmailResult> {
  const provider = emailProvider(env);
  if (provider === "twilio") return sendViaTwilio(input, env, fetchFn);
  if (provider === "resend") return sendViaResend(input, env, fetchFn);
  return { ok: false, provider: "none", status: 0, body: "no email provider configured (TWILIO_EMAIL_API_KEY_SID/SECRET or RESEND_API_KEY)" };
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try { return JSON.parse(text); } catch { return text; }
}

async function sendViaTwilio(
  input: SendEmailInput,
  env: (k: string) => string | undefined,
  fetchFn: typeof fetch,
): Promise<SendEmailResult> {
  const sid = env("TWILIO_EMAIL_API_KEY_SID") ?? "";
  const secret = env("TWILIO_EMAIL_API_KEY_SECRET") ?? "";
  const recipients = [...input.to, ...(input.cc ?? [])];
  const content: Record<string, unknown> = { subject: input.subject };
  if (input.html) content.html = input.html;
  if (input.text) content.text = input.text;
  const payload = {
    from: { address: input.from, name: input.fromName || env("EMAIL_FROM_NAME") || "LotLogic" },
    to: recipients.map((address) => ({ address })),
    content,
  };
  const res = await fetchFn("https://comms.twilio.com/v1/Emails", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${secret}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await parseBody(res);
  if (!res.ok) return { ok: false, provider: "twilio", status: res.status, body };
  const id = (body as { operationId?: string })?.operationId ?? null;
  return { ok: true, provider: "twilio", messageId: id };
}

async function sendViaResend(
  input: SendEmailInput,
  env: (k: string) => string | undefined,
  fetchFn: typeof fetch,
): Promise<SendEmailResult> {
  const apiKey = env("RESEND_API_KEY") ?? "";
  const payload: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    subject: input.subject,
  };
  if (input.html) payload.html = input.html;
  if (input.text) payload.text = input.text;
  if (input.cc && input.cc.length > 0) payload.cc = input.cc;
  const res = await fetchFn("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await parseBody(res);
  if (!res.ok) return { ok: false, provider: "resend", status: res.status, body };
  return { ok: true, provider: "resend", messageId: (body as { id?: string })?.id ?? null };
}
