// weather-pull
//
// Pulls Open-Meteo daily weather (recent actuals + 7-day forecast) for every
// property that has coordinates, and upserts it into public.plaza_weather.
// Forecast rows overwrite on each run until their date passes, then hold as
// actuals. Feeds the brownout-risk early-warning engine.
//
// Schedule: every 6h via pg_cron.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TZ = "America/New_York";

function etTodayISO(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function pullForProperty(
  db: SupabaseClient,
  prop: { id: string; lat: number; lng: number },
  today: string,
): Promise<number> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(prop.lat));
  url.searchParams.set("longitude", String(prop.lng));
  url.searchParams.set(
    "daily",
    "sunshine_duration,shortwave_radiation_sum,cloud_cover_mean,precipitation_sum,weather_code,temperature_2m_max",
  );
  url.searchParams.set("timezone", TZ);
  url.searchParams.set("past_days", "3");
  url.searchParams.set("forecast_days", "7");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`open-meteo ${res.status} for ${prop.id}`);
  const j = await res.json();
  const d = j.daily;
  if (!d?.time) return 0;

  const rows = d.time.map((date: string, i: number) => ({
    property_id: prop.id,
    weather_date: date,
    solar_mj: d.shortwave_radiation_sum?.[i] ?? null,
    sunshine_h: d.sunshine_duration?.[i] != null ? d.sunshine_duration[i] / 3600 : null,
    cloud_mean: d.cloud_cover_mean?.[i] ?? null,
    precip_mm: d.precipitation_sum?.[i] ?? null,
    weather_code: d.weather_code?.[i] ?? null,
    tmax: d.temperature_2m_max?.[i] ?? null,
    is_forecast: date >= today,
    pulled_at: new Date().toISOString(),
  }));

  const { error } = await db.from("plaza_weather").upsert(rows, {
    onConflict: "property_id,weather_date",
  });
  if (error) throw error;
  return rows.length;
}

export async function pull(db: SupabaseClient): Promise<{ properties: number; rows: number }> {
  const today = etTodayISO();
  const { data: props, error } = await db
    .from("properties")
    .select("id, lat, lng")
    .not("lat", "is", null)
    .not("lng", "is", null);
  if (error) throw error;

  let rows = 0;
  for (const p of props ?? []) {
    rows += await pullForProperty(db, p as { id: string; lat: number; lng: number }, today);
  }
  return { properties: props?.length ?? 0, rows };
}

serve(async (_req) => {
  try {
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const summary = await pull(db);
    console.log("weather-pull", summary);
    return new Response(JSON.stringify(summary), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("weather-pull failed", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
});
