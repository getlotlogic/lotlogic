import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Internal-only function — gated by INTERNAL_TOKEN, never called from a
// browser, so no CORS preflight needed.
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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

  // Operator kill-switch. Setting DISPATCH_EMAILS_DISABLED=true on this
  // function suppresses ALL outbound email sends (dispatch and
  // stand-down). The function logs the suppressed event, returns 200 so
  // upstream callers don't retry-loop, but never hits Resend. Flip the
  // env var to anything other than "true" (or unset it) to resume.
  const dispatchDisabled = (Deno.env.get("DISPATCH_EMAILS_DISABLED") || "").toLowerCase() === "true";
  if (dispatchDisabled) {
    let body: unknown = null;
    try { body = await req.json(); } catch { /* ignore */ }
    console.log("tow-dispatch-email suppressed by DISPATCH_EMAILS_DISABLED", { body });
    return json({ ok: true, suppressed: true, reason: "DISPATCH_EMAILS_DISABLED" });
  }

  // Resend is the sole email provider (3K/mo free tier). SendGrid +
  // Twilio dependencies removed 2026-04-24 to zero out outbound-comms
  // billing surface. If Resend is unreachable we return 502 and the
  // cron will re-attempt on the next sweep — the violation row is not
  // marked dispatched until a 200 comes back.
  const resendKey = Deno.env.get("RESEND_API_KEY");
  // Default to the actual SendGrid-authenticated sender. The previous
  // generic "noreply@lotlogic.com" fallback was unauthenticated — if
  // FROM_EMAIL ever got unset every dispatch would land in spam folders
  // (DKIM fails for the lotlogic.com domain).
  const fromEmail = Deno.env.get("FROM_EMAIL") || "dispatch@lotlogicparking.com";
  const jwtSecret = Deno.env.get("JWT_SECRET") || "";
  const backendUrl = Deno.env.get("BACKEND_URL") || "https://lotlogic-backend-production.up.railway.app";
  if (!resendKey) {
    return json({ error: "Email provider not configured (set RESEND_API_KEY)" }, 500);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let body: { violation_id?: string; notification_kind?: "dispatch" | "left_before_tow" };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const violationId = body.violation_id;
  if (!violationId) return json({ error: "violation_id is required" }, 400);
  const notificationKind = body.notification_kind ?? "dispatch";

  const { data: violation, error: vErr } = await supabase
    .from("alpr_violations")
    .select("id, property_id, plate_event_id, plate_text, status, sms_sent_at, created_at, violation_type, left_before_tow_at")
    .eq("id", violationId)
    .single();
  if (vErr || !violation) return json({ error: "Violation not found", detail: vErr?.message }, 404);

  // left_before_tow follow-up has its own flow: short "stand down" email,
  // no action buttons, no sms_sent_at gate (the dispatch email already
  // fired — that's why we're sending the cancellation). Bail out here
  // before the dispatch-path setup.
  if (notificationKind === "left_before_tow") {
    return await sendLeftBeforeTowEmail(supabase, violation, resendKey, fromEmail);
  }

  if (violation.sms_sent_at) {
    return json({ status: "already_sent", sms_sent_at: violation.sms_sent_at }, 200);
  }

  // Last-line lifecycle guard: never dispatch a tow truck for a vehicle
  // that has already exited (status='dismissed' from the auto-cancel path,
  // or the linked visitor_pass already has exited_at stamped). The
  // cron-sessions-sweep checks both before queueing, but a camera read
  // landing between the cron's SELECT and this email send would slip
  // through without this. Per truck-plaza pass lifecycle memory: "if we
  // see him leave after we send a dispatch, we cancel it" — apply the
  // same logic before sending so we never roll on a ghost.
  if (violation.status === "dismissed") {
    console.log(JSON.stringify({
      skipped_dispatch: true, reason: "violation_dismissed", violation_id: violationId,
    }));
    return json({ ok: true, skipped: "violation_dismissed" });
  }
  {
    const { data: linkedPass } = await supabase
      .from("visitor_passes")
      .select("exited_at, status, cancelled_at")
      .eq("overstay_violation_id", violationId)
      .maybeSingle();
    if (linkedPass?.exited_at || linkedPass?.cancelled_at) {
      console.log(JSON.stringify({
        skipped_dispatch: true,
        reason: "pass_exited_or_cancelled",
        violation_id: violationId,
        pass_exited_at: linkedPass.exited_at,
        pass_cancelled_at: linkedPass.cancelled_at,
        pass_status: linkedPass.status,
      }));
      // Mark the violation dismissed so the dispatch queue stops retrying.
      await supabase.from("alpr_violations").update({
        status: "dismissed",
        action_taken: "no_tow",
        action_channel: "auto_left_before_tow",
        action_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
        left_before_tow_at: linkedPass.exited_at ?? linkedPass.cancelled_at,
        sms_sent_at: new Date().toISOString(),
        left_before_tow_email_sent_at: new Date().toISOString(),
      }).eq("id", violationId).is("sms_sent_at", null);
      return json({ ok: true, skipped: "pass_exited_or_cancelled" });
    }
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
    .select("id, image_url, confidence, created_at, raw_data, camera_id")
    .eq("id", violation.plate_event_id)
    .maybeSingle();

  // Exit-detection guard. If the trigger plate read is an EXIT — Milesight
  // reported direction="Away" — the truck is already crossing the gate out
  // of the lot. Dispatching a tow truck for a vehicle that's leaving is
  // wasted partner time and confusing to operators. Skip the email and log
  // why so the dashboard can show it as auto-dismissed if we wire that up.
  const triggerDirection = (() => {
    const d1 = triggerEvent?.raw_data?.milesight_lpr?.direction;
    const d2 = triggerEvent?.raw_data?.onboardLpr?.direction;
    return (d1 ?? d2 ?? "").toString();
  })();
  if (triggerDirection === "Away") {
    console.log(JSON.stringify({
      skipped_dispatch: true,
      reason: "vehicle_exiting",
      violation_id: violation.id,
      plate_text: violation.plate_text,
      trigger_event_id: triggerEvent?.id,
    }));
    return json({
      ok: true,
      skipped: "vehicle_exiting",
      message: "Trigger read shows vehicle leaving (direction=Away); not dispatching.",
    });
  }

  // Find the earliest plate read of THIS vehicle within the last 24h, tolerant
  // of OCR drift across frames. Exact-only match by plate_text picked up the
  // most recent OCR VARIANT, not the actual first time the truck appeared
  // (e.g. truck read as VX7434 12h ago + PK7434 5 min ago → email said "first
  // seen 5 min ago" which was wrong). The fuzzy gate mirrors the ≤1-edit
  // length-guarded rule we use elsewhere (camera-snapshot, public_registration).
  const lookbackMs = 24 * 60 * 60_000;
  const since = new Date(Date.now() - lookbackMs).toISOString();
  const { data: recentReads } = await supabase
    .from("plate_events")
    .select("created_at, normalized_plate")
    .eq("property_id", violation.property_id)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(500);
  const target = (violation.plate_text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const lev1 = (a: string, b: string): boolean => {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    if (target.length < 5) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      edits++;
      if (edits > 1) return false;
      if (a.length === b.length) { i++; j++; }
      else if (a.length > b.length) i++;
      else j++;
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  };
  const firstMatch = (recentReads ?? []).find(r => {
    const p = (r.normalized_plate ?? "").toUpperCase();
    return p === target || lev1(p, target);
  });
  const firstEvent = firstMatch ? { created_at: firstMatch.created_at } : null;

  // Match either front (plate_text) or back (normalized_back_plate). The
  // violation row carries whichever plate the camera actually read, so a
  // trailer-plate-triggered overstay otherwise renders "NEVER REGISTERED"
  // because the pass row stores the back plate in normalized_back_plate.
  // Normalize the violation plate so the back-plate column (already
  // normalized in the DB) matches camera reads that may include hyphens.
  const violPlateNorm = (violation.plate_text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const { data: lastPass } = await supabase
    .from("visitor_passes")
    .select("visitor_name, host_name, host_unit, valid_from, valid_until, stay_days, status, entry_seen_at, back_plate")
    .eq("property_id", violation.property_id)
    .or(`plate_text.eq.${violPlateNorm},normalized_back_plate.eq.${violPlateNorm}`)
    .order("valid_until", { ascending: false })
    .limit(1)
    .maybeSingle();

  const now = Date.now();
  const firstSeen = firstEvent?.created_at ?? triggerEvent?.created_at ?? violation.created_at;
  const firstSeenAgo = firstSeen ? humanDuration(now - new Date(firstSeen).getTime()) : "?";

  // Overstay duration: how long PAST valid_until they've been on property.
  // Only meaningful for `violation_type='overstay'` where lastPass exists.
  const overstayMs = lastPass?.valid_until ? now - new Date(lastPass.valid_until).getTime() : 0;
  const overstayAgo = overstayMs > 0 ? humanDuration(overstayMs) : null;

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

  // Branch copy by violation_type. The DB column carries the dispatch reason
  // (overstay / cooldown / unregistered / alpr_unmatched). Anything else
  // falls back to "Active overstay" so older rows without the column still
  // render sane text.
  const reasonCopy = (() => {
    switch ((violation.violation_type ?? "").toLowerCase()) {
      case "cooldown":
        return {
          subjectReason: "Cooldown breach",
          badge: "Cooldown breach",
          textStatus: "COOLDOWN BREACH",
          preheaderLead: `Cooldown breach · re-entered within 24h block · ${firstSeenAgo} on property`,
        };
      case "unregistered":
      case "alpr_unmatched":
        return {
          subjectReason: "Unregistered vehicle",
          badge: "Unregistered vehicle",
          textStatus: "UNREGISTERED VEHICLE",
          preheaderLead: `Unregistered vehicle · no pass on file · ${firstSeenAgo} on property`,
        };
      case "overstay":
      default:
        return {
          subjectReason: "Active overstay",
          badge: "Active overstay",
          textStatus: `ACTIVE OVERSTAY (${firstSeenAgo})`,
          preheaderLead: `Active overstay · ${firstSeenAgo} on property`,
        };
    }
  })();

  // Subject is the inbox headline. Lead with siren + plate so the line
  // scans in a phone notification: "DISPATCH · ABC1234 · Active overstay · Charlotte Travel Plaza".
  const subject = `🚨 DISPATCH · ${violation.plate_text} · ${reasonCopy.subjectReason} · ${propertyName}`;

  // Preheader: hidden span that mail clients surface in the inbox preview
  // line under the subject. This is the second-most read text in the email
  // and we control it entirely.
  const preheader = `${reasonCopy.preheaderLead} · tap to dispatch or stand down`;

  const textBody = [
    `LOTVIEW DISPATCH`,
    `${propertyName}${property.address ? ` — ${property.address}` : ""}`,
    ``,
    `PLATE        ${violation.plate_text}`,
    lastPass?.back_plate ? `TRAILER      ${lastPass.back_plate}` : null,
    `STATUS       ${reasonCopy.textStatus}`,
    `FIRST SEEN   ${formatLocal(firstSeen)}`,
    triggerEvent?.confidence != null ? `READ CONF.   ${Math.round(triggerEvent.confidence * 100)}%` : null,
    `PASS         ${passLine}`,
    lastPass?.visitor_name ? `PASS HOLDER  ${lastPass.visitor_name}` : null,
    triggerEvent?.image_url ? `PHOTO        ${triggerEvent.image_url}` : null,
    "",
    "── ONE-TAP ACTIONS ───────────────────",
    towLink ? `  > TOW CONFIRMED   ${towLink}` : null,
    noTowLink ? `  > STAND DOWN      ${noTowLink}` : null,
    "",
    `Open LotView dashboard → https://lotlogicparking.com/app`,
    `Links valid 48h · single-use · routed to dispatch ledger`,
  ].filter(Boolean).join("\n");

  // Brand-v2 (cream paper + Fraunces + DM Mono) — palette aligned with
  // visit.html / resident.html. Mail-client-safe: all styles inline, tables
  // for layout, no media queries, no external CSS reliance for fallbacks.
  const photoBlock = triggerEvent?.image_url
    ? `
<tr><td style="padding:0 28px 18px;">
  <div style="background:#F2EAD8; border:1.5px solid #1F1B14; overflow:hidden;">
    <div style="padding:10px 14px; font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:#6F6450; border-bottom:1.5px solid #1F1B14;">
      Trigger frame &middot; ${escapeHtml(formatLocal(triggerEvent?.created_at))}
    </div>
    <img src="${escapeHtml(triggerEvent.image_url)}" alt="Plate snapshot" style="display:block; width:100%; height:auto;" />
  </div>
</td></tr>`
    : "";

  const buttonsBlock = (towLink && noTowLink) ? `
<tr><td style="padding:4px 28px 8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">
    <tr>
      <td style="padding:0 6px 10px 0; width:50%;">
        <a href="${escapeHtml(towLink)}" style="display:block; background:#1F1B14; color:#F2EAD8; padding:18px 12px; text-align:center; text-decoration:none; border-radius:2px; font-family:'Fraunces',Georgia,serif; font-style:italic; font-weight:600; font-size:18px; letter-spacing:.02em; border:1.5px solid #1F1B14;">
          Tow confirmed
        </a>
      </td>
      <td style="padding:0 0 10px 6px; width:50%;">
        <a href="${escapeHtml(noTowLink)}" style="display:block; background:#F2EAD8; color:#1F1B14; padding:18px 12px; text-align:center; text-decoration:none; border-radius:2px; font-family:'Fraunces',Georgia,serif; font-style:italic; font-weight:600; font-size:18px; letter-spacing:.02em; border:1.5px solid #1F1B14;">
          Stand down
        </a>
      </td>
    </tr>
  </table>
  <p style="margin:4px 0 0; font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:#6F6450; text-align:center;">
    Single tap &middot; Single use &middot; Expires 48h
  </p>
</td></tr>` : "";

  const confidencePct = triggerEvent?.confidence != null
    ? Math.round((triggerEvent.confidence as number) * 100)
    : null;

  const metaRow = (label: string, value: string, mono = false) => `
<tr>
  <td style="padding:12px 0; width:36%; vertical-align:top; font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:#6F6450; border-bottom:1.5px dashed #1F1B14;">
    ${escapeHtml(label)}
  </td>
  <td style="padding:12px 0; vertical-align:top; font-family:${mono ? "'DM Mono',ui-monospace,monospace" : "'Manrope','Helvetica Neue',Arial,sans-serif"}; font-size:14px; color:#1F1B14; border-bottom:1.5px dashed #1F1B14;">
    ${value}
  </td>
</tr>`;

  // Plate-card subtitle is violation-type-aware. Overstays foreground the
  // overstay duration ("Overstayed 2h past 1:00 PM"); other types keep
  // the simpler "on property since" framing.
  const isOverstay = (violation.violation_type ?? "").toLowerCase() === "overstay";
  const plateSubtitle = isOverstay && overstayAgo
    ? `
<div style="margin-top:14px; font-family:'Fraunces',Georgia,serif; font-style:italic; font-size:20px; color:#9A5530; line-height:1.1;">
  Overstayed <strong style="font-style:normal; color:#1F1B14;">${escapeHtml(overstayAgo)}</strong>
</div>
<div style="margin-top:4px; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; font-size:12px; color:#3D3528;">
  past pass expiry &middot; ${escapeHtml(formatLocal(lastPass?.valid_until))}
</div>
<div style="margin-top:10px; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; font-size:12px; color:#6F6450;">
  Vehicle arrived ${escapeHtml(firstSeenAgo)} ago &middot; ${escapeHtml(formatLocal(firstSeen))}
</div>`
    : `
<div style="margin-top:12px; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; font-size:13px; color:#3D3528;">
  Parked on property for <strong style="color:#9A5530;">${escapeHtml(firstSeenAgo)}</strong> &middot; arrived ${escapeHtml(formatLocal(firstSeen))}
</div>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0; padding:0; background:#E6DBC2; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; color:#1F1B14;">
<div style="display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden; mso-hide:all;">
  ${escapeHtml(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E6DBC2;">
  <tr><td align="center" style="padding:32px 12px;">

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#F2EAD8; border-radius:0; overflow:hidden; border:1.5px solid #1F1B14;">

      <tr><td style="height:8px; background:repeating-linear-gradient(45deg, #9A5530 0 14px, #F2EAD8 14px 28px);">&nbsp;</td></tr>

      <tr><td style="padding:22px 28px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-family:'Fraunces',Georgia,serif; font-style:italic; font-size:28px; color:#1F1B14; letter-spacing:-.02em; line-height:1;">
              LotL<span style="color:#D97706; font-style:normal;">o</span>gic
            </td>
            <td align="right" style="font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:#6F6450;">
              Dispatch &middot; ${escapeHtml(formatLocal(now))}
            </td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:6px 28px 22px;">
        <div style="display:inline-block; background:#9A5530; color:#F2EAD8; padding:7px 12px; border-radius:2px; font-family:'DM Mono',ui-monospace,monospace; font-size:11px; letter-spacing:.18em; text-transform:uppercase;">
          Tow request
        </div>
        <div style="margin-top:14px; font-family:'Fraunces',Georgia,serif; font-style:italic; font-size:30px; line-height:1.1; color:#1F1B14; letter-spacing:-.01em;">
          ${escapeHtml(propertyName)}
        </div>
        ${property.address ? `<div style="margin-top:6px; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; font-size:13px; color:#6F6450;">${escapeHtml(property.address)}</div>` : ""}
      </td></tr>

      <tr><td style="padding:0 28px 22px;">
        <div style="background:#FBBF24; border:1.5px solid #1F1B14; padding:24px 20px; text-align:center;">
          <div style="font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.22em; text-transform:uppercase; color:#1F1B14; margin-bottom:10px;">
            License plate &middot; ${escapeHtml(reasonCopy.badge)}
          </div>
          <div style="font-family:'DM Mono',ui-monospace,monospace; font-size:38px; letter-spacing:.18em; color:#1F1B14; font-weight:500;">
            ${escapeHtml(violation.plate_text)}
          </div>
          ${plateSubtitle}
        </div>
      </td></tr>

      <tr><td style="padding:0 28px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          ${lastPass?.back_plate ? metaRow("Trailer plate", escapeHtml(lastPass.back_plate), true) : ""}
          ${confidencePct != null ? metaRow("Read confidence", `${confidencePct}%`, true) : ""}
          ${metaRow("Pass on file", escapeHtml(passLine))}
          ${lastPass?.visitor_name ? metaRow("Pass holder", escapeHtml(lastPass.visitor_name)) : ""}
        </table>
      </td></tr>

      ${photoBlock}

      ${buttonsBlock}

      <tr><td style="padding:18px 28px 22px;">
        <a href="https://lotlogicparking.com/app" style="display:block; background:#D97706; color:#F2EAD8; padding:14px 16px; text-align:center; text-decoration:none; border-radius:2px; font-family:'DM Mono',ui-monospace,monospace; font-size:12px; letter-spacing:.22em; text-transform:uppercase; border:1.5px solid #9A5530;">
          Open LotView dashboard
        </a>
      </td></tr>

      <tr><td style="padding:16px 28px 18px; border-top:1.5px solid #1F1B14;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-family:'DM Mono',ui-monospace,monospace; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:#6F6450;">
              LotLogic &middot; Highway dispatch
            </td>
            <td align="right" style="font-family:'Fraunces',Georgia,serif; font-style:italic; font-size:12px; color:#6F6450;">
              lotlogicparking.com
            </td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="height:6px; background:#D97706;">&nbsp;</td></tr>

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

  // Atomic claim: stamp sms_sent_at BEFORE calling Resend. Without this,
  // two concurrent cron ticks would both pass the `if (violation.sms_sent_at)`
  // check at line ~129 (reading the row before either has written) and
  // both send a Resend email → partner receives duplicates. By writing
  // the claim first and checking the rowcount, only one invocation wins.
  // If Resend ultimately fails we revert the claim so the cron can retry.
  const claimTs = new Date().toISOString();
  const claim = await supabase
    .from("alpr_violations")
    .update({
      sms_sent_at: claimTs,
      status: "dispatched",
      dispatched_at: claimTs,
    })
    .eq("id", violation.id)
    .is("sms_sent_at", null)
    .select("id");
  if (claim.error) {
    return json({ error: "Claim failed", detail: claim.error.message }, 500);
  }
  if (!claim.data || claim.data.length === 0) {
    // Another invocation beat us to it. Idempotent success — the email
    // (or one identical to it) has already been sent or is in flight.
    return json({ status: "already_sent_by_concurrent_invocation", violation_id: violation.id }, 200);
  }

  const sendResult = await sendViaResend(resendKey, fromEmail, recipient, ccList, subject, textBody, html);

  if (!sendResult.ok) {
    // Resend failed. Revert the claim so the cron retries on next tick.
    // If THIS rollback fails too, we accept a stuck-dispatched row over
    // duplicate emails — operator can manually re-fire from the dashboard.
    await supabase
      .from("alpr_violations")
      .update({ sms_sent_at: null, status: "pending", dispatched_at: null })
      .eq("id", violation.id);
    return json({
      error: `${sendResult.provider} send failed`,
      provider: sendResult.provider,
      status: sendResult.status,
      body: sendResult.body,
    }, 502);
  }

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

// Short "vehicle left before tow — stand down" follow-up email. Sent
// when truck_plaza_exit detects a camera read on a plate whose
// overstay violation was already dispatched. The partner gets one
// line + plate + time so they can cancel before rolling a truck. No
// action buttons — the violation is already auto-resolved server-side.
async function sendLeftBeforeTowEmail(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  violation: {
    id: string;
    property_id: string;
    plate_text: string;
    left_before_tow_at: string | null;
  },
  resendKey: string,
  fromEmail: string,
): Promise<Response> {
  // Atomic idempotency claim. Multiple invocations of this function can
  // race (camera's fire-and-forget + the cron sweep retry, or two camera
  // double-reads). Only the first invocation that flips
  // left_before_tow_email_sent_at from NULL → now() wins the right to
  // actually send the email. Everyone else returns already_sent.
  const claimTs = new Date().toISOString();
  const claim = await supabase
    .from("alpr_violations")
    .update({ left_before_tow_email_sent_at: claimTs })
    .eq("id", violation.id)
    .is("left_before_tow_email_sent_at", null)
    .select("id")
    .maybeSingle();
  if (claim.error) {
    return json({ error: "claim_failed", violation_id: violation.id, detail: claim.error.message }, 500);
  }
  if (!claim.data) {
    return json({ status: "already_sent", violation_id: violation.id, message: "stand-down already dispatched by a concurrent invocation" }, 200);
  }

  const { data: property } = await supabase
    .from("properties")
    .select("id, name, address, tow_company_id")
    .eq("id", violation.property_id)
    .single();
  if (!property?.tow_company_id) {
    return json({ error: "Property has no tow_company_id", violation_id: violation.id }, 409);
  }

  const { data: partner } = await supabase
    .from("enforcement_partners")
    .select("id, company_name, email, active")
    .eq("id", property.tow_company_id)
    .single();
  if (!partner?.email || !partner.active) {
    return json({ error: "Tow company unavailable", violation_id: violation.id }, 409);
  }

  const leftAt = formatLocal(violation.left_before_tow_at);
  const propertyName = property.name || "LotLogic property";
  const subject = `🟢 STAND DOWN · ${violation.plate_text} · ${propertyName}`;
  const preheader = `Vehicle left before tow at ${leftAt} — no action needed`;
  const textBody = [
    `LOTVIEW STAND DOWN`,
    `${propertyName}${property.address ? ` — ${property.address}` : ""}`,
    ``,
    `PLATE      ${violation.plate_text}`,
    `LEFT AT    ${leftAt}`,
    ``,
    `Vehicle was caught on camera leaving the lot after the dispatch email`,
    `was sent. No tow needed — the violation is auto-resolved.`,
    ``,
    `Open LotView dashboard → https://lotlogicparking.com/app`,
  ].join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; background:#F2EAD8; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; color:#1F1B14;">
<div style="display:none; opacity:0; max-height:0; overflow:hidden;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2EAD8; padding:40px 16px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px; background:#FAF6EB; border:1.5px solid #1F1B14;">
      <tr><td style="padding:28px 28px 8px;">
        <div style="font-family:'DM Mono',ui-monospace,monospace; font-size:11px; letter-spacing:.22em; text-transform:uppercase; color:#3D7B4A;">Stand down</div>
        <div style="margin-top:8px; font-family:'Fraunces',Georgia,serif; font-size:30px; font-weight:600; color:#1F1B14; letter-spacing:-.01em;">${escapeHtml(violation.plate_text)}</div>
        <div style="margin-top:6px; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; font-size:14px; color:#3D3528;">${escapeHtml(propertyName)}</div>
      </td></tr>
      <tr><td style="padding:8px 28px 4px;">
        <p style="margin:14px 0 0; font-family:'Manrope','Helvetica Neue',Arial,sans-serif; font-size:15px; line-height:1.55; color:#1F1B14;">
          Vehicle was caught on camera <strong>leaving the lot</strong> after our dispatch went out.
          <strong>No tow needed</strong> — the violation is auto-resolved.
        </p>
        <p style="margin:18px 0 0; font-family:'DM Mono',ui-monospace,monospace; font-size:12px; color:#6F6450;">
          Left at ${escapeHtml(leftAt)}
        </p>
      </td></tr>
      <tr><td style="padding:24px 28px 28px;">
        <a href="https://lotlogicparking.com/app" style="font-family:'Manrope','Helvetica Neue',Arial,sans-serif; font-size:13px; color:#1F1B14;">Open LotView dashboard →</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  const sendResult = await sendViaResend(resendKey, fromEmail, partner.email, [], subject, textBody, html);
  if (!sendResult.ok) {
    // Roll the claim back so the cron sweep can re-claim on the next tick.
    // Without this, a failed Resend call leaves the column populated and
    // NMLD never gets the stand-down — exactly the silent-failure mode
    // this whole flow was designed to prevent.
    await supabase
      .from("alpr_violations")
      .update({ left_before_tow_email_sent_at: null })
      .eq("id", violation.id)
      .eq("left_before_tow_email_sent_at", claimTs);
    return json({ error: "send_failed", violation_id: violation.id, detail: sendResult.body }, 502);
  }
  return json({ status: "stand_down_sent", violation_id: violation.id, to: partner.email, message_id: sendResult.messageId ?? null }, 200);
}

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
