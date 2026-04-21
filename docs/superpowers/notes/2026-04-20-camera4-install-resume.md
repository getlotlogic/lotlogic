# Camera 4 install — resume-point for tomorrow

**Paused:** 2026-04-20, end of day.
**Reason:** Camera is physically installed, cars are driving past it, but
zero HTTP POSTs are reaching `camera-snapshot`. Troubleshooting deferred
to tomorrow.

## State of play

### DB (done today)
- New `alpr_cameras` row inserted:
  - `name = 'Camera 4'`
  - `api_key = '1CC31660025C'` (the new camera's devMac)
  - `property_id = bd44ace8-feda-42e1-9866-5d60f65e1712` (Charlotte Travel Plaza)
  - `active = true`, `orientation = 'entry'`
  - Camera UUID: `033bfdf7-2a63-4171-bb08-620702d715c1`
- Old `Front Gate` row (`1CC31660025E`) left active, untouched. Gabe said "leave the old".

### Edge function state
- Deployed `camera-snapshot` is still v15 (orientation-aware). No new deploy
  since yesterday's USDOT work.
- Local repo is clean — the mid-edit orientation-stripping was reverted
  tonight so nothing accidentally gets deployed.
- The orientation-removal deliberation
  (`2026-04-20-orientation-removal-deliberation.md`) is still paused at the
  A/B/C/D decision. Don't touch it until the camera is actually connected.

### Network / logs observed
- Only a single GET to `/camera-snapshot/<secret>` in the last 2h window
  (Gabe eyeballing the URL). Zero POSTs from any camera. The old `…025E`
  camera last posted 2026-04-19 19:22 UTC.
- Gabe gave the installer this URL:
  `https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/camera-snapshot/e9d79affdfbacb8f04ed0e35ffd2f321`
  (URL shape is correct — secret matches `CAMERA_SNAPSHOT_URL_SECRET`.)
- **Cars are passing in front of the camera** — so the sensor trigger works,
  but the HTTP Upload action isn't firing.

## Tomorrow's first move

Redirect the camera temporarily to the diagnostic endpoint:

```
https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/camera-debug
```

No secret required — `camera-debug` accepts anything on any path, captures
whatever the camera sends, logs it structured, and stores the body to R2
at `parking-snapshots/camera-debug/<request_id>/...`.

Three diagnostic branches:

| Observation | Diagnosis | Fix |
|---|---|---|
| camera-debug logs show a POST arriving | Camera IS posting. Real endpoint config has a typo (most likely the secret). | Re-paste the exact `camera-snapshot/<secret>` URL and try again. |
| camera-debug logs show NOTHING | Camera isn't posting at all. | Check (1) 4G SIM has active data plan, (2) Settings → Event → HTTP Upload is enabled AND linked to the vehicle-detection trigger in Linkage/Action, (3) press Test in the HTTP Upload page. |
| camera-debug logs show a POST but shape differs from Milesight 4G JSON | Firmware changed the payload. | Read `camera-debug` log line, update `supabase/functions/camera-snapshot/extract.ts::extractMilesightPayload` to match, redeploy. |

## Reference: the Milesight 4G Traffic Sensing Camera payload shape

From `supabase/functions/camera-snapshot/extract.ts:80-94`:

```json
{
  "ts": 1776620819627,
  "topic": "4GSolarCam/Snapshot",
  "gps": { ... },
  "values": {
    "devName": "4G Traffic Sensing Camera",
    "devMac": "1CC31660025C",
    "file": "...jpg",
    "time": 1776620818,
    "dayNight": "day",
    "imageSize": 35596,
    "image": "data:image/jpeg;base64,/9j/4AAQ..."
  }
}
```

The devMac is the camera's api_key — it's how `camera-snapshot` looks up
the `alpr_cameras` row when the URL path doesn't include an explicit key.

## Do NOT touch until camera is connected

- Orientation-removal code changes (see the other pause note). The deployed
  function needs to keep working while we debug the camera. Changing code
  while debugging a camera = two variables at once.
- The `alpr_cameras` row for Camera 4. Leave it active.
- Any of the three pg_cron sweepers.
