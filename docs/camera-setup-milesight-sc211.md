# Milesight SC211 Provisioning — Plate Recognizer → LotLogic

End-to-end runbook for wiring a Milesight SC211 LPR camera into the LotLogic
ALPR pass / violation pipeline via the Plate Recognizer (PR) cloud.

```
Milesight SC211 camera
  -> api.platerecognizer.com/v1/plate-reader/   (PR runs OCR)
  -> PR webhook "image.done"
  -> alpr-pr-webhook edge fn                     (translates PR payload)
  -> alpr-webhook edge fn                        (unchanged)
  -> plate_events + resident/visitor match + violations pipeline
```

The `alpr-pr-webhook` function is a thin bridge. It never 4xx's — every
failure returns 200 with a `status` field so PR doesn't auto-disable the
hook. Real errors land in `supabase functions logs alpr-pr-webhook`.

---

## 1. Prerequisites

- **Camera firmware** ≥ 21.1.0.8 (older firmware doesn't expose the
  HTTP Notification → Customize target we need, and Object Analytics plate
  trigger is broken on earlier builds).
- **Connectivity**: wired Ethernet is easiest. For trailers / cellular-only
  sites a Verizon, AT&T, or T-Mobile SIM in the SC211's slot works — confirm
  the camera pulls an IP and can reach `api.platerecognizer.com:443`.
- **Plate Recognizer account** on the Snapshot Cloud plan with a valid API
  token (dashboard → API tokens).
- **LotLogic access**: you need to be able to INSERT into `alpr_cameras` on
  the prod Supabase project (`nzdkoouoaedbbccraoti`) and you need the
  `property_id` of the property this camera belongs to.

---

## 2. Provision a new camera

### 2a. Create the `alpr_cameras` row

The `api_key` you pick here is what the camera reports back to PR, and what
PR echoes to us as `camera_id` in the webhook payload. We look up the camera
by that value — it has to be unique and it has to match exactly in three
places (DB row, Milesight config, PR webhook payload).

```sql
-- Recommended: use a UUID so you can't accidentally leak or guess it.
-- Document the generated value — you'll paste it into the Milesight UI in
-- step 2b and you'll need it again if you ever re-onboard this camera.
INSERT INTO alpr_cameras (property_id, name, api_key, active)
VALUES (
  '<property_uuid>',                 -- the property this camera watches
  'Milesight SC211 — <location>',    -- human-readable, shows up in ops UI
  gen_random_uuid()::text,           -- becomes the Camera_ID on the camera
  true
)
RETURNING id, api_key;
```

Copy the returned `api_key`. You'll paste it into the camera in the next
step and into the PR dashboard.

### 2b. Milesight SC211 web UI

1. Log into the camera's web UI and go to
   **Settings → Event → Object Analytics**.
