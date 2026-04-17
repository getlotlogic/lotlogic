// Supabase Edge Function: alpr-daily-report
// Runs daily via cron. For every property with ALPR cameras, aggregates the
// prior 24 hours of plate_events + alpr_violations and emails the owner a
// summary so they can spot camera drift, review-queue depth, and any tow
// candidates that need a click.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (write access to everything)
//   RESEND_API_KEY (optional — dry-run when absent)
//   FROM_EMAIL    (optional — defaults to noreply@lotlogic.com)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY       = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL           = Deno.env.get("FROM_EMAIL") || "noreply@lotlogic.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const JSON_HEADERS = { "Content-Type": "application/json" };

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.log(`[DRY RUN] Would email ${to}: ${subject}`);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  if (!res.ok) {
    console.error(`Email send to ${to} failed: ${await res.text()}`);
    return false;
  }
  return true;
}

function pill(text: string, color: string): string {
  return `<span style="display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:3px 10px;border-radius:20px;background:${color}22;color:${color};border:1px solid ${color}44;">${text}</span>`;
}

function buildHtml(params: {
  propertyName: string;
  ownerName: string;
  windowLabel: string;
  events: number;
  matched: number;
  unmatched: number;
  lowConfidence: number;
  reviewNeeded: number;
  cameraSuspended: number;
  violationsPending: number;
  violationsDispatched: number;
  suspendedCameras: { name: string; avg: number | null }[];
  topUnmatchedPlates: { plate: string; count: number }[];
  dashboardUrl: string;
}): string {
  const p = params;
  const alarmColor = p.violationsPending > 0 ? "#f87171" : "#4ade80";
  const suspendedRows = p.suspendedCameras.length === 0
    ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">No cameras suspended.</td></tr>`
    : p.suspendedCameras.map(c =>
      `<tr><td style="padding:4px 0;color:#1f2937;font-size:13px;">${c.name}</td>
           <td style="padding:4px 0;color:#b91c1c;font-size:12px;text-align:right;">avg ${c.avg == null ? "n/a" : (c.avg * 100).toFixed(0) + "%"}</td></tr>`
    ).join("");
  const unmatchedRows = p.topUnmatchedPlates.length === 0
    ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">No unmatched plates.</td></tr>`
    : p.topUnmatchedPlates.map(u =>
      `<tr><td style="padding:4px 0;font-family:monospace;font-size:13px;color:#1f2937;letter-spacing:.05em;">${u.plate}</td>
           <td style="padding:4px 0;color:#6b7280;font-size:12px;text-align:right;">${u.count}&times; seen</td></tr>`
    ).join("");

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#f9fafb;">
  <div style="text-align:center;margin-bottom:24px;">
    <div style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;font-weight:900;font-size:18px;width:48px;height:48px;line-height:48px;border-radius:12px;">LL</div>
    <h1 style="font-size:20px;color:#111827;margin:8px 0 0;">${p.propertyName}</h1>
    <div style="font-size:12px;color:#6b7280;margin-top:4px;">Daily ALPR report · ${p.windowLabel}</div>
  </div>

  <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #e5e7eb;margin-bottom:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div>
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">Total reads</div>
        <div style="font-size:32px;font-weight:800;color:#111827;line-height:1.1;">${p.events}</div>
      </div>
      <div style="text-align:right;">
        ${p.violationsPending > 0 ? pill(`${p.violationsPending} pending tow${p.violationsPending === 1 ? "" : "s"}`, "#f87171") : pill("All clear", "#4ade80")}
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-top:8px;">
      <tr>
        <td style="padding:6px 0;color:#4b5563;font-size:13px;">Matched to a pass</td>
        <td style="padding:6px 0;color:#059669;font-size:13px;font-weight:700;text-align:right;">${p.matched}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#4b5563;font-size:13px;">Low confidence (held for review)</td>
        <td style="padding:6px 0;color:#b45309;font-size:13px;font-weight:700;text-align:right;">${p.lowConfidence}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#4b5563;font-size:13px;">Ambiguous match (needs review)</td>
        <td style="padding:6px 0;color:#b45309;font-size:13px;font-weight:700;text-align:right;">${p.reviewNeeded}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#4b5563;font-size:13px;">Skipped (camera suspended)</td>
        <td style="padding:6px 0;color:#b91c1c;font-size:13px;font-weight:700;text-align:right;">${p.cameraSuspended}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#4b5563;font-size:13px;">Unmatched (past grace)</td>
        <td style="padding:6px 0;color:${alarmColor};font-size:13px;font-weight:700;text-align:right;">${p.unmatched}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#4b5563;font-size:13px;">Tows dispatched</td>
        <td style="padding:6px 0;color:#111827;font-size:13px;font-weight:700;text-align:right;">${p.violationsDispatched}</td>
      </tr>
    </table>
  </div>

  <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #e5e7eb;margin-bottom:16px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:12px;">Suspended cameras</div>
    <table style="width:100%;border-collapse:collapse;">${suspendedRows}</table>
  </div>

  <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #e5e7eb;margin-bottom:20px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:12px;">Top unmatched plates</div>
    <table style="width:100%;border-collapse:collapse;">${unmatchedRows}</table>
  </div>

  <div style="text-align:center;margin:20px 0 12px;">
    <a href="${p.dashboardUrl}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:10px 22px;border-radius:8px;">Open dashboard</a>
  </div>
  <p style="font-size:12px;color:#9ca3af;text-align:center;margin:24px 0 0;">
    This is an automated daily summary from LotLogic. Replies aren't monitored.
  </p>
</div>`;
}

serve(async (_req: Request) => {
  try {
    const now   = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sinceIso = since.toISOString();
    const windowLabel = `${since.toUTCString().slice(0, 16)} → ${now.toUTCString().slice(0, 16)} UTC`;

    // Properties that have at least one ALPR camera — no point reporting
    // on properties with zero coverage.
    const { data: camProps } = await supabase
      .from("alpr_cameras")
      .select("property_id")
      .eq("active", true);
    const propertyIds = [...new Set((camProps ?? []).map((c: { property_id: string }) => c.property_id))];

    if (propertyIds.length === 0) {
      return new Response(JSON.stringify({ message: "no ALPR properties", count: 0 }), { headers: JSON_HEADERS });
    }

    const { data: properties } = await supabase
      .from("properties")
      .select("id, name, owner_id")
      .in("id", propertyIds);

    const ownerIds = [...new Set((properties ?? []).map((p: { owner_id: string | null }) => p.owner_id).filter(Boolean))];
    const { data: owners } = await supabase
      .from("lot_owners")
      .select("id, email, name")
      .in("id", ownerIds);
    const ownerById: Record<string, { email: string; name: string }> = {};
    (owners ?? []).forEach((o: { id: string; email: string; name: string }) => { ownerById[o.id] = { email: o.email, name: o.name }; });

    let sent = 0, skipped = 0;
    const results: unknown[] = [];

    for (const prop of (properties ?? []) as { id: string; name: string; owner_id: string | null }[]) {
      const owner = prop.owner_id ? ownerById[prop.owner_id] : null;

      // One wide read is cheaper than six narrow ones when the volume is
      // already bounded to a single property's last 24h.
      const { data: events } = await supabase
        .from("plate_events")
        .select("match_status, plate_text, normalized_plate")
        .eq("property_id", prop.id)
        .gte("created_at", sinceIso);

      const evs = (events ?? []) as { match_status: string; plate_text: string; normalized_plate: string | null }[];
      const matched         = evs.filter(e => e.match_status === "matched").length;
      const unmatched       = evs.filter(e => e.match_status === "unmatched").length;
      const lowConfidence   = evs.filter(e => e.match_status === "low_confidence").length;
      const reviewNeeded    = evs.filter(e => e.match_status === "review_needed").length;
      const cameraSuspended = evs.filter(e => e.match_status === "camera_suspended").length;

      // Suspended cameras right now (not just in window) are actionable info.
      const { data: health } = await supabase
        .from("camera_health")
        .select("camera_id, avg_confidence_1h, suspended_until")
        .gt("suspended_until", now.toISOString());
      const { data: cams } = await supabase
        .from("alpr_cameras")
        .select("id, name")
        .eq("property_id", prop.id);
      const camNameById: Record<string, string> = {};
      (cams ?? []).forEach((c: { id: string; name: string }) => { camNameById[c.id] = c.name; });
      const suspendedCameras = (health ?? [])
        .filter((h: { camera_id: string }) => h.camera_id in camNameById)
        .map((h: { camera_id: string; avg_confidence_1h: number | null }) => ({ name: camNameById[h.camera_id], avg: h.avg_confidence_1h }));

      // Count top unmatched plates — most actionable for an operator.
      const unmatchedByPlate: Record<string, number> = {};
      evs.filter(e => e.match_status === "unmatched" || e.match_status === "review_needed")
        .forEach(e => {
          const key = e.normalized_plate || e.plate_text;
          unmatchedByPlate[key] = (unmatchedByPlate[key] ?? 0) + 1;
        });
      const topUnmatchedPlates = Object.entries(unmatchedByPlate)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([plate, count]) => ({ plate, count }));

      const { data: pendingV } = await supabase
        .from("alpr_violations").select("id", { count: "exact", head: true })
        .eq("property_id", prop.id).eq("status", "pending")
        .gte("created_at", sinceIso);
      const { data: dispatchedV } = await supabase
        .from("alpr_violations").select("id", { count: "exact", head: true })
        .eq("property_id", prop.id).eq("status", "dispatched")
        .gte("created_at", sinceIso);
      const violationsPending    = (pendingV as unknown as { count: number } | null)?.count ?? 0;
      const violationsDispatched = (dispatchedV as unknown as { count: number } | null)?.count ?? 0;

      const report = {
        propertyId: prop.id,
        propertyName: prop.name,
        events: evs.length,
        matched, unmatched, lowConfidence, reviewNeeded, cameraSuspended,
        violationsPending, violationsDispatched,
        suspendedCameras, topUnmatchedPlates,
      };
      results.push(report);

      if (!owner?.email) { skipped++; continue; }

      const html = buildHtml({
        propertyName: prop.name,
        ownerName: owner.name || "there",
        windowLabel,
        events: evs.length,
        matched, unmatched, lowConfidence, reviewNeeded, cameraSuspended,
        violationsPending, violationsDispatched,
        suspendedCameras, topUnmatchedPlates,
        dashboardUrl: `https://lotlogic-beta.vercel.app/app`,
      });
      const subj = violationsPending > 0
        ? `[LotLogic] ${prop.name} — ${violationsPending} tow${violationsPending === 1 ? "" : "s"} awaiting dispatch`
        : `[LotLogic] ${prop.name} — daily summary (${evs.length} reads)`;
      const ok = await sendEmail(owner.email, subj, html);
      if (ok) sent++; else skipped++;
    }

    return new Response(JSON.stringify({
      message: `sent ${sent}, skipped ${skipped}`,
      sent, skipped,
      dry_run: !RESEND_API_KEY,
      results,
    }), { headers: JSON_HEADERS });
  } catch (err) {
    console.error("alpr-daily-report error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: JSON_HEADERS });
  }
});
