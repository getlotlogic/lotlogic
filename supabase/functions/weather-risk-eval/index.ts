// weather-risk-eval
//
// Reads the upcoming forecast from public.plaza_weather and emails an early
// warning when a solar brownout stretch is likely (2-3 day lead, moderate).
// Model validated against the 5/25-5/26 event that preceded the real North
// C4467 outage: brownout follows multi-day LOW-SOLAR / rain spells, not any
// single day's cloud %. So the trigger keys on solar energy + sunshine +
// heavy rain, NOT cloud_mean alone.
//
// Dedupe: one email per stretch (keyed by the first risky date) via the
// weather_alerts unique constraint. Email transport = Resend, same as
// tow-dispatch-email. Recipient = ALERT_TO (default gabriel@lotlogicparking.com).
//
// Schedule: on every weather-pull + a daily 07:00 ET check via pg_cron.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TZ = "America/New_York";

// --- Tunables (moderate, 2-3 day lead). Calibrated against 5/25-5/26. ---
const WINDOW_DAYS = 3;            // look this many forecast days ahead
const LOW_SOLAR_MJ = 16;         // a day under this is "low solar"
const LOW_SUNSHINE_H = 5;        // ...or under this many sunshine hours
const MIN_RISKY_DAYS = 2;        // >= this many low days in the window => risk
const HEAVY_RAIN_MM = 8;         // any single day over this...
const HEAVY_RAIN_CLOUD = 80;     // ...AND cloudier than this => risk on its own

function etTodayISO(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

type Day = {
  weather_date: string; solar_mj: number | null; sunshine_h: number | null;
  cloud_mean: number | null; precip_mm: number | null;
};

function evaluate(days: Day[]): {
  risk: boolean; riskyDays: Day[]; heavyRainDays: Day[]; stretchKey: string | null;
} {
  const lowDays = days.filter((d) =>
    (d.solar_mj != null && d.solar_mj < LOW_SOLAR_MJ) ||
    (d.sunshine_h != null && d.sunshine_h < LOW_SUNSHINE_H));
  const heavyRainDays = days.filter((d) =>
    (d.precip_mm ?? 0) > HEAVY_RAIN_MM && (d.cloud_mean ?? 0) > HEAVY_RAIN_CLOUD);
  const risk = lowDays.length >= MIN_RISKY_DAYS || heavyRainDays.length > 0;
  const trigger = [...lowDays, ...heavyRainDays].sort((a, b) =>
    a.weather_date.localeCompare(b.weather_date));
  return {
    risk, riskyDays: lowDays, heavyRainDays,
    stretchKey: risk && trigger.length ? trigger[0].weather_date : null,
  };
}

function fmtDay(d: Day): string {
  const parts: string[] = [];
  if (d.solar_mj != null) parts.push(`${d.solar_mj.toFixed(1)} MJ/m²`);
  if (d.sunshine_h != null) parts.push(`${d.sunshine_h.toFixed(1)}h sun`);
  if (d.cloud_mean != null) parts.push(`${Math.round(d.cloud_mean)}% cloud`);
  if ((d.precip_mm ?? 0) > 0) parts.push(`${d.precip_mm!.toFixed(1)}mm rain`);
  return `${d.weather_date}: ${parts.join(", ")}`;
}

async function sendEmail(subject: string, text: string): Promise<{ ok: boolean; detail?: unknown }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("FROM_EMAIL") || "dispatch@lotlogicparking.com";
  const to = Deno.env.get("ALERT_TO") || "gabriel@lotlogicparking.com";
  if (!apiKey) return { ok: false, detail: "RESEND_API_KEY not set" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) return { ok: false, detail: await res.text().catch(() => res.status) };
  return { ok: true };
}

export async function run(db: SupabaseClient, opts: { dryRun?: boolean } = {}): Promise<unknown> {
  const today = etTodayISO();
  const { data: props, error } = await db
    .from("properties").select("id, name").not("lat", "is", null).not("lng", "is", null);
  if (error) throw error;

  const results: unknown[] = [];
  for (const p of props ?? []) {
    const { data: rows } = await db
      .from("plaza_weather")
      .select("weather_date, solar_mj, sunshine_h, cloud_mean, precip_mm")
      .eq("property_id", p.id)
      .gte("weather_date", today)
      .order("weather_date", { ascending: true })
      .limit(WINDOW_DAYS);
    const days = (rows ?? []) as Day[];
    const evald = evaluate(days);
    const base = { property: p.name, risk: evald.risk, window: days.map((d) => d.weather_date) };

    if (!evald.risk || !evald.stretchKey) { results.push({ ...base, action: "no_risk" }); continue; }

    if (opts.dryRun) { results.push({ ...base, action: "would_alert", stretchKey: evald.stretchKey }); continue; }

    // Dedupe: try to claim this stretch. ignoreDuplicates => empty rows back if
    // we've already alerted for this stretch start.
    const claim = await db.from("weather_alerts")
      .upsert([{ property_id: p.id, kind: "brownout_risk", stretch_key: evald.stretchKey,
        payload: { riskyDays: evald.riskyDays, heavyRainDays: evald.heavyRainDays } }],
        { onConflict: "property_id,kind,stretch_key", ignoreDuplicates: true })
      .select("id");
    if (!claim.data || claim.data.length === 0) { results.push({ ...base, action: "already_alerted", stretchKey: evald.stretchKey }); continue; }

    const lines = [
      `${p.name} — solar brownout risk ahead.`,
      ``,
      `The forecast shows a low-solar stretch likely to draw down the solar`,
      `battery and brown out the North gate camera (C4467). Heads up so you`,
      `can plan around it (drive out / swap battery / expect a gap).`,
      ``,
      `Risk days:`,
      ...[...evald.riskyDays, ...evald.heavyRainDays]
        .sort((a, b) => a.weather_date.localeCompare(b.weather_date))
        .filter((d, i, arr) => arr.findIndex((x) => x.weather_date === d.weather_date) === i)
        .map((d) => `  • ${fmtDay(d)}`),
      ``,
      `Recovery needs 1-2 consecutive clear/high-solar days after the stretch.`,
      ``,
      `— LotLogic weather watch`,
    ].join("\n");
    const subject = `⚠️ Solar brownout risk — ${p.name} — from ${evald.stretchKey}`;
    const sent = await sendEmail(subject, lines);
    if (!sent.ok) {
      // Roll back the claim so the next run retries the email.
      await db.from("weather_alerts").delete()
        .eq("property_id", p.id).eq("kind", "brownout_risk").eq("stretch_key", evald.stretchKey);
      results.push({ ...base, action: "email_failed", detail: sent.detail });
      continue;
    }
    results.push({ ...base, action: "alerted", stretchKey: evald.stretchKey });
  }
  return { evaluated: results };
}

serve(async (req) => {
  try {
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
    const summary = await run(db, { dryRun });
    console.log("weather-risk-eval", JSON.stringify(summary));
    return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
  } catch (err) {
    console.error("weather-risk-eval failed", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
});
