# Milesight SC211 → Plate Recognizer → LotLogic Ingest (Redesign)

**Date:** 2026-04-19
**Owner:** Gabe
**Status:** Draft — pending user review
**Replaces:** `alpr-snapshot`, `alpr-pr-webhook`, `alpr-pr-webhooks`, `pr-proxy`, `alpr-webhook` (all gutted 2026-04-19)

## Why this exists

The previous attempt put a LotLogic edge function in front of Plate Recognizer (camera → us → PR → us). That added two failure points (camera-format translation, internal fan-out) and produced months of debugging artifacts (#416–#443) before we discovered the camera was never hitting our wrapper at all (#434). This redesign removes the wrapper. The camera talks straight to Plate Recognizer, and we only own the inbound webhook from PR.

## Goals

1. SC211 captures a snapshot when it sees a vehicle.
2. Plate Recognizer OCRs the plate.
3. We receive every plate event with its image and write it to `plate_events`.
4. Unmatched plates create an `alpr_violations` row eligible for enforcement.
5. End-to-end pipeline can be smoke-tested from the PR dashboard alone.

Explicit non-goals (deferred):

- Tow-confirm fan-out and partner SMS/email dispatch. The `tow-confirm`, `tow-dispatch-email`, `tow-dispatch-sms` edge functions stay deployed but get no traffic from the new ingest. Wiring them back in is a separate redesign.
- Daily reporting (`alpr-daily-report` was deleted; rebuild later if wanted).
- A web/dashboard UI for camera registration. Cameras are seeded via SQL for now.

## Architecture

```
SC211 (motion + ANPR trigger, camera-side)
   │ HTTPS POST  multipart  (image, camera_id, api_token)
   ▼
api.platerecognizer.com/v1/plate-reader/        ← PR-hosted; we don't deploy anything here
   │ HTTPS POST  multipart  (json, upload=jpeg)
   ▼
Supabase Edge Fn:  pr-ingest/<URL_SECRET>        ← the only new code
   ├─► R2 parking-snapshots/{property}/{date}/{cam}-{ts}-{plate}.jpg
   ├─► plate_events  INSERT  (image_url, raw_data, match_status, …)
   └─► allowlist match → if miss → alpr_violations  INSERT
```

Three boundaries (camera → PR, PR → us, us → DB+R2). One edge function on our side. No proxy. No re-OCR. No fan-out.

## Components

### New

| Component | Path | Purpose |
|---|---|---|
| `pr-ingest` edge function | `supabase/functions/pr-ingest/index.ts` | Single endpoint that validates the URL secret, parses PR's multipart payload, writes the image to R2, inserts `plate_events`, runs allowlist match, inserts `alpr_violations` on miss. |

### Reused (no changes required)

| Component | Notes |
|---|---|
| `alpr_cameras` table | Existing schema. The free-text identifier PR echoes back lives in `api_key` (text, NOT NULL). One row per physical camera. |
| `plate_events` table | Existing columns cover everything: `image_url`, `raw_data` jsonb, `match_status`, `match_reason`, `matched_at`, `visitor_pass_id`, `resident_plate_id`, `normalized_plate`. |
| `alpr_violations` table | Full enforcement-state schema preserved (`status`, `action_taken`, `dispatched_at`, `tow_confirmed_at`, `force_bill_at`, …). |
| `resident_plates`, `visitor_passes`, `parking_registrations` | Allowlist sources for the match step. |
| R2 bucket `parking-snapshots` | After this redesign ships, **delete the `wipe-all` lifecycle rule** that's currently draining the bucket. Bucket stays public-read. |

### Touched but not redesigned

- `tow-confirm` and the `tow-dispatch-*` functions stay deployed but receive no traffic until rewired by a future spec.

## Data flow (happy path)

1. SC211 detects vehicle (camera-side motion + ANPR config) → captures JPEG → POSTs to PR with the API token and the camera's `camera_id` text (e.g. `"trillium-front-gate"`).
2. PR runs OCR.
3. PR fires its configured webhook to `https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/pr-ingest/<URL_SECRET>`, mode = **Webhook with Image** (`Content-Type: multipart/form-data`).
4. `pr-ingest` extracts the trailing path segment, compares to `PR_INGEST_URL_SECRET` env. Mismatch → `401`. Match → continue, and **always return `200`** for any failure that isn't a DB write error (see Error rules).
5. Parse multipart: `json` field (URL-encoded JSON) + `upload` (binary JPEG).
6. From the JSON, read `data.camera_id` (string). Look up `alpr_cameras` by `api_key = data.camera_id` AND `active = true`. Unknown → log structured warning and `200`.
7. Iterate `data.results[]`. Drop entries where `score < PR_MIN_SCORE` (env, default `0.80`).
8. For each surviving result:
    - Upload `upload` bytes to R2 at `{property_id}/{YYYY-MM-DD}/{camera_id_text}-{epoch_ms}-{plate}.jpg`. Public URL = `https://pub-<bucket-hash>.r2.dev/<key>` (the default r2.dev URL — pretty domain deferred).
    - INSERT `plate_events`:
        - `camera_id` = the looked-up uuid
        - `property_id` = camera's property
        - `plate_text` = result.plate (uppercased)
        - `normalized_plate` = result.plate stripped of non-alphanumerics, uppercased
        - `confidence` = result.score
        - `image_url` = R2 URL (or NULL if upload failed — see error rules)
        - `event_type` = `"alpr"`
        - `raw_data` = the full PR `data` object as jsonb
        - `match_status` = filled in next step
9. Dedup check: count `plate_events` where `(property_id, normalized_plate, created_at >= now() - PR_DEDUP_WINDOW_SECONDS)`. If > 1, set `match_status = 'dedup_suppressed'`, `match_reason = 'within window'`, **skip violation insert**, done.
10. Allowlist match (in this order). All comparisons normalize both sides on the fly: `regexp_replace(upper(<col>), '[^A-Z0-9]', '', 'g') = <normalized_plate>`.
    - `resident_plates`: same `property_id` + normalized plate match against `plate_text` + `active = true`. Hit → `match_status='resident'`, fill `resident_plate_id`.
    - `visitor_passes`: same `property_id` + normalized plate match against `plate_text` + `now()` between `valid_from` and `valid_until` + `cancelled_at IS NULL`. Hit → `match_status='visitor_pass'`, fill `visitor_pass_id`.
    - `parking_registrations`: same `property_id` (alpr_cameras has no `lot_id`, so we scope by property) + normalized plate match against `plate_number` + `now() < expires_at` + `status = 'active'`. Hit → `match_status='self_registered'`.
    - No hit → `match_status='unmatched'`. INSERT `alpr_violations` row with `status='pending'`, `violation_type='alpr_unmatched'`, `plate_event_id=…`, `plate_text=…`. **Do NOT fire tow-confirm or dispatch.** This redesign ends here.
11. Return `200 OK` with `{"ok": true, "events": <count>, "violations": <count>}`.

## Schema changes

**None.** All required columns already exist on `plate_events`, `alpr_cameras`, `alpr_violations`. If we discover during implementation that a column is missing, that's a separate migration in `migrations/` — not part of this spec.

## Configuration

### Camera (Milesight SC211 web UI)

1. Network → 4G SIM provisioned, internet reachable.
2. Settings → Event → Vehicle Detection → enable ANPR + motion trigger.
3. Settings → Event → Notification → HTTP. Set:
    - **URL**: `https://api.platerecognizer.com/v1/plate-reader/`
    - **Method**: POST, multipart
    - **Token field**: `Authorization: Token <PR_API_TOKEN>`
    - **camera_id field**: free-text matching the `api_key` column on the `alpr_cameras` row we created for this device (e.g. `trillium-front-gate`)
    - **Trigger**: on Vehicle Detection event (NOT continuous)

### Plate Recognizer dashboard

1. Webhooks settings page → Create webhook.
2. **Target URL**: `https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/pr-ingest/<URL_SECRET>`
3. **Mode**: **Webhook with Image** (multipart, includes JPEG bytes).
4. **Events**: `image.done`.
5. (Optional) MMC = on if we want make/model/color in `raw_data`.

### Supabase

- Edge function `pr-ingest` deployed with `verify_jwt = false` (PR can't attach our JWT).
- Secrets:
    - `PR_INGEST_URL_SECRET` — random 32+ char hex; the trailing path segment compared by step 4
    - `PR_MIN_SCORE` — default `0.80`
    - `PR_DEDUP_WINDOW_SECONDS` — **default `0` (off) for testing**, flip to `300` after smoke tests confirm the pipeline
    - `R2_ACCOUNT_ID`, `R2_BUCKET_NAME` (= `parking-snapshots`), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — for the S3-compatible upload
    - `R2_PUBLIC_BASE_URL` — the `https://pub-<hash>.r2.dev` value
- Reuses existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

### R2

- After this ships, **delete the `wipe-all` lifecycle rule** on `parking-snapshots` (`wrangler r2 bucket lifecycle remove parking-snapshots wipe-all`). Retention = forever (per Q3 of brainstorm).
- Bucket stays public-read so r2.dev URLs work in the dashboard's evidence cards without signing.

### Camera registration (one-time, per device)

Insert into `alpr_cameras` via SQL:

```sql
INSERT INTO alpr_cameras (id, property_id, name, api_key, active)
VALUES (gen_random_uuid(), '<property uuid>', 'Front Gate', 'trillium-front-gate', true);
```

The `api_key` value is what the operator types into the SC211's `camera_id` field.

## Error handling rules

| Failure | Response | Why |
|---|---|---|
| URL secret mismatch | `401` | Only legit hard-reject. PR retries on 5xx, gives up on 4xx — exactly what we want. |
| Multipart parse error | `200` + structured log | PR retries malformed payloads aggressively; 200 prevents the retire-the-webhook escalation. |
| Unknown `camera_id` | `200` + log + counter | Install typo. Don't punish PR; surface in monitoring instead. |
| `score < PR_MIN_SCORE` for all results | `200` + log | Normal case, not a failure. |
| R2 upload fails | `200`, write `plate_events` row with `image_url = NULL`, set `raw_data.image_upload_error = '...'` | OCR data > image. Never lose a plate event over a storage hiccup. The bytes are dropped — PR doesn't host them and we don't buffer; structured logs + counters give us the failure-rate signal. |
| DB insert fails | `500` | The only case where we WANT PR to retry. |
| Any uncaught exception | `200` + structured log | Same reasoning as multipart parse. Visibility via logs, not via PR retiring our endpoint. |

**The rule:** anything that can't be fixed by retrying gets a `200` and a log entry. PR auto-removing our webhook is the worst possible failure mode and the one we optimize against.

## Testing

### Unit (deno test)

`supabase/functions/pr-ingest/index.test.ts`:

- Synthetic multipart with a real PR sample payload + 1 KB fake JPEG.
- Cases:
    - Happy path → expects R2 PutObject mock + `plate_events` row + `alpr_violations` row when no allowlist match.
    - Resident match → no violation insert, `match_status = 'resident'`.
    - Visitor pass match → no violation insert, `match_status = 'visitor_pass'`.
    - Score below threshold → no inserts, 200.
    - Unknown camera_id → no inserts, 200, structured log.
    - Bad URL secret → 401, no inserts.
    - DB insert fails → 500.
    - R2 upload fails → 200, `plate_events` row exists with `image_url = NULL`.
    - Dedup window honored when `PR_DEDUP_WINDOW_SECONDS > 0`.

### Smoke (post-deploy)

1. PR dashboard → webhook → "Send test event". Expect a `plate_events` row with the test plate, an R2 image, and either an `alpr_violations` row or a `match_status='resident|visitor_pass'`.

### End-to-end (real camera)

1. Insert `alpr_cameras` row.
2. Configure SC211 (camera config above).
3. Configure PR webhook (PR config above).
4. Drive a vehicle past.
5. Verify in DB: one `plate_events` row, image visible at the R2 URL, one `alpr_violations` row (assuming the plate isn't on an allowlist).
6. Verify dashboard's evidence card renders the image (existing UI; no changes here).

## Rollout plan

1. Land this spec; user reviews; approve.
2. Implement `pr-ingest` edge function + tests.
3. Get R2 access keys (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) — currently missing per `.env.local`.
4. Set Supabase secrets.
5. Deploy with `verify_jwt = false`.
6. Remove R2 `wipe-all` lifecycle rule.
7. Configure PR webhook in PR dashboard.
8. Smoke-test from PR dashboard.
9. Configure one real SC211, drive a car past, validate end-to-end.
10. Flip `PR_DEDUP_WINDOW_SECONDS` from `0` to `300` once validated.
11. Update `CLAUDE.md`'s "Camera-based ALPR" section from "GUTTED, redesign in progress" to a one-paragraph summary of the new flow plus a pointer to this spec.

## Open questions / future work

- **Tow-confirm rewiring.** `tow-confirm` previously fired from `alpr-webhook` after each `plate_events` insert. The new ingest does NOT fire it. Re-enabling tow-confirm and the partner dispatch fan-out is a separate redesign.
- **Pretty image URLs.** Default to r2.dev. Custom `snapshots.lotlogic.com` is a 5-minute Cloudflare config when we want it.
- **Dashboard UI for camera registration.** SQL-only for now. A small UI for `alpr_cameras` CRUD is cheap to add later.
- **Per-camera webhook secrets.** Single shared `PR_INGEST_URL_SECRET` for now (user explicitly said not worried about security). Per-camera is straightforward to layer on later if needed.
- **Backfill on R2 failures.** Currently dropped — we don't buffer the bytes. If we start seeing frequent `image_url = NULL` rows we can either (a) buffer the multipart `upload` to a temp store before R2 PutObject and add a retry worker, or (b) lean on PR's own retry of the original webhook. Skip until failure rates show this is needed.
