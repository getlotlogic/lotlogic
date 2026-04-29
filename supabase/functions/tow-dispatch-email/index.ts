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

function formatLocal(ts: string | number | Date | null | undefined, tz = "America/New_York"): string {
  if (ts == null) return "?";
  try {
    return new Date(ts).toLocaleString("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(ts);
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
    .replace(/"/g, "&quot;")
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

  // Internal-only function. Until 2026-04-26 this was unauthenticated, which
  // meant anyone on the internet who could guess a violation UUID could
  // force-send a tow-dispatch email + burn the Resend free quota. Now gated
  // by INTERNAL_TOKEN — camera-snapshot supplies it on every fan-out call.
  // If unset, the function refuses to run.
  const internalToken = Deno.env.get("INTERNAL_TOKEN") ?? "";
  const provided = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!internalToken || provided !== internalToken) {
    return json({ error: "unauthorized" }, 401);
  }

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
    return `${duration} ${formatLocal(lastPass.valid_from)} → ${formatLocal(lastPass.valid_until)}` +
      (hostBits ? ` (host: ${hostBits})` : "") +
      ` — ${String(lastPass.status).toUpperCase()}`;
  })();

  // Build action links. Tapping a button opens the browser for ~½ sec to the
  // backend's /violations/action GET endpoint, which atomically mutates the
  // violation (single-click thanks to PR getlotlogic/lotlogic-backend#46) and
  // shows the LotView confirm page. No mail composer, no extra Send step.
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

  const propertyName = property.name || "Property";

  // Subject is the inbox headline. Lead with siren + plate so the line
  // scans in a phone notification: "DISPATCH · ABC1234 · Charlotte Travel Plaza".
  const subject = `🚨 DISPATCH · ${violation.plate_text} · ${propertyName}`;

  // Preheader: hidden span that mail clients surface in the inbox preview
  // line under the subject. This is the second-most read text in the email
  // and we control it entirely.
  const preheader = `Active overstay · ${firstSeenAgo} on property · tap to dispatch or stand down`;

  const textBody = [
    `LOTVIEW DISPATCH`,
    `${propertyName}${property.address ? ` — ${property.address}` : ""}`,
    ``,
    `PLATE        ${violation.plate_text}`,
    `STATUS       ACTIVE OVERSTAY (${firstSeenAgo})`,
    `FIRST SEEN   ${formatLocal(firstSeen)}`,
    triggerEvent?.confidence != null ? `READ CONF.   ${Math.round(triggerEvent.confidence * 100)}%` : null,
    `PASS         ${passLine}`,
    lastPass?.visitor_name ? `DRIVER       ${lastPass.visitor_name}` : null,
    triggerEvent?.image_url ? `PHOTO        ${triggerEvent.image_url}` : null,
    "",
    "── ONE-TAP ACTIONS ───────────────────",
    towLink ? `  > TOW CONFIRMED   ${towLink}` : null,
    noTowLink ? `  > STAND DOWN      ${noTowLink}` : null,
    "",
    `Open LotView dashboard → https://lotlogicparking.com/app`,
    `Links valid 48h · single-use · routed to dispatch ledger`,
  ].filter(Boolean).join("\n");

  const photoBlock = triggerEvent?.image_url
    ? `
<tr><td style="padding:0 24px 18px;">
  <div style="background:#0F0A03; border:1px solid #2A2014; border-radius:8px; overflow:hidden;">
    <div style="padding:8px 12px; font-family:'DM Mono',Menlo,Consolas,monospace; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:#FBBF24; border-bottom:1px solid #2A2014;">
      &#9654; Trigger frame &middot; ${escapeHtml(formatLocal(triggerEvent?.created_at))}
    </div>
    <img src="${escapeHtml(triggerEvent.image_url)}" alt="Plate snapshot" style="display:block; width:100%; height:auto;" />
  </div>
</td></tr>`
    : "";

  const buttonsBlock = (towLink && noTowLink) ? `
<tr><td style="padding:0 24px 6px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">
    <tr>
      <td style="padding:0 6px 10px 0; width:50%;">
        <a href="${escapeHtml(towLink)}" style="display:block; background:#B91C1C; color:#FFF7E6; padding:18px 12px; text-align:center; text-decoration:none; border-radius:8px; font-family:'Anton','Impact','Helvetica Neue',Arial,sans-serif; font-weight:400; font-size:18px; letter-spacing:.18em; text-transform:uppercase; border:2px solid #7F1313; box-shadow:inset 0 -3px 0 rgba(0,0,0,.25);">
          &#9654; Tow Confirmed
        </a>
      </td>
      <td style="padding:0 0 10px 6px; width:50%;">
        <a href="${escapeHtml(noTowLink)}" style="display:block; background:#1A1206; color:#FBBF24; padding:18px 12px; text-align:center; text-decoration:none; border-radius:8px; font-family:'Anton','Impact','Helvetica Neue',Arial,sans-serif; font-weight:400; font-size:18px; letter-spacing:.18em; text-transform:uppercase; border:2px solid #FBBF24;">
          &#9654; Stand Down
        </a>
      </td>
    </tr>
  </table>
  <p style="margin:4px 0 0; font-family:'DM Mono',Menlo,Consolas,monospace; font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:#6F5A2C; text-align:center;">
    Single tap &middot; Single use &middot; Expires 48h
  </p>
</td></tr>` : "";

  const confidencePct = triggerEvent?.confidence != null
    ? Math.round((triggerEvent.confidence as number) * 100)
    : null;

  const metaRow = (label: string, value: string, mono = false) => `
<tr>
  <td style="padding:10px 0; width:36%; vertical-align:top; font-family:'DM Mono',Menlo,Consolas,monospace; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:#8A6F3D; border-bottom:1px dashed #2A2014;">
    ${escapeHtml(label)}
  </td>
  <td style="padding:10px 0; vertical-align:top; font-family:${mono ? "'DM Mono',Menlo,Consolas,monospace" : "'Manrope','Helvetica Neue',Arial,sans-serif"}; font-size:14px; color:#F5F1EA; border-bottom:1px dashed #2A2014;">
    ${value}
  </td>
</tr>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0; padding:0; background:#0B0905; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; color:#F5F1EA;">
<div style="display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden; mso-hide:all;">
  ${escapeHtml(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0905;">
  <tr><td align="center" style="padding:24px 12px;">

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#1A1206; border-radius:12px; overflow:hidden; border:1px solid #2A2014;">

      <tr><td style="height:6px; background:repeating-linear-gradient(45deg, #FBBF24 0 12px, #1A1206 12px 24px);">&nbsp;</td></tr>

      <tr><td style="padding:18px 24px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-family:'Anton','Impact','Helvetica Neue',Arial,sans-serif; font-size:26px; letter-spacing:.14em; color:#FBBF24; text-transform:uppercase;">
              LotView
            </td>
            <td align="right" style="font-family:'DM Mono',Menlo,Consolas,monospace; font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:#8A6F3D;">
              Dispatch &middot; ${escapeHtml(formatLocal(now))}
            </td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:6px 24px 14px;">
        <div style="display:inline-block; background:#B91C1C; color:#FFF7E6; padding:6px 12px; border-radius:4px; font-family:'Anton','Impact','Helvetica Neue',Arial,sans-serif; font-size:14px; letter-spacing:.22em; text-transform:uppercase;">
          &#9654; Tow Authorization Requested
        </div>
        <div style="margin-top:10px; font-family:'Anton','Impact','Helvetica Neue',Arial,sans-serif; font-size:22px; letter-spacing:.04em; color:#F5F1EA; text-transform:uppercase; line-height:1.15;">
          ${escapeHtml(propertyName)}
        </div>
        ${property.address ? `<div style="margin-top:4px; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; font-size:13px; color:#A0916F;">${escapeHtml(property.address)}</div>` : ""}
      </td></tr>

      <tr><td style="padding:0 24px 18px;">
        <div style="background:#0F0A03; border:2px solid #FBBF24; border-radius:10px; padding:20px; text-align:center;">
          <div style="font-family:'DM Mono',Menlo,Consolas,monospace; font-size:10px; letter-spacing:.28em; text-transform:uppercase; color:#FBBF24; margin-bottom:8px;">
            License Plate &middot; Active Overstay
          </div>
          <div style="font-family:'DM Mono',Menlo,Consolas,monospace; font-size:42px; letter-spacing:.18em; color:#FFFFFF; font-weight:700;">
            ${escapeHtml(violation.plate_text)}
          </div>
          <div style="margin-top:10px; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; font-size:13px; color:#E0D4B8;">
            On property <strong style="color:#FBBF24;">${escapeHtml(firstSeenAgo)}</strong> &middot; since ${escapeHtml(formatLocal(firstSeen))}
          </div>
        </div>
      </td></tr>

      <tr><td style="padding:0 24px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          ${confidencePct != null ? metaRow("Read Confidence", `${confidencePct}%`, true) : ""}
          ${metaRow("Pass on File", escapeHtml(passLine))}
          ${lastPass?.visitor_name ? metaRow("Driver", escapeHtml(lastPass.visitor_name)) : ""}
        </table>
      </td></tr>

      ${photoBlock}

      ${buttonsBlock}

      <tr><td style="padding:14px 24px 20px;">
        <a href="https://lotlogicparking.com/app" style="display:block; background:#FBBF24; color:#1A1206; padding:14px 16px; text-align:center; text-decoration:none; border-radius:8px; font-family:'Anton','Impact','Helvetica Neue',Arial,sans-serif; font-size:15px; letter-spacing:.2em; text-transform:uppercase; border:1px solid #C4940F;">
          &#9654; Open LotView Dashboard
        </a>
      </td></tr>

      <tr><td style="padding:14px 24px 18px; border-top:1px solid #2A2014;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-family:'DM Mono',Menlo,Consolas,monospace; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:#6F5A2C;">
              LotView &middot; Highway Dispatch
            </td>
            <td align="right" style="font-family:'DM Mono',Menlo,Consolas,monospace; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:#6F5A2C;">
              lotlogicparking.com
            </td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="height:4px; background:#FBBF24;">&nbsp;</td></tr>

    </table>

  </td></tr>
</table>
</body></html>`;

  // EMAIL_OVERRIDE_TO short-circuits the configured partner email during
  // testing. Unset in production. When set, keep the partner's real address
  // in the response body so operators can see who it "would have" gone to.
  const overrideTo = Deno.env.get("EMAIL_OVERRIDE_TO");
  const recipient = overrideTo && overrideTo.includes("@") ? overrideTo : partner.email;

  // CC the LotView owner so Gabe (or whoever's running the platform) sees
  // every dispatch alongside Frank. Configurable via OWNER_CC_EMAIL; falls
  // back to gabriel@lotlogicparking.com (lotlogicparking.com → Cloudflare
  // routes to standardvendingcompany@gmail.com per project_recaptcha memory).
  // Skip the CC if it would equal the primary recipient (Resend would 422).
  const ownerCc = Deno.env.get("OWNER_CC_EMAIL") || "gabriel@lotlogicparking.com";
  const ccList = ownerCc && ownerCc.includes("@") && ownerCc.toLowerCase() !== recipient.toLowerCase()
    ? [ownerCc]
    : [];

  const sendResult = await sendViaResend(resendKey, fromEmail, recipient, ccList, subject, textBody, html);

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
  cc: string[],
  subject: string,
  textBody: string,
  htmlBody: string,
): Promise<SendResult> {
  const payload: Record<string, unknown> = {
    from: fromEmail, to: [to], subject, html: htmlBody, text: textBody,
  };
  if (cc.length > 0) payload.cc = cc;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) return { ok: false, provider: "resend", status: res.status, body };
  return { ok: true, provider: "resend", messageId: (body as { id?: string })?.id ?? null };
}
