# USDOT OCR Fallback for Unplated Tractors

**Date:** 2026-04-20
**Owner:** Gabe
**Status:** Implementing
**Extends:** `2026-04-20-camera-session-state-machine-design.md`

## Why

Many tractor-trailers have no front plate (legal in NC and most US states — rear only). Our entry cameras see the front of vehicles, so these trucks enter invisibly: no `plate_events` row, no session, no enforcement. Carriers that never display a front plate park for free.

USDOT numbers, painted on the cab side panel, are a legally-mandated identifier (5–8 digits, FMCSA). Plate Recognizer's parent company (ParkPow) sells a dedicated **USDOT OCR** product that returns these numbers from vehicle imagery, same auth pattern as the Snapshot product we already use.

## Goals

1. When PR Snapshot returns zero plate results, fall through to USDOT OCR on the same image.
2. If USDOT OCR finds a DOT or MC number, synthesize a plate-shaped result with `plate=DOT-<n>` (or `MC-<n>`) and run the existing state machine unchanged.
3. If USDOT OCR also finds nothing, log and drop the frame (current behaviour).
4. Feature-flagged. No runtime change until `ENABLE_USDOT_FALLBACK=true` is set on Supabase.

## Non-goals

- Replacing the primary plate path. When PR returns plates, we use plates.
- Linking DOT numbers to FMCSA carrier records (future work; we just capture the number).
- Changing session / violation / billing logic for DOT-prefixed plates. They flow through identically.
- Per-property enable/disable. Feature flag is global.

## API integration

**Endpoint:** `POST https://usdot-api.parkpow.com/api/v1/predict/`
**Auth:** `Authorization: Token <TOKEN>` — **separate token** from `PLATE_RECOGNIZER_TOKEN`. Parkpow bills the USDOT product separately; expect an independent subscription + API key.
**Body:** `multipart/form-data` with `image` (≤3 MB JPEG) + optional `camera`.
**Rate limit:** 8 requests/sec cloud; we run nowhere near that.
**Response shape:**

```json
{
  "object": {
    "label": "usdot" | "vin" | "trailer" | ...,
    "score": 0.92,
    "value": { "xmin": 0.1, "ymin": 0.2, "xmax": 0.3, "ymax": 0.4 }
  },
  "texts": [
    { "value": "US DOT 1234567", "score": 0.89 },
    { "value": "MC 789012",       "score": 0.75 }
  ]
}
```

Extraction rules:
- Iterate `texts[]` in order.
- Regex `\b(?:U\.?\s?S\.?\s?D\.?O\.?T\.?|USDOT)\s*#?\s*(\d{5,8})\b` — first match wins.
- If no DOT match, try `\bMC\s*#?\s*(\d{5,8})\b`.
- If both fail, return `kind: "none"`.
- Only accept matches with `score >= USDOT_MIN_SCORE` (default `0.70`).

Synthetic plate text:
- DOT match → `DOT-1234567` (no leading zeros stripped; treat as opaque string).
- MC match → `MC-789012`.
- Normalized plate for session lookup: `DOT1234567` / `MC789012` (uppercase alphanumeric only, same `normalizePlate` helper).

## Environment

New Supabase secrets:
- `PARKPOW_USDOT_TOKEN` — the token obtained from the ParkPow USDOT OCR trial/subscription.
- `ENABLE_USDOT_FALLBACK` — `true` activates; any other value = off. Default off.
- `USDOT_MIN_SCORE` — optional float; default `0.70`.

No schema changes. `plate_sessions.plate_text` accepts arbitrary text; the `DOT-` / `MC-` prefixes slot in without migration.

## Business-logic impact

The DOT-prefixed plate flows through the state machine identically:

- Entry camera → `camera-snapshot` → PR returns zero plates → call USDOT OCR → get `DOT-1234567` → check allowlist (`resident_plates`, `visitor_passes`, `parking_registrations`) with `normalized_plate='DOT1234567'` — almost always `unmatched` since drivers register with their actual plate not their DOT → session state = `grace` → 15-min timer applies → cron sweeper fires tow-dispatch-email as usual.
- Exit camera → `camera-snapshot` sees same vehicle → USDOT OCR extracts the same DOT number → `findOpenSession` matches → session closes normally.
- Early exit from a registered session where the *pass* was registered against the real plate, but the *camera* only reads the DOT? Won't happen in practice — tractors arrive via QR-code registration using company name + DOT (the `visit.html` truck-plaza form has a `company_name` field) and would then use the real plate. If it does happen, treated as a stray exit.

**Partner email on a DOT-based violation:**
The tow-dispatch email shows `Plate: DOT-1234567` in the header. Less actionable than a real plate for field identification, but still identifies the carrier. Partner can decode the DOT number via FMCSA's public lookup (`safer.fmcsa.dot.gov`) to find the carrier name.

## Cost

- Trial + free tier likely covers the first weeks of traffic.
- Subscription: ParkPow doesn't publish public per-request pricing; expect email-inquiry quote. Order of magnitude: competitors charge ~$0.001–0.005/request. At 200 unplated tractors/day × 2 calls each (entry + exit) × 30 days = 12,000 calls/mo. Even at $0.01/call = $120/mo.
- Only fires on frames where PR returned no plates, so cost scales with unplated-tractor rate, not total traffic.

## Rollout

1. Land this spec; sign up for ParkPow USDOT OCR trial at `https://platerecognizer.com/usdot-ocr/`; get `PARKPOW_USDOT_TOKEN`.
2. Implement the helper and the fallback branch behind `ENABLE_USDOT_FALLBACK=false`.
3. Deploy. Verify existing plate traffic is unaffected via real-camera smoke.
4. Set `PARKPOW_USDOT_TOKEN` on Supabase.
5. Flip `ENABLE_USDOT_FALLBACK=true`. Observe next unplated tractor in logs; confirm `DOT-xxxxxxx` in `plate_events.plate_text`.
6. Monitor cost + accuracy for one week. Tighten regex / score threshold if false positives appear.
7. Update CLAUDE.md.

## Rollback

- Set `ENABLE_USDOT_FALLBACK=false` on Supabase; redeploy. Instant revert to plate-only behaviour.
- No schema changes to reverse.
- DOT-prefixed sessions already closed remain in the DB with the synthetic plate; they're just data.

## Open questions

- **Is the USDOT OCR token the same as `PLATE_RECOGNIZER_TOKEN`?** Probably not — Parkpow bills the product separately. Test with a probe call; if 401, confirm separate token required.
- **Does the `object.label` field differentiate DOT from VIN from trailer-number?** Spec says yes but the returned label values aren't documented publicly. Handle the JSON defensively; don't branch on `label`, just greedily regex the `texts[]`.
- **Edge case: a truck with BOTH front plate AND DOT visible.** PR Snapshot returns the plate (normal path); USDOT OCR never fires. Correct — we want the real plate.
