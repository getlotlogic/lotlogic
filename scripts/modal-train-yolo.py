"""Modal-based YOLO retraining pipeline for the Charlotte plate detector.

End-to-end flow this enables:

  Operator labels frames in dashboard
       ↓
  Edge function fires `kick_off_training` web endpoint
       ↓
  Modal pulls dataset from Supabase + R2, trains YOLOv9t on T4 GPU,
  exports ONNX, uploads to R2, fires webhook back to Supabase
       ↓
  GitHub Action commits ONNX to openalpr-sidecar/models/
       ↓
  Railway auto-deploys sidecar with new model

Setup (one time):

  pip install modal
  modal token new                          # browser auth
  modal secret create lotlogic-train \\
      SUPABASE_URL=... \\
      SUPABASE_SERVICE_ROLE_KEY=... \\
      R2_ACCOUNT_ID=... \\
      R2_ACCESS_KEY_ID=... \\
      R2_SECRET_ACCESS_KEY=... \\
      R2_BUCKET_NAME=parking-snapshots \\
      WEBHOOK_URL=https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/training-complete \\
      WEBHOOK_TOKEN=<random-secret>

Run manually:

  modal run scripts/modal-train-yolo.py

Or invoke the web endpoint to kick off training:

  curl -X POST https://<workspace>--lotlogic-train-kick-off-training.modal.run \\
       -H "Authorization: Bearer <TRAIN_TRIGGER_TOKEN>"

Cost: ~$0.10-0.30 per training run on Modal T4 (5-15 min wall time
for 100 epochs on 600 frames). Free tier covers ~100 runs/month.
"""

from __future__ import annotations

import io
import os
import time
from pathlib import Path

import modal

app = modal.App("lotlogic-train")

# Container image. Mirrors the openalpr-sidecar runtime so the trained ONNX
# is binary-compatible with what the sidecar will load.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "ultralytics==8.4.41",
        "onnx==1.21.0",
        "onnxruntime==1.20.1",
        "onnxslim==0.1.42",
        "supabase==2.10.0",
        "boto3==1.35.36",
        "pillow==10.4.0",
        "pyyaml==6.0.2",
        "requests==2.32.3",
        "fastapi[standard]==0.115.0",
    )
)


