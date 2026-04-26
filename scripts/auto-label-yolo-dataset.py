#!/usr/bin/env python3
"""Auto-label plate_events images via the Plate Recognizer SDK and export
a YOLO-format dataset for fine-tuning the Charlotte plate detector.

How it works:
  1. Pull plate_events rows with non-null image_url from Supabase.
  2. Download each image from R2.
  3. POST each image to the self-hosted PR Snapshot SDK (Railway).
  4. SDK returns plate text + bbox(es).
  5. Write image + YOLO-format label file (one .txt per image).
  6. Split into train/val.

Each image processed = 1 SDK lookup. Watch your monthly cap.

Usage:
  pip install supabase requests pyyaml pillow
  export SUPABASE_URL=https://nzdkoouoaedbbccraoti.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
  export PR_SDK_URL=https://alpr-production-0f91.up.railway.app/v1/plate-reader/
  python scripts/auto-label-yolo-dataset.py --out ./yolo-dataset --limit 500

Then train (Colab / RunPod / local GPU):
  pip install ultralytics
  yolo detect train data=yolo-dataset/dataset.yaml model=yolov9t.pt \
      epochs=100 imgsz=640 project=lotlogic-finetune

Then export for the sidecar:
  yolo export model=lotlogic-finetune/train/weights/best.pt format=onnx
"""

import argparse
import csv
import io
import os
import sys
import time
from pathlib import Path

try:
    from supabase import create_client
    import requests
    import yaml
    from PIL import Image
except ImportError as e:
    print(f"Missing dep: {e}. Run: pip install supabase requests pyyaml pillow")
    sys.exit(1)


def label_image(sdk_url: str, img_bytes: bytes) -> list[dict]:
    """POST image to PR SDK, return list of plate result dicts.
    Returns empty list if SDK found nothing usable."""
    files = {"upload": ("snap.jpg", img_bytes, "image/jpeg")}
    try:
        r = requests.post(sdk_url, files=files, timeout=20)
        if not r.ok:
            return []
        data = r.json()
        return data.get("results", []) or []
    except Exception as e:
        print(f"  sdk error: {e}")
        return []


