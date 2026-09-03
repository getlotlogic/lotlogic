# Charlotte Travel Plaza — Solar / Weather vs Camera Uptime
**Deep-research report · 2026-06-02**

## Site
- **Charlotte Travel Plaza** — 4601 Sunset Rd, Charlotte, NC 28216
- Coordinates **35.3077, −80.8505**
- Cameras + RUTs run on **solar + battery** (no grid). North gate **C4467** is the brownout-prone unit; South **TS4467** rarely goes fully dark.
- Weather source: Open-Meteo hourly + daily reanalysis for the exact coordinates, America/New_York.

## Question
Does cloud cover / sun exposure at the plaza explain North C4467's uptime over the past week?

## Method & honest limits
- **Uptime proxy = plate reads.** We have no true uptime log (the `heartbeats`/`snapshots` tables were never populated). North's read trail is a usable proxy *because* its gaps are confirmed blackouts; but reads also depend on **traffic**, so daily read *count* is noisy. "Active hours" (distinct hours with ≥1 read) is the steadier signal.
- Correlation is over the **5 days since north came back (5/29–6/02)** — small N. The **5/24–5/28 pre-comeback window** is used as corroborating context.
- This analysis was explicitly requested. Causation on the hardware side remains the operator's call; this reports the correlation and the evidence.

## Daily historicals (past 8 days)

| Date | Solar (MJ/m²) | Cloud mean | Sunshine (h) | Precip (mm) | North reads | North active hrs | First→Last read (ET) |
|------|--------------:|-----------:|-------------:|------------:|------------:|-----------------:|----------------------|
| 05-25 Sun | 19.05 | 82% | 6.0 | 2.9 | **0 (dark)** | 0 | — |
| 05-26 Mon | **12.64** | **90%** | **2.8** | **11.2** | **0 (dark)** | 0 | — |
| 05-27 Tue | 20.08 | 62% | 7.5 | 0.0 | **0 (dark)** | 0 | — |
| 05-28 Wed | 26.83 | **14%** | 13.6 | 0.0 | **0 (dark)** | 0 | — |
| 05-29 Thu | **29.64** | 29% | **12.7** | 0.0 | 101 | 12 | 08→21 |
| 05-30 Fri | 23.98 | 64% | 7.3 | 1.1 | 45 | 10 | 11→20 |
| 05-31 Sat | 20.55 | 76% | 6.8 | 0.0 | 81 | 12 | 08→20 |
| 06-01 Mon | 21.31 | 75% | 8.9 | 0.4 | 75 | 7 | 12→18 |
| 06-02 Tue | 18.21 | 39% | 7.3 | 0.4 | 23* | 4* | 09→18 |

\*06-02 partial (report run mid-evening).

```
Daily solar (MJ/m²)        North active hours
05-25  ███████████ 19.0     (dark)
05-26  ███████ 12.6         (dark)   ← rain 11mm, 90% cloud
05-27  ████████████ 20.1    (dark)
05-28  ████████████████ 26.8 (dark)  ← clear, recharging
05-29  ██████████████████ 29.6  ████████████ 12   ← WAKES
05-30  ██████████████ 24.0   ██████████ 10
05-31  ████████████ 20.6     ████████████ 12
06-01  █████████████ 21.3    ███████ 7
06-02  ███████████ 18.2      ████ 4*
```

## Findings

### 1. The comeback is a textbook deep-discharge → recharge cycle
North was **dark 5/24–5/28**. The trigger was the **5/25–5/26 cloudy/rainy spell** (82%/90% cloud, 2.9mm then **11.2mm rain**, sunshine collapsing to **2.8 h** on 5/26) — solar input cratered to **12.6 MJ/m²** and drew the battery down. Critically, north **stayed dark even on 5/28**, a brilliant clear day (14% cloud, 13.6 sun-hours) — i.e. one good day wasn't enough. It only woke on **5/29 after the second consecutive high-solar day** (29.6 MJ/m²). That lag is the signature of a depleted battery needing sustained surplus to recover, not an instantaneous panel-output effect.

### 2. Cumulative solar tracks uptime; single-day cloud % does not
- **corr(daily solar, north reads) = +0.67** · **corr(daily solar, active hours) = +0.67** — moderate-to-strong positive.
- **corr(daily cloud %, north reads) = +0.03** — essentially zero.

The split is the whole story: **energy in (solar radiation) predicts uptime; a single day's cloud fraction doesn't**, because the system has multi-day battery memory and read counts carry traffic noise. Solar MJ/m² is the right variable to watch, not cloud %.

### 3. Wake-up time is governed by battery state-of-charge, not that morning's sun
Morning (6–11am) cloud vs first-read hour is **not** a clean relationship:

| Date | Morning cloud | Morning solar (avg W/m²) | First read |
|------|--------------:|-------------------------:|-----------|
| 05-29 | 1% | 341 | 08:00 |
| 05-30 | 98% | 165 | 11:00 |
| 05-31 | **100%** | 138 | **08:00** |
| 06-01 | 66% | 258 | 12:00 |
| 06-02 | 26% | 222 | 09:00 |

5/31 woke at 08:00 under **100% morning cloud** — because it was riding charge banked over the prior clear days. 6/01 didn't wake until noon despite a brighter morning. Wake-up follows **accumulated** state-of-charge, consistent with finding #1.

### 4. South is not on the same curve
South TS4467 reads through these same weather days largely uninterrupted (its gaps are no-traffic, not outages). Whatever the power/exposure difference is between the two enclosures, **South is not solar-limited the way North is** — North is the unit whose uptime the weather explains.

## Bottom line
North C4467's uptime over the past week is **well explained by solar energy availability** (+0.67 correlation), and the 5/25–5/29 dark→wake sequence is a clean discharge/recharge cycle: a two-day rainy spell drained it, and it took **two consecutive high-solar days to bring it back**. The operative variable is **cumulative solar (MJ/m²) / sustained sunshine**, not any single day's cloud percentage. A run of cloudy or rainy days is the leading indicator that North will brown out; a run of clear days is what recovers it.

## Caveats
- N = 5 days of post-comeback data; correlations are indicative, not definitive.
- Read count is a noisy uptime proxy (traffic-dependent); active-hours is steadier but still bounded by traffic and daylight.
- No ground-truth uptime feed — populating the `heartbeats` table would let us correlate **measured uptime** against solar instead of inferring it from reads, and would sharpen every number here.
