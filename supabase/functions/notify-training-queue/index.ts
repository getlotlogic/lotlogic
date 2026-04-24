// Hourly cron-driven notifier for the camera-training labeling queue.
//
// Runs every hour (pg_cron). Counts sidecar-rejected plate_events that
// have no operator_label yet. If the queue size has crossed a threshold
// AND has grown since the last alert, send an email to the owner with
// a link to the dashboard's Training tab. State is tracked in the
// `training_queue_alerts` table so we don't spam.
//
// Threshold + cooldown logic prevents notification fatigue:
//   - Don't alert below MIN_QUEUE_SIZE (default 50)
//   - Don't alert again until queue has grown by ALERT_GROWTH (default 20)
//     since the last alert, OR ALERT_COOLDOWN_HOURS (default 24) has passed

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "dispatch@lotlogicparking.com";
const TO_EMAIL = Deno.env.get("TRAINING_NOTIFY_TO") || "gabebs1@gmail.com";
const DASHBOARD_URL = Deno.env.get("DASHBOARD_URL") || "https://lotlogic-beta.vercel.app";
const MIN_QUEUE_SIZE = Number(Deno.env.get("TRAINING_MIN_QUEUE_SIZE") ?? "50");
const ALERT_GROWTH = Number(Deno.env.get("TRAINING_ALERT_GROWTH") ?? "20");
const ALERT_COOLDOWN_HOURS = Number(Deno.env.get("TRAINING_ALERT_COOLDOWN_HOURS") ?? "24");

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (_req: Request) => {
  try {
    // 1. Count unlabeled sidecar-rejected frames
    const { count: queueSize, error: cErr } = await db
      .from("plate_events")
      .select("id", { count: "exact", head: true })
      .eq("match_status", "sidecar_rejected")
      .is("raw_data->>operator_label", null);
    if (cErr) throw cErr;
    const size = queueSize ?? 0;

    // 2. Look up the most recent alert to decide whether to fire
    const { data: prevAlerts, error: pErr } = await db
      .from("training_queue_alerts")
      .select("id, sent_at, queue_size_when_sent")
      .order("sent_at", { ascending: false })
      .limit(1);
    if (pErr) throw pErr;
    const prev = prevAlerts?.[0];
    const nowMs = Date.now();
    const cooldownPassed = !prev ||
      nowMs - new Date(prev.sent_at).getTime() > ALERT_COOLDOWN_HOURS * 3600 * 1000;
    const grownEnough = !prev || size - prev.queue_size_when_sent >= ALERT_GROWTH;

    if (size < MIN_QUEUE_SIZE) {
      return json(200, { ok: true, queue_size: size, alerted: false, reason: "below_min_queue_size" });
    }
    if (!cooldownPassed && !grownEnough) {
      return json(200, { ok: true, queue_size: size, alerted: false, reason: "cooldown_active" });
    }

    if (!RESEND_API_KEY) {
      return json(500, { ok: false, error: "RESEND_API_KEY not set" });
    }

    // 3. Send the email
    const subject = `[LotLogic] ${size} camera frames need labeling`;
    const html = `<!doctype html>
<html><body style="font-family:-apple-system, Segoe UI, sans-serif; color:#111; max-width:560px; margin:0 auto; padding:18px;">
<h2 style="margin:0 0 10px; color:#0ea5e9;">Camera training queue</h2>
<p style="font-size:15px; margin:0 0 14px;">
  The sidecar has thrown away <strong>${size}</strong> frames since they were last reviewed.
  Quick scan helps the gate auto-tune itself — every label feeds the training-curator.
</p>
<p style="margin:18px 0;">
  <a href="${DASHBOARD_URL}/dashboard.html#training" style="display:inline-block; background:#0ea5e9; color:#fff; padding:12px 22px; text-decoration:none; border-radius:6px; font-weight:700;">Open Training tab</a>
</p>
<p style="color:#555; font-size:12px; margin-top:18px;">
  You'll get this email at most once per ${ALERT_COOLDOWN_HOURS}h, or when the queue grows by another ${ALERT_GROWTH}+ frames.
</p>
</body></html>`;
    const textBody = `Camera training queue — ${size} frames need review.\nOpen: ${DASHBOARD_URL}/dashboard.html#training`;

    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [TO_EMAIL], subject, html, text: textBody }),
    });
    if (!sendRes.ok) {
      const errBody = await sendRes.text().catch(() => "");
      return json(502, { ok: false, error: "resend_failed", status: sendRes.status, body: errBody.slice(0, 200) });
    }

    // 4. Record the alert so cooldown logic works next run
    const { error: insErr } = await db
      .from("training_queue_alerts")
      .insert({ queue_size_when_sent: size });
    if (insErr) console.warn("training_queue_alerts insert failed:", insErr.message);

    return json(200, { ok: true, queue_size: size, alerted: true });
  } catch (err) {
    console.error("notify-training-queue error:", err);
    return json(500, { ok: false, error: String(err) });
  }
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}
