# OpenALPR Sidecar

Free/local ALPR pre-filter in front of Plate Recognizer. Dramatically cuts PR
costs by handling the common case (clear plate, already-seen vehicle) locally.

## Flow

```
Camera POST → camera-snapshot edge function
                │
                ├─ 1. Time/hash dedup (existing) — skip PR, inherit
                │
                ├─ 2. OpenALPR sidecar (this service)
                │       │
                │       ├─ Plate returned + matches open session in DB
                │       │   → skip PR, inherit that session
                │       │
                │       └─ No plate / no match
                │           → fall through to step 3
                │
                └─ 3. Plate Recognizer API (paid) — ground truth
```

## Deploy to Railway

1. In Railway dashboard, create a new service pointing at
   `getlotlogic/lotlogic` repo, root directory `openalpr-sidecar/`.
2. Set env vars:
   - `SIDECAR_AUTH_TOKEN` — random string, shared secret with edge function.
   - `ALPR_COUNTRY` — `us` (default).
   - `ALPR_TOP_N` — `3` (default).
3. Deploy. Railway picks up `railway.toml` + `Dockerfile` automatically.
4. Copy the Railway public URL (e.g. `https://openalpr-sidecar.railway.app`).
5. Set it on the edge function:
   ```bash
   supabase secrets set OPENALPR_SIDECAR_URL=https://openalpr-sidecar.railway.app --project-ref nzdkoouoaedbbccraoti
   supabase secrets set OPENALPR_SIDECAR_TOKEN=<same as SIDECAR_AUTH_TOKEN>
   ```

## Local test

```bash
docker build -t openalpr-sidecar .
docker run --rm -p 8000:8000 -e SIDECAR_AUTH_TOKEN=test openalpr-sidecar

# Separate terminal:
curl -s http://localhost:8000/health
# {"ok":true,"alpr_binary_present":true}

IMG_B64=$(base64 -i some_plate.jpg)
curl -s -X POST http://localhost:8000/recognize \
  -H "Content-Type: application/json" \
  -d "{\"image_base64\":\"$IMG_B64\",\"auth_token\":\"test\"}"
# {"ok":true,"plates":[{"plate":"ABC1234","confidence":0.91},...],"processing_time_ms":180.3}
```

## Tuning

- `ALPR_TOP_N`: number of plate candidates returned per detected region.
- `ALPR_TIMEOUT_SEC`: max wall time for the `alpr` binary call (default 5s).

## Limitations

- Accuracy is lower than Plate Recognizer for dirty / angled / motion-blurred
  plates. The edge function treats empty or low-confidence sidecar results as
  a miss and falls through to PR.
- Cold start: ~2-3 seconds on first request after idle.
- Handles English-language plates out of the box via the `openalpr` apt
  package's `us` country pack. Other regions require additional training data.
