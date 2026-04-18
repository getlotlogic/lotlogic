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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("FROM_EMAIL") || "noreply@lotlogic.com";
  if (!resendKey) return json({ error: "RESEND_API_KEY not configured" }, 500);

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

  const subject = `[TOW] ${property.name || "Property"} — Plate ${violation.plate_text}`;

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
    "Reply DONE when towed, or log in to the LotLogic dashboard to mark this resolved.",
  ].filter(Boolean).join("\n");

  const photoBlock = triggerEvent?.image_url
    ? `<p><img src="${escapeHtml(triggerEvent.image_url)}" alt="Plate snapshot" style="max-width:100%; border:1px solid #ccc; border-radius:6px;" /></p>`
    : "";

  const html = `<!doctype html>
<html><body style="font-family:-apple-system, Segoe UI, Roboto, sans-serif; color:#111; max-width:560px; margin:0 auto; padding:16px;">
<h2 style="margin:0 0 12px; color:#b91c1c;">[TOW] ${escapeHtml(property.name || "Property")}</h2>
<table style="border-collapse:collapse; width:100%; font-size:15px;">
<tr><td style="padding:6px 0; width:110px; color:#555;">Plate</td><td style="padding:6px 0; font-weight:600; font-size:20px;">${escapeHtml(violation.plate_text)}</td></tr>
${property.address ? `<tr><td style="padding:6px 0; color:#555;">Address</td><td style="padding:6px 0;">${escapeHtml(property.address)}</td></tr>` : ""}
<tr><td style="padding:6px 0; color:#555;">First seen</td><td style="padding:6px 0;">${escapeHtml(formatLocal(firstSeen))} <span style="color:#888;">(${escapeHtml(firstSeenAgo)} ago)</span></td></tr>
${triggerEvent?.confidence != null ? `<tr><td style="padding:6px 0; color:#555;">Confidence</td><td style="padding:6px 0;">${Math.round((triggerEvent.confidence as number) * 100)}%</td></tr>` : ""}
<tr><td style="padding:6px 0; color:#555; vertical-align:top;">Pass</td><td style="padding:6px 0;">${escapeHtml(passLine)}</td></tr>
${lastPass?.visitor_name ? `<tr><td style="padding:6px 0; color:#555;">Driver</td><td style="padding:6px 0;">${escapeHtml(lastPass.visitor_name)}</td></tr>` : ""}
</table>
${photoBlock}
<p style="color:#555; font-size:13px; margin-top:18px; border-top:1px solid #eee; padding-top:12px;">Reply <strong>DONE</strong> when towed, or log in to the LotLogic dashboard to mark this resolved.</p>
</body></html>`;

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [partner.email],
      subject,
      html,
      text: textBody,
    }),
  });

  const resendText = await resendRes.text();
  let resendBody: unknown;
  try { resendBody = JSON.parse(resendText); } catch { resendBody = resendText; }

  if (!resendRes.ok) {
    return json({ error: "Resend send failed", resend_status: resendRes.status, resend_body: resendBody }, 502);
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
      to: partner.email,
      violation_id: violation.id,
      subject,
      resend_id: (resendBody as { id?: string })?.id ?? null,
    },
    200,
  );
});
