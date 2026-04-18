import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

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

async function twilioSend(opts: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body: string;
  mediaUrls: string[];
}) {
  const url = `${TWILIO_API_BASE}/Accounts/${opts.accountSid}/Messages.json`;
  const form = new URLSearchParams();
  form.set("To", opts.to);
  form.set("From", opts.from);
  form.set("Body", opts.body);
  for (const m of opts.mediaUrls) form.append("MediaUrl", m);

  const auth = btoa(`${opts.accountSid}:${opts.authToken}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  const fromNumber = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!accountSid || !authToken || !fromNumber) {
    return json({ error: "Twilio env vars not configured" }, 500);
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

  if (!property.tow_company_id) {
    return json({ error: "Property has no tow_company_id configured" }, 409);
  }

  const { data: partner, error: partErr } = await supabase
    .from("enforcement_partners")
    .select("id, company_name, phone, active")
    .eq("id", property.tow_company_id)
    .single();
  if (partErr || !partner) return json({ error: "Tow company not found", detail: partErr?.message }, 404);
  if (!partner.active) return json({ error: "Tow company inactive" }, 409);
  if (!partner.phone) return json({ error: "Tow company has no phone number" }, 409);

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

  const lines: string[] = [];
  lines.push(`[TOW] ${property.name || "Property"}`);
  lines.push(`Plate: ${violation.plate_text}`);
  if (property.address) lines.push(`Addr: ${property.address}`);
  lines.push(`First seen: ${formatLocal(firstSeen)} (${firstSeenAgo} ago)`);
  if (triggerEvent?.confidence != null) {
    lines.push(`Confidence: ${Math.round(triggerEvent.confidence * 100)}%`);
  }
  if (lastPass) {
    const duration = lastPass.valid_from && lastPass.valid_until
      ? humanDuration(new Date(lastPass.valid_until).getTime() - new Date(lastPass.valid_from).getTime())
      : (lastPass.stay_days ? `${lastPass.stay_days}d` : "?");
    const hostBits = [lastPass.host_unit, lastPass.host_name].filter(Boolean).join(" ");
    lines.push(
      `Pass: ${duration} ${formatLocal(lastPass.valid_from)} → ${formatLocal(lastPass.valid_until)}` +
        (hostBits ? ` (host: ${hostBits})` : "") +
        ` — ${String(lastPass.status).toUpperCase()}`,
    );
    if (lastPass.visitor_name) lines.push(`Driver: ${lastPass.visitor_name}`);
  } else {
    lines.push(`Pass: NONE (never registered)`);
  }
  lines.push(`Reply DONE when towed.`);
  const message = lines.join("\n");

  const mediaUrls = triggerEvent?.image_url ? [triggerEvent.image_url] : [];

  const twilioRes = await twilioSend({
    accountSid,
    authToken,
    from: fromNumber,
    to: partner.phone,
    body: message,
    mediaUrls,
  });

  if (twilioRes.status < 200 || twilioRes.status >= 300) {
    return json(
      { error: "Twilio send failed", twilio_status: twilioRes.status, twilio_body: twilioRes.body },
      502,
    );
  }

  await supabase
    .from("alpr_violations")
    .update({ sms_sent_at: new Date().toISOString(), status: "dispatched", dispatched_at: new Date().toISOString() })
    .eq("id", violation.id);

  return json(
    {
      status: "sent",
      to: partner.phone,
      violation_id: violation.id,
      message_preview: message,
      twilio_status: twilioRes.status,
    },
    200,
  );
});