2. Enable **License Plate Recognition**. Draw the detection region over the
   drive lane / entrance you want to monitor. The SC211 needs a reasonably
   head-on view of the plate for OCR to work — aim for ≤ 30° off-axis and
   12–40 ft range (per Milesight's SC211 deployment guide).
3. Under **Settings → Event → HTTP Notification** (or **Event Linkage →
   HTTP Push** depending on firmware), add a Customize push target:

   | Field | Value |
   | --- | --- |
   | URL | `https://api.platerecognizer.com/v1/plate-reader/` |
   | Method | `POST` |
   | Auth header / Custom header | `Authorization: Token <plate_recognizer_api_token>` |
   | Form field `regions` | `us-nc` (matches our `PLATE_RECOGNIZER_REGIONS` default — override per-site if needed) |
   | Form field `camera_id` | **paste the `api_key` returned from step 2a, exactly** |
   | Form field `mmc` | `true` (optional — lets PR populate make/model/color) |
   | Post Capture / Include image | **ON** — sends the snapshot as `upload` form field |
   | Event trigger | License Plate Recognition (from Object Analytics) |

4. Save, then use the camera's **Test** button. You should see a 200 from PR
   in the camera's Event Log. If you see a 401, the token header is wrong;
   if you see a 400, the `regions` code isn't recognized.

### 2c. Plate Recognizer dashboard

1. Go to the PR dashboard → **Webhooks** → **Add webhook**.
2. Target URL: `https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/alpr-pr-webhook`
3. Mode: **Webhook with Image** (we want the snapshot attached so it can
   land on a violation email). Use "Data Only" if you don't need the image —
   e.g. for cellular-bandwidth-constrained deployments.
4. Event filter: only fire on `image.done` with at least one plate detected
   (PR offers a "plate detected" toggle on the webhook). We tolerate empty
   webhooks and 200 them, but filtering at PR saves invocations on our side.
5. Save, then hit **Send test event** — the test is a no-op plate so you'll
   get `{"status":"no_plate_detected"}` back, which is the expected success
   signal. A real drive-by should produce `{"status":"accepted",...}`.

### 2d. End-to-end verification

1. Drive a test plate past the camera (or, if you don't have a vehicle
   handy, download a clear plate photo and post it manually to PR with
   `camera_id = <your api_key>`; PR will then deliver the webhook just like
   the camera would).
2. In Supabase SQL Editor:
   ```sql
   SELECT plate_text, confidence, image_url, event_type, created_at
   FROM plate_events
   WHERE camera_id = (SELECT id FROM alpr_cameras WHERE api_key = '<your_api_key>')
   ORDER BY created_at DESC LIMIT 5;
   ```
   You should see a row for the test plate with `confidence` ≥ 0.80 and
   (in Webhook with Image mode) a populated `image_url` pointing at the
   `plate-snapshots` bucket.
3. Confirm `alpr_cameras.last_seen_at` ticked to ~now():
   ```sql
   SELECT name, last_seen_at FROM alpr_cameras WHERE api_key = '<your_api_key>';
   ```
4. Drive the same plate past again within 5 minutes — `alpr-webhook` should
   dedup it; you should see `{"status":"duplicate_skipped"}` in the
   alpr-webhook logs and no new `plate_events` row. This confirms the
   downstream chain is wired correctly.

---

## 3. Troubleshooting

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Camera online but nothing reaches PR | Firmware too old OR Object Analytics rule disabled OR outbound 443 blocked | Firmware version in **Settings → System → About**; Object Analytics toggle; camera's Event Log |
| PR receives images but no webhook fires for us | PR webhook disabled by PR (consistent errors drove the auto-disable), or dashboard filters excluding the event | PR dashboard → Webhooks → recent deliveries. Re-enable and re-test. |
| We receive the webhook but no `plate_events` row is created | `camera_id` in PR payload doesn't match `alpr_cameras.api_key` | `supabase functions logs alpr-pr-webhook` — look for `{"status":"camera_not_provisioned"}` entries. Compare the `camera_id` value to what's in the DB. |
| Webhook arrives but `status = skipped_low_confidence` | Plate OCR below 0.80 — camera angle, distance, or lighting | Lower `PR_WEBHOOK_MIN_SCORE` temporarily to see the raw score, then fix the camera placement rather than the threshold. |
| `plate_events` row created but no violation / no pass match | Downstream of this bridge — look at `alpr-webhook` logs | `supabase functions logs alpr-webhook` — dedup window, resident/visitor match, grace period, suspension gates |
| Camera showed up once, now silent | Cellular SIM expired, OR PoE switch rebooted, OR PR webhook got auto-disabled | `SELECT last_seen_at FROM alpr_cameras WHERE ...` — if stale, start at the camera. If fresh but no `plate_events`, start at PR. |

Edge function logs (both this bridge and its downstream) live in Supabase,
not Railway:

```bash
supabase functions logs alpr-pr-webhook --project-ref nzdkoouoaedbbccraoti
supabase functions logs alpr-webhook   --project-ref nzdkoouoaedbbccraoti
```

---

## 4. Smoke test

A paste-ready `curl` that simulates the Plate Recognizer "Data Only" payload
format. Swap `<your_api_key>` for a real provisioned `alpr_cameras.api_key`
and it should return `{"status":"accepted",...}`.

```bash
curl -i -X POST \
  https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/alpr-pr-webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "hook": {
      "target_url": "https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/alpr-pr-webhook",
      "id": "test-hook",
      "event": "image.done"
    },
    "data": {
      "filename": "test.jpg",
      "timestamp": "2026-04-17T12:00:00Z",
      "camera_id": "<your_api_key>",
      "results": [
        {
          "plate": "TEST123",
          "score": 0.92,
          "dscore": 0.99,
          "box": {"xmin": 100, "ymin": 100, "xmax": 300, "ymax": 200},
          "region": {"code": "us-nc", "score": 0.88},
          "vehicle": {"type": "Sedan", "score": 0.81},
          "candidates": []
        }
      ],
      "usage": {"calls": 1, "max_calls": 2500},
      "processing_time": 288.758
    }
  }'
```

Send an unprovisioned `camera_id` — expect `{"status":"camera_not_provisioned"}`
and a 200 (never 4xx, so PR doesn't disable the webhook).

Send no `results[]` — expect `{"status":"no_plate_detected"}` and a 200.

---

## 5. Alternative path: cameras that do on-device OCR

If you ever deploy a camera that runs LPR on the edge and doesn't need
Plate Recognizer cloud OCR (e.g. a Hikvision DeepinView or an RTSP gateway
doing its own plate extraction), point it straight at the backend instead:

- **Target**: `POST https://lotlogic-backend-production.up.railway.app/alpr/ingest`
- **Auth**: `X-Camera-Key: <alpr_cameras.api_key>` header
- Same `alpr_cameras` row, same downstream pipeline, no PR round-trip, no
  per-frame PR bill. See `routers/alpr.py` in `lotlogic-backend`.

Use this path only when the camera's on-device OCR is trustworthy enough
that we don't need PR's second opinion. For most deployments (including
every Milesight SC211 to date) the PR cloud path in §2 is the right default.
