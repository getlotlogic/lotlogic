import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function formatLocal(ts: string | null | undefined, tz = "America/New_York"): string {
  if (!ts) return "?";
  try {
    return new Date(ts).toLocaleString("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

function humanDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh ? `${days}d ${rh}h` : `${days}d`;
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// HMAC-SHA256 JWT for the email-action one-click links.
// Same JWT_SECRET as the Python backend (Railway env). Audience
// 'violation-action' is single-purpose, distinct from session tokens.
async function signActionToken(violationId: string, action: "tow" | "no_tow", secret: string): Promise<string> {
  const enc = new TextEncoder();
  const b64url = (b: Uint8Array | string): string => {
    const arr = typeof b === "string" ? enc.encode(b) : b;
    let s = "";
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "lotlogic-backend",
    aud: "violation-action",
    iat: now,
    exp: now + 48 * 3600,
    sub: violationId,
    v: violationId,
    a: action,
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return `${data}.${b64url(sigBytes)}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Resend is the sole email provider (3K/mo free tier). SendGrid +
  // Twilio dependencies removed 2026-04-24 to zero out outbound-comms
  // billing surface. If Resend is unreachable we return 502 and the
  // cron will re-attempt on the next sweep — the violation row is not
  // marked dispatched until a 200 comes back.
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("FROM_EMAIL") || "noreply@lotlogic.com";
  const jwtSecret = Deno.env.get("JWT_SECRET") || "";
  const backendUrl = Deno.env.get("BACKEND_URL") || "https://lotlogic-backend-production.up.railway.app";
  if (!resendKey) {
    return json({ error: "Email provider not configured (set RESEND_API_KEY)" }, 500);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let body: { violation_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const violationId = body.violation_id;
  if (!violationId) return json({ error: "violation_id is required" }, 400);

  const { data: violation, error: vErr } = await supabase
    .from("alpr_violations")
    .select("id, property_id, plate_event_id, plate_text, status, sms_sent_at, created_at")
    .eq("id", violationId)
    .single();
  if (vErr || !violation) return json({ error: "Violation not found", detail: vErr?.message }, 404);
  if (violation.sms_sent_at) {
    return json({ status: "already_sent", sms_sent_at: violation.sms_sent_at }, 200);
  }

  const { data: property, error: pErr } = await supabase
    .from("properties")
    .select("id, name, address, tow_company_id")
    .eq("id", violation.property_id)
    .single();
  if (pErr || !property) return json({ error: "Property not found", detail: pErr?.message }, 404);
  if (!property.tow_company_id) return json({ error: "Property has no tow_company_id" }, 409);

  const { data: partner, error: partErr } = await supabase
    .from("enforcement_partners")
    .select("id, company_name, email, phone, active")
    .eq("id", property.tow_company_id)
    .single();
  if (partErr || !partner) return json({ error: "Tow company not found", detail: partErr?.message }, 404);
  if (!partner.active) return json({ error: "Tow company inactive" }, 409);
  if (!partner.email) return json({ error: "Tow company has no email" }, 409);

  const { data: triggerEvent } = await supabase
    .from("plate_events")
    .select("id, image_url, confidence, created_at")
    .eq("id", violation.plate_event_id)
    .maybeSingle();

  const { data: firstEvent } = await supabase
    .from("plate_events")
    .select("created_at")
    .eq("property_id", violation.property_id)
    .eq("plate_text", violation.plate_text)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const { data: lastPass } = await supabase
    .from("visitor_passes")
    .select("visitor_name, host_name, host_unit, valid_from, valid_until, stay_days, status, entry_seen_at")
    .eq("property_id", violation.property_id)
    .eq("plate_text", violation.plate_text)
    .order("valid_until", { ascending: false })
    .limit(1)
    .maybeSingle();

  const now = Date.now();
  const firstSeen = firstEvent?.created_at ?? triggerEvent?.created_at ?? violation.created_at;
  const firstSeenAgo = firstSeen ? humanDuration(now - new Date(firstSeen).getTime()) : "?";

  const passLine = (() => {
    if (!lastPass) return "NONE (never registered)";
    const duration = lastPass.valid_from && lastPass.valid_until
      ? humanDuration(new Date(lastPass.valid_until).getTime() - new Date(lastPass.valid_from).getTime())
      : (lastPass.stay_days ? `${lastPass.stay_days}d` : "?");
    const hostBits = [lastPass.host_unit, lastPass.host_name].filter(Boolean).join(" ");
    return `${duration} ${formatLocal(lastPass.valid_from)} \u2192 ${formatLocal(lastPass.valid_until)}` +
      (hostBits ? ` (host: ${hostBits})` : "") +
      ` \u2014 ${String(lastPass.status).toUpperCase()}`;
  })();

  // Build action links (only if JWT_SECRET configured).
  let towLink = "";
  let noTowLink = "";
  if (jwtSecret) {
    try {
      const towTok = await signActionToken(violation.id, "tow", jwtSecret);
      const noTowTok = await signActionToken(violation.id, "no_tow", jwtSecret);
      towLink = `${backendUrl}/violations/action?token=${towTok}`;
      noTowLink = `${backendUrl}/violations/action?token=${noTowTok}`;
    } catch (err) {
      console.error("failed to mint action tokens:", err);
    }
  }

  const subject = `[TOW] ${property.name || "Property"} \u2014 Plate ${violation.plate_text}`;

  const textBody = [
    `[TOW] ${property.name || "Property"}`,
    `Plate: ${violation.plate_text}`,
    property.address ? `Address: ${property.address}` : null,
    `First seen: ${formatLocal(firstSeen)} (${firstSeenAgo} ago)`,
    triggerEvent?.confidence != null ? `Confidence: ${Math.round(triggerEvent.confidence * 100)}%` : null,
    `Pass: ${passLine}`,
    lastPass?.visitor_name ? `Driver: ${lastPass.visitor_name}` : null,
    triggerEvent?.image_url ? `Photo: ${triggerEvent.image_url}` : null,
    "",
    towLink ? `✅ Mark as towed:    ${towLink}` : null,
    noTowLink ? `❌ No tow needed:     ${noTowLink}` : null,
    "",
    "You can also reply DONE via SMS, or log in to the LotLogic dashboard.",
  ].filter(Boolean).join("\n");

  const photoBlock = triggerEvent?.image_url
    ? `<p><img src=\"${escapeHtml(triggerEvent.image_url)}\" alt=\"Plate snapshot\" style=\"max-width:100%; border:1px solid #ccc; border-radius:6px;\" /></p>`
    : "";

  const buttonsBlock = (towLink && noTowLink) ? `
<div style=\"text-align:center; margin:20px 0; padding:14px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px;\">
  <a href=\"${escapeHtml(towLink)}\" style=\"display:inline-block; background:#b91c1c; color:#fff; padding:12px 22px; text-decoration:none; border-radius:6px; font-weight:600; margin:6px;\">✅ Mark as towed</a>
  <a href=\"${escapeHtml(noTowLink)}\" style=\"display:inline-block; background:#6b7280; color:#fff; padding:12px 22px; text-decoration:none; border-radius:6px; font-weight:600; margin:6px;\">❌ No tow needed</a>
  <p style=\"color:#6b7280; font-size:12px; margin:8px 0 0;\">Each link asks you to confirm before recording the result. Valid for 48 hours.</p>
</div>` : "";

  const html = `<!doctype html>
<html><body style=\"font-family:-apple-system, Segoe UI, Roboto, sans-serif; color:#111; max-width:560px; margin:0 auto; padding:16px;\">
<h2 style=\"margin:0 0 12px; color:#b91c1c;\">[TOW] ${escapeHtml(property.name || "Property")}</h2>
<table style=\"border-collapse:collapse; width:100%; font-size:15px;\">
<tr><td style=\"padding:6px 0; width:110px; color:#555;\">Plate</td><td style=\"padding:6px 0; font-weight:600; font-size:20px;\">${escapeHtml(violation.plate_text)}</td></tr>
${property.address ? `<tr><td style=\"padding:6px 0; color:#555;\">Address</td><td style=\"padding:6px 0;\">${escapeHtml(property.address)}</td></tr>` : ""}
<tr><td style=\"padding:6px 0; color:#555;\">First seen</td><td style=\"padding:6px 0;\">${escapeHtml(formatLocal(firstSeen))} <span style=\"color:#888;\">(${escapeHtml(firstSeenAgo)} ago)</span></td></tr>
${triggerEvent?.confidence != null ? `<tr><td style=\"padding:6px 0; color:#555;\">Confidence</td><td style=\"padding:6px 0;\">${Math.round((triggerEvent.confidence as number) * 100)}%</td></tr>` : ""}
<tr><td style=\"padding:6px 0; color:#555; vertical-align:top;\">Pass</td><td style=\"padding:6px 0;\">${escapeHtml(passLine)}</td></tr>
${lastPass?.visitor_name ? `<tr><td style=\"padding:6px 0; color:#555;\">Driver</td><td style=\"padding:6px 0;\">${escapeHtml(lastPass.visitor_name)}</td></tr>` : ""}
</table>
${photoBlock}
${buttonsBlock}
<p style=\"color:#555; font-size:13px; margin-top:18px; border-top:1px solid #eee; padding-top:12px;\">You can also reply <strong>DONE</strong> via SMS, or log in to the LotLogic dashboard.</p>
</body></html>`;

  // EMAIL_OVERRIDE_TO short-circuits the configured partner email during
  // testing. Unset in production. When set, keep the partner's real address
  // in the response body so operators can see who it "would have" gone to.
  const overrideTo = Deno.env.get("EMAIL_OVERRIDE_TO");
  const recipient = overrideTo && overrideTo.includes("@") ? overrideTo : partner.email;

  const sendResult = await sendViaResend(resendKey, fromEmail, recipient, subject, textBody, html);

  if (!sendResult.ok) {
    return json({
      error: `${sendResult.provider} send failed`,
      provider: sendResult.provider,
      status: sendResult.status,
      body: sendResult.body,
    }, 502);
  }

  await supabase
    .from("alpr_violations")
    .update({
      sms_sent_at: new Date().toISOString(),
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
    })
    .eq("id", violation.id);

  return json(
    {
      status: "sent",
      provider: sendResult.provider,
      to: recipient,
      partner_email: partner.email,
      override_active: recipient !== partner.email,
      violation_id: violation.id,
      subject,
      message_id: sendResult.messageId ?? null,
      action_links_included: !!(towLink && noTowLink),
    },
    200,
  );
});

type SendResult =
  | { ok: true; provider: "resend"; messageId: string | null }
  | { ok: false; provider: "resend"; status: number; body: unknown };

async function sendViaResend(
  apiKey: string,
  fromEmail: string,
  to: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): Promise<SendResult> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: fromEmail, to: [to], subject, html: htmlBody, text: textBody }),
  });
  const text = await res.text().catch(() => "");
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) return { ok: false, provider: "resend", status: res.status, body };
  return { ok: true, provider: "resend", messageId: (body as { id?: string })?.id ?? null };
}