def to_yolo_bbox(box: dict, img_w: int, img_h: int) -> tuple[float, float, float, float]:
    """Convert PR's pixel bbox {xmin,ymin,xmax,ymax} to YOLO's normalized
    (center_x, center_y, width, height)."""
    xmin, ymin = box["xmin"], box["ymin"]
    xmax, ymax = box["xmax"], box["ymax"]
    cx = (xmin + xmax) / 2 / img_w
    cy = (ymin + ymax) / 2 / img_h
    w = (xmax - xmin) / img_w
    h = (ymax - ymin) / img_h
    return cx, cy, w, h


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="./yolo-dataset",
                        help="Output directory")
    parser.add_argument("--limit", type=int, default=500,
                        help="Max plate_events rows to process (= max SDK lookups)")
    parser.add_argument("--days", type=float, default=1.0,
                        help="Only consider plate_events from the last N days (default 1)")
    parser.add_argument("--min-confidence", type=float, default=0.80,
                        help="Skip results below this PR plate confidence")
    parser.add_argument("--train-split", type=float, default=0.85,
                        help="Fraction for train set")
    parser.add_argument("--include-rejected", action="store_true",
                        help="Also process sidecar_rejected diagnostic rows "
                        "(useful for learning from current YOLO failures)")
    args = parser.parse_args()

    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    sdk_url = os.environ.get("PR_SDK_URL")
    if not sb_url or not sb_key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars")
        sys.exit(1)
    if not sdk_url:
        print("Set PR_SDK_URL env var (e.g. https://alpr-production-0f91.up.railway.app/v1/plate-reader/)")
        sys.exit(1)

    out = Path(args.out)
    train_img = out / "images" / "train"
    train_lbl = out / "labels" / "train"
    val_img = out / "images" / "val"
    val_lbl = out / "labels" / "val"
    for p in [train_img, train_lbl, val_img, val_lbl]:
        p.mkdir(parents=True, exist_ok=True)

    sb = create_client(sb_url, sb_key)

    # Pull candidate rows. Default = rows that already have a confirmed plate
    # (PR call succeeded) plus an image_url. If --include-rejected, also pull
    # sidecar_rejected rows where the SDK might find a plate the YOLO sidecar
    # missed — these are the highest-leverage training samples.
    from datetime import datetime, timedelta, timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(days=args.days)).isoformat()
    print(f"Querying plate_events from last {args.days} day(s) (since {cutoff[:19]} UTC)...")
    q = sb.table("plate_events").select(
        "id,plate_text,image_url,match_status,raw_data,created_at,camera_id"
    ).not_.is_("image_url", "null").gte("created_at", cutoff)
    if not args.include_rejected:
        q = q.in_("match_status", ["unmatched"])
    rows = q.order("created_at", desc=True).limit(args.limit).execute().data or []
    print(f"Got {len(rows)} candidate rows")

    if not rows:
        print("No rows to process.")
        sys.exit(0)

    # Dedup by image (some images get linked to multiple rows via inherits)
    seen_urls: set[str] = set()
    unique_rows = []
    for r in rows:
        u = r.get("image_url")
        if u and u not in seen_urls:
            seen_urls.add(u)
            unique_rows.append(r)
    print(f"Deduped to {len(unique_rows)} unique images")

    # Shuffle + split
    import random
    random.seed(42)
    random.shuffle(unique_rows)
    split = int(len(unique_rows) * args.train_split)
    train_rows = unique_rows[:split]
    val_rows = unique_rows[split:]

    metadata_path = out / "metadata.csv"
    sdk_lookups = 0
    skipped = {"no_plate": 0, "low_conf": 0, "img_error": 0, "sdk_error": 0}

    with open(metadata_path, "w", newline="") as mf:
        wr = csv.writer(mf)
        wr.writerow(["event_id", "split", "plate_text", "sdk_plate", "sdk_score",
                     "img_w", "img_h", "created_at", "camera_id"])

        for split_name, rows_subset, img_dir, lbl_dir in [
            ("train", train_rows, train_img, train_lbl),
            ("val", val_rows, val_img, val_lbl),
        ]:
            saved = 0
            for row in rows_subset:
                eid = row["id"]
                try:
                    resp = requests.get(row["image_url"], timeout=15)
                    if not resp.ok:
                        print(f"  skip {eid}: HTTP {resp.status_code}")
                        skipped["img_error"] += 1
                        continue
                    img_bytes = resp.content
                    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                    img_w, img_h = img.size
                except Exception as e:
                    print(f"  skip {eid}: {e}")
                    skipped["img_error"] += 1
                    continue

                # Auto-label via SDK
                results = label_image(sdk_url, img_bytes)
                sdk_lookups += 1

                if not results:
                    skipped["no_plate"] += 1
                    continue

                # Take the highest-confidence result (PR returns sorted desc usually)
                best = max(results, key=lambda r: r.get("score", 0))
                if best.get("score", 0) < args.min_confidence:
                    skipped["low_conf"] += 1
                    continue
                box = best.get("box")
                if not box:
                    skipped["sdk_error"] += 1
                    continue

                # Convert and write
                cx, cy, bw, bh = to_yolo_bbox(box, img_w, img_h)
                img.save(img_dir / f"{eid}.jpg", "JPEG", quality=92)
                with open(lbl_dir / f"{eid}.txt", "w") as f:
                    f.write(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")
                wr.writerow([eid, split_name, row.get("plate_text", ""),
                             best.get("plate", ""), best.get("score", ""),
                             img_w, img_h, row.get("created_at", ""),
                             row.get("camera_id", "")])
                saved += 1
                if saved % 25 == 0:
                    print(f"  {split_name}: {saved} so far ({sdk_lookups} SDK calls)")
            print(f"  {split_name}: {saved} frames written")

    # Write the ultralytics dataset descriptor
    yaml_data = {
        "path": str(out.absolute()),
        "train": "images/train",
        "val": "images/val",
        "names": {0: "plate"},
        "nc": 1,
    }
    with open(out / "dataset.yaml", "w") as f:
        yaml.safe_dump(yaml_data, f)

    print()
    print(f"Done. Dataset at: {out.absolute()}")
    print(f"SDK lookups used: {sdk_lookups}")
    print(f"Skipped: {skipped}")
    print(f"Train: {sum(1 for _ in (out/'images'/'train').iterdir())}  "
          f"Val: {sum(1 for _ in (out/'images'/'val').iterdir())}")
    print()
    print("Next: train on Colab / RunPod / local GPU:")
    print(f"  pip install ultralytics")
    print(f"  yolo detect train data={out}/dataset.yaml model=yolov9t.pt "
          f"epochs=100 imgsz=640 project=lotlogic-finetune")


if __name__ == "__main__":
    main()
