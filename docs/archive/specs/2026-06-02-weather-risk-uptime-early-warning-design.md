# Charlotte Weather-Risk & Uptime Early-Warning System — design
**2026-06-02 · approved**

## Goal
Know **2–3 days ahead** when solar conditions will likely brown out the Charlotte Travel Plaza, track **true uptime** for both cameras, and **email** early warnings — fully automated, no human polling.

Builds on the validated correlation (`2026-06-02-charlotte-plaza-solar-weather-correlation.md`): North C4467 uptime tracks cumulative solar (+0.67), brownout follows multi-day low-solar/rain spells, recovery needs ≥2 consecutive high-solar days.

## Decisions (locked)
- **Alerts:** email to `gabriel@lotlogicparking.com`.
- **Lead/sensitivity:** 2–3 day, moderate.
- **Uptime source:** true ping uptime via **RUT-hosted pollers** (option A).

## Architecture

### Constraint that drives everything
Supabase/cloud crons **cannot reach the cameras** (private ZeroTier mesh). So:
- Weather + risk + alerting = fully cloud (edge fns + pg_cron, like existing crons).
- Uptime = pushed *out* from the ZT LAN by a poller that lives on the always-on RUT.

### Component 1 — Uptime truth (RUT pollers → cloud)
- **RUT poller**: cron script on each RUT — north `10.157.80.41`, south `10.157.80.216` — pings its camera (`192.168.6.190` / `192.168.5.190`) every ~2 min, measures latency, and POSTs `{camera_api_key, up, latency_ms, ts}` to a new edge function.
- **Edge fn `camera-watchdog`**: validates a shared secret, resolves `camera_api_key`→`camera_id`, inserts a row into the existing-but-empty **`heartbeats`** table (`camera_id, received_at, status, latency_ms, note`). `status` ∈ `up|down`.
- **Site-brownout inference**: when a RUT loses power its POSTs stop entirely. A cloud watchdog cron detects "no heartbeat from camera X for > GAP min" → site/camera down. This is what finally distinguishes **down** from **quiet** (fixes the South ambiguity).

### Component 2 — Weather ingestion (cloud)
- **Edge fn `weather-pull`**: fetches Open-Meteo for `35.307668,−80.850471`, `timezone=America/New_York`:
  - daily: `sunshine_duration, shortwave_radiation_sum, cloud_cover_mean, precipitation_sum, weather_code, temperature_2m_max`
  - `past_days=3` (firm up actuals) + `forecast_days=7`.
- Upserts into new table **`plaza_weather`** keyed by `(property_id, weather_date)`: `solar_mj, sunshine_h, cloud_mean, precip_mm, weather_code, tmax, is_forecast, pulled_at`. Forecast rows overwrite until the date passes, then hold as actuals.
- pg_cron: every 6h.

### Component 3 — Risk engine + email alerts (cloud)
- **Risk score** from the validated model — cumulative solar / consecutive low-sun days / rain (NOT single-day cloud %).
- **v1 threshold (moderate, calibrated against the 5/25–5/26 event that preceded the real outage):** raise risk when the next 3 forecast days contain **≥2 days with `solar_mj < 16` OR `sunshine_h < 5`**, OR **any day with `precip_mm > 8` AND `cloud_mean > 80`**.
- **Edge fn `weather-risk-eval`** (or pg_cron SQL): on each weather pull + a daily 07:00 ET check, evaluate the window. If risk crosses and we have **not already emailed for this stretch** (dedupe via a `weather_alerts` log table keyed by stretch start date) → send email: which days, the numbers, plain-language "North likely to brown out around <dates> — consider <action>."
- **Downtime email**: from heartbeats — camera/site confirmed down > threshold during expected-active hours → email (also deduped).
- Email transport: SendGrid HTTP API from the edge function (needs `SENDGRID_API_KEY` + `ALERT_FROM`/`ALERT_TO` as Supabase secrets).

### Component 4 — Correlation / reporting
- View **`v_camera_uptime_vs_weather`**: daily real uptime (from `heartbeats`) × `plaza_weather`, per camera. Makes the one-off report reproducible for **both** cameras with measured uptime.
- Optional weekly email brief (phase 2).

## Cadence
Weather pull every 6h · risk eval on each pull + daily 07:00 ET · RUT ping every 2 min · watchdog every 10 min.

## Data model (new)
- `plaza_weather(property_id, weather_date, solar_mj, sunshine_h, cloud_mean, precip_mm, weather_code, tmax, is_forecast, pulled_at)` — PK `(property_id, weather_date)`.
- `weather_alerts(id, property_id, stretch_start, kind, payload, sent_at)` — dedupe + audit of what was emailed.
- `heartbeats` (exists) — start writing it.

## Build order
1. Tables `plaza_weather`, `weather_alerts` (migration).
2. `weather-pull` edge fn → verify `plaza_weather` populates with this week.
3. `v_camera_uptime_vs_weather` view.
4. `camera-watchdog` edge fn + secret.
5. RUT poller script — deploy to **south RUT now** (reachable), **north when powered**.
6. `weather-risk-eval` + email (SendGrid secret) + `weather_alerts` dedupe.
7. pg_cron schedules for all of the above.
8. Backfill `plaza_weather` actuals; smoke-test an email.

## Risk / reversibility
- All cloud pieces are standard (edge fns + pg_cron + tables) — same footprint as existing `plate_sessions_sweep` / `plate_pair_learn` crons.
- Only production-hardware touch is the RUT cron — **reversible** (remove the crontab line); installed per-RUT when reachable.
- Forecast drift → false alarms are bounded by the moderate threshold + dedupe; thresholds are config, easy to tune after a week of live data.

## Out of scope (v1)
- Predicting exact recovery time. Acting on alerts automatically (it only warns). SMS (email only for now). Multi-site (Charlotte only; design generalizes via `property_id`).
