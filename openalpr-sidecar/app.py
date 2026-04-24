"""OpenALPR sidecar for cost-efficient ALPR.

Runs on Railway. Accepts a base64-encoded JPEG via POST /recognize, returns
the top plate candidates. Invoked by the camera-snapshot edge function
BEFORE the Plate Recognizer API call — if OpenALPR returns a plate we
already have an open session for, we skip PR entirely. Only when OpenALPR
returns empty or no-match do we fall through to PR for a "pro" read.

Binary call: `alpr -j -c us -n 3 <image_path>` → JSON with top-3 candidates
per detected plate region. We pass a temp file path because the CLI wants
a filesystem handle.
"""

import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

APP_AUTH_TOKEN = os.environ.get("SIDECAR_AUTH_TOKEN", "")
ALPR_COUNTRY = os.environ.get("ALPR_COUNTRY", "us")
ALPR_TOP_N = int(os.environ.get("ALPR_TOP_N", "3"))
ALPR_TIMEOUT_SEC = float(os.environ.get("ALPR_TIMEOUT_SEC", "5.0"))

app = FastAPI(
    title="LotLogic OpenALPR sidecar",
    description="Free/local ALPR pre-filter in front of Plate Recognizer.",
    version="1.0.0",
)


class RecognizeRequest(BaseModel):
    image_base64: str = Field(
        ...,
        description="Base64-encoded JPEG bytes (data: URI prefix optional).",
    )
    auth_token: Optional[str] = Field(
        None,
        description="Shared secret. Must match SIDECAR_AUTH_TOKEN env var.",
    )


class PlateCandidate(BaseModel):
    plate: str
    confidence: float  # 0.0 - 1.0


class RecognizeResponse(BaseModel):
    ok: bool
    plates: List[PlateCandidate]
    processing_time_ms: float
    reason: Optional[str] = None


@app.get("/health")
def health() -> dict:
    alpr_ok = shutil.which("alpr") is not None
    return {"ok": True, "alpr_binary_present": alpr_ok}


@app.post("/recognize", response_model=RecognizeResponse)
def recognize(req: RecognizeRequest) -> RecognizeResponse:
    if APP_AUTH_TOKEN and req.auth_token != APP_AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")

    started = time.monotonic()

    raw = req.image_base64
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[1] if "," in raw else raw

    try:
        image_bytes = base64.b64decode(raw, validate=True)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad base64: {err}")

    if not image_bytes:
        raise HTTPException(status_code=400, detail="empty image")

    # OpenALPR CLI wants a file path. Temp file cleaned up in finally.
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            suffix=".jpg", delete=False, dir="/tmp"
        ) as fh:
            fh.write(image_bytes)
            tmp_path = fh.name

        try:
            proc = subprocess.run(
                [
                    "alpr",
                    "-c", ALPR_COUNTRY,
                    "-j",
                    "-n", str(ALPR_TOP_N),
                    tmp_path,
                ],
                capture_output=True,
                text=True,
                timeout=ALPR_TIMEOUT_SEC,
            )
        except subprocess.TimeoutExpired:
            return RecognizeResponse(
                ok=False,
                plates=[],
                processing_time_ms=(time.monotonic() - started) * 1000,
                reason="alpr_timeout",
            )

        if proc.returncode != 0:
            return RecognizeResponse(
                ok=False,
                plates=[],
                processing_time_ms=(time.monotonic() - started) * 1000,
                reason=f"alpr_exit_{proc.returncode}: {proc.stderr[:200]}",
            )

        try:
            parsed = json.loads(proc.stdout or "{}")
        except json.JSONDecodeError as err:
            return RecognizeResponse(
                ok=False,
                plates=[],
                processing_time_ms=(time.monotonic() - started) * 1000,
                reason=f"alpr_json_parse: {err}",
            )

        # OpenALPR CLI JSON shape: {"results": [{"plate": "...", "confidence": N,
        # "candidates": [{"plate": "...", "confidence": N}, ...]}]}
        candidates: List[PlateCandidate] = []
        for det in parsed.get("results", []):
            for cand in det.get("candidates", [])[: ALPR_TOP_N]:
                plate = str(cand.get("plate") or "").upper().strip()
                conf = float(cand.get("confidence") or 0) / 100.0
                if plate:
                    candidates.append(PlateCandidate(plate=plate, confidence=conf))

        return RecognizeResponse(
            ok=True,
            plates=candidates,
            processing_time_ms=(time.monotonic() - started) * 1000,
        )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