@app.function(
    image=image,
    gpu="T4",
    timeout=60 * 60,  # 1 hour hard cap
    secrets=[modal.Secret.from_name("lotlogic-train")],
)
def train_yolo(
    epochs: int = 100,
    imgsz: int = 640,
    train_split: float = 0.85,
    min_labels: int = 200,
) -> dict:
    """Pull labeled frames from Supabase + R2, train YOLOv9t, export ONNX,
    upload back to R2, ping the webhook. Returns a status dict."""
    import csv
    import json
    import random
    import shutil
    import tempfile

    import boto3
    import requests
    from PIL import Image
    from supabase import create_client
    from ultralytics import YOLO

    started_at = time.time()
    print(f"[train_yolo] start  epochs={epochs}  imgsz={imgsz}")

    # Pull labeled rows
    sb = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )
    res = (
        sb.table("plate_events")
        .select("id,plate_text,confidence,image_url,raw_data,created_at,camera_id")
        .not_.is_("image_url", "null")
        .not_.is_("raw_data->>operator_bbox", "null")
        .limit(20000)
        .execute()
    )
    rows = []
    for row in res.data or []:
        rd = row.get("raw_data") or {}
        if rd.get("operator_label") != "real_plate":
            continue
        bbox = rd.get("operator_bbox")
        if not bbox or not all(k in bbox for k in ("x1", "y1", "x2", "y2")):
            continue
        rows.append((row, bbox))

    print(f"[train_yolo] {len(rows)} labeled frames available")
    if len(rows) < min_labels:
        return {
            "ok": False,
            "reason": f"not_enough_labels (need >={min_labels}, have {len(rows)})",
            "labeled_count": len(rows),
        }

    # Shuffle + split. Seed pinned so re-runs split the same way (val curve
    # comparable across retrains).
    random.seed(42)
    random.shuffle(rows)
    split_idx = int(len(rows) * train_split)
    train_rows, val_rows = rows[:split_idx], rows[split_idx:]

    work = Path(tempfile.mkdtemp(prefix="yolo-"))
    train_img = work / "images" / "train"
    train_lbl = work / "labels" / "train"
    val_img = work / "images" / "val"
    val_lbl = work / "labels" / "val"
    for p in (train_img, train_lbl, val_img, val_lbl):
        p.mkdir(parents=True, exist_ok=True)

    skipped_download = 0
    written_train, written_val = 0, 0
    for split_name, subset, img_dir, lbl_dir in [
        ("train", train_rows, train_img, train_lbl),
        ("val", val_rows, val_img, val_lbl),
    ]:
        for row, bbox in subset:
            eid = row["id"]
            try:
                resp = requests.get(row["image_url"], timeout=20)
                if not resp.ok or len(resp.content) < 1024:  # filter 22-byte placeholders
                    skipped_download += 1
                    continue
                img = Image.open(io.BytesIO(resp.content)).convert("RGB")
            except Exception as e:
                print(f"  skip {eid}: {e}")
                skipped_download += 1
                continue
            cx = (bbox["x1"] + bbox["x2"]) / 2
            cy = (bbox["y1"] + bbox["y2"]) / 2
            bw = bbox["x2"] - bbox["x1"]
            bh = bbox["y2"] - bbox["y1"]
            img.save(img_dir / f"{eid}.jpg", "JPEG", quality=92)
            (lbl_dir / f"{eid}.txt").write_text(
                f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n"
            )
            if split_name == "train":
                written_train += 1
            else:
                written_val += 1

    print(f"[train_yolo] dataset ready: {written_train} train, {written_val} val "
          f"({skipped_download} download skips)")

    # Write the ultralytics dataset descriptor
    dataset_yaml = work / "dataset.yaml"
    dataset_yaml.write_text(
        f"path: {work}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"names:\n  0: plate\n"
        f"nc: 1\n"
    )

    # Train. yolov9t = tiny (~3M params), matches the sidecar runtime.
    model = YOLO("yolov9t.pt")
    train_result = model.train(
        data=str(dataset_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=32,
        project=str(work / "runs"),
        name="train",
        patience=20,
        cache="ram",
        plots=False,
        verbose=True,
    )

    best_pt = work / "runs" / "train" / "weights" / "best.pt"
    if not best_pt.exists():
        return {"ok": False, "reason": "training_did_not_produce_best_pt"}

    # Export ONNX. Match the same opset/dynamic settings as the manual notebook.
    best_model = YOLO(str(best_pt))
    onnx_path_str = best_model.export(
        format="onnx",
        imgsz=imgsz,
        opset=12,
        dynamic=True,
        simplify=True,
    )
    onnx_path = Path(onnx_path_str)
    onnx_size = onnx_path.stat().st_size

    # Read val metrics for the report. Run a fresh val on the BEST weights
    # (early-stop may have restored best.pt — train_result.box reports the
    # last-epoch metrics which can disagree with what's on disk).
    metrics = {}
    try:
        val_result = best_model.val(data=str(dataset_yaml), imgsz=imgsz, verbose=False)
        m = val_result.box if hasattr(val_result, "box") else None
        if m is not None:
            metrics = {
                "map50": float(m.map50),
                "map50_95": float(m.map),
                "precision": float(m.mp),
                "recall": float(m.mr),
            }
    except Exception as e:
        print(f"[train_yolo] val metrics fetch failed: {e}")
        # Fall back to last-epoch metrics so we still have something to log.
        try:
            m = train_result.box if hasattr(train_result, "box") else None
            if m is not None:
                metrics = {
                    "map50": float(m.map50),
                    "map50_95": float(m.map),
                    "precision": float(m.mp),
                    "recall": float(m.mr),
                }
        except Exception:
            pass

    # mAP floor. Refuse to commit if the model's mAP50 is below the floor —
    # protects against "operator mislabels 200 frames junk → retrain produces
    # mAP50=0.04 model → ships to prod" scenarios.
    MIN_MAP50 = float(os.environ.get("MIN_MAP50_TO_COMMIT", "0.60"))
    map50 = metrics.get("map50", 0.0)
    if map50 < MIN_MAP50:
        print(f"[train_yolo] REFUSING TO COMMIT: mAP50 {map50:.3f} < floor {MIN_MAP50}")
        shutil.rmtree(work, ignore_errors=True)
        return {
            "ok": False,
            "reason": f"map50_below_floor (got {map50:.3f}, need >= {MIN_MAP50})",
            "labeled_count": len(rows),
            "metrics": metrics,
        }

    # Commit the ONNX directly to GitHub via the Contents API.
    # Skipping R2 + the training-complete webhook entirely — Modal has
    # network access, GITHUB_PAT in its secret, and that's all that's
    # needed. Keeps the path short and removes the R2 + boto3 + sigv4
    # dance that was failing with SignatureDoesNotMatch.
    import base64
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    with open(onnx_path, "rb") as f:
        body = f.read()
    onnx_b64 = base64.b64encode(body).decode("ascii")

    gh_pat = os.environ.get("GITHUB_PAT")
    gh_owner = os.environ.get("GITHUB_OWNER", "getlotlogic")
    gh_repo = os.environ.get("GITHUB_REPO", "lotlogic")
    gh_branch = os.environ.get("GITHUB_BRANCH", "main")
    gh_path = "openalpr-sidecar/models/lotlogic-plate.onnx"

    commit_sha = None
    commit_url = None
    if gh_pat:
        gh_headers = {
            "Authorization": f"Bearer {gh_pat}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "lotlogic-modal-train",
        }
        api_base = f"https://api.github.com/repos/{gh_owner}/{gh_repo}/contents/{gh_path}"
        # Fetch existing file's sha (Contents API requires it for updates).
        sha = None
        try:
            r = requests.get(f"{api_base}?ref={gh_branch}", headers=gh_headers, timeout=20)
            if r.status_code == 200:
                sha = r.json().get("sha")
            elif r.status_code != 404:
                print(f"[train_yolo] github GET unexpected: {r.status_code} {r.text[:300]}")
        except Exception as e:
            print(f"[train_yolo] github GET error: {e}")

        m = metrics or {}
        metrics_line = (
            f"mAP50={m.get('map50', 0):.3f} mAP50-95={m.get('map50_95', 0):.3f} "
            f"P={m.get('precision', 0):.3f} R={m.get('recall', 0):.3f}"
        ) if m else "metrics unavailable"
        commit_message = (
            f"chore(sidecar): retrained YOLO detector ({len(rows)} labels)\n\n"
            f"Auto-generated by Modal training run.\n"
            f"Train/val: {written_train}/{written_val}\n"
            f"Wall time: {int(time.time() - started_at)}s\n"
            f"Validation: {metrics_line}\n"
            f"Trained at: {ts}\n"
        )
        put_body = {"message": commit_message, "content": onnx_b64, "branch": gh_branch}
        if sha:
            put_body["sha"] = sha
        try:
            r = requests.put(api_base, headers={**gh_headers, "Content-Type": "application/json"},
                             json=put_body, timeout=60)
            if r.ok:
                resp_json = r.json()
                commit_sha = resp_json.get("commit", {}).get("sha")
                commit_url = resp_json.get("commit", {}).get("html_url")
                print(f"[train_yolo] committed {commit_sha} -> {commit_url}")
            else:
                print(f"[train_yolo] github PUT failed: {r.status_code} {r.text[:300]}")
        except Exception as e:
            print(f"[train_yolo] github PUT error: {e}")
    else:
        print("[train_yolo] GITHUB_PAT not set — skipping commit")

    payload = {
        "ok": True,
        "labeled_count": len(rows),
        "train_count": written_train,
        "val_count": written_val,
        "model_size_bytes": onnx_size,
        "metrics": metrics,
        "wall_time_sec": int(time.time() - started_at),
        "trained_at": ts,
        "commit_sha": commit_sha,
        "commit_url": commit_url,
    }

    # Close the audit row (releases the concurrency lock for the next run).
    # Best-effort: failure here doesn't roll back the GitHub commit; the
    # row will simply stay open for an hour, after which the gate auto-clears.
    try:
        sb.table("training_runs").update({
            "status": "completed",
            "finished_at": "now()",
            "labels_at_kickoff": len(rows),
            "metrics": metrics,
            "commit_sha": commit_sha,
        }).is_("finished_at", "null").order(
            "started_at", desc=True
        ).limit(1).execute()
    except Exception as e:
        print(f"[train_yolo] audit close failed (non-fatal): {e}")

    shutil.rmtree(work, ignore_errors=True)
    return payload


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("lotlogic-train")],
    timeout=30,
)
@modal.fastapi_endpoint(method="POST", label="kick-off-training", requires_proxy_auth=True)
def kick_off_training(request: dict | None = None) -> dict:
    """HTTP endpoint the dashboard / edge function calls to start a run.
    Returns immediately with a function call id; training runs async.

    Auth: requires_proxy_auth=True means Modal validates Modal-Key +
    Modal-Secret headers before invoking. Caller (Supabase edge function
    yolo-retrain) supplies these from MODAL_KEY / MODAL_SECRET secrets."""
    handle = train_yolo.spawn(
        epochs=int((request or {}).get("epochs", 100)),
        imgsz=int((request or {}).get("imgsz", 640)),
    )
    return {"ok": True, "call_id": handle.object_id}


@app.local_entrypoint()
def main(epochs: int = 100, imgsz: int = 640):
    """`modal run scripts/modal-train-yolo.py` runs this — handy for ad-hoc
    retrains from a laptop without touching the dashboard."""
    result = train_yolo.remote(epochs=epochs, imgsz=imgsz)
    print(f"\n=== TRAINING COMPLETE ===\n{result}")
