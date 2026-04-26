#!/usr/bin/env python3
"""Export labeled plate_events to YOLO-format dataset for fine-tuning.

Pulls every plate_events row where:
  - raw_data.operator_label = 'real_plate'
  - raw_data.operator_bbox is set ({x1,y1,x2,y2} normalized 0-1)
  - image_url is non-null and the image is downloadable from R2

Writes:
  out/
    images/
      <event_id>.jpg
    labels/
      <event_id>.txt   # YOLO format: "0 cx cy w h" (single class: plate)
    dataset.yaml       # ultralytics-compatible dataset descriptor
    metadata.csv       # event_id,plate_text,camera,confidence,created_at

Usage:
  pip install supabase requests pyyaml pillow
  export SUPABASE_URL=https://nzdkoouoaedbbccraoti.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
  python scripts/export-yolo-dataset.py --out ./yolo-dataset

Once exported, fine-tune the YOLOv9 detector with ultralytics:
  pip install ultralytics
  yolo detect train \
      data=yolo-dataset/dataset.yaml \
      model=yolov9t.pt \
      epochs=100 \
      imgsz=640 \
      project=lotlogic-finetune

Then export to ONNX:
  yolo export model=lotlogic-finetune/train/weights/best.pt format=onnx

Drop the resulting .onnx into open-image-models' cache and point
DETECTOR_MODEL at the new model name on Railway.
"""

import argparse
import csv
import io
import os
import sys
from pathlib import Path

try:
    from supabase import create_client
    import requests
    import yaml
    from PIL import Image
except ImportError as e:
    print(f"Missing dep: {e}. Run: pip install supabase requests pyyaml pillow")
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="./yolo-dataset", help="Output directory")
    parser.add_argument("--limit", type=int, default=10000, help="Max rows to pull")
    parser.add_argument("--train-split", type=float, default=0.85, help="Fraction for train set")
    args = parser.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars")
        sys.exit(1)

    out = Path(args.out)
    train_img = out / "images" / "train"
    train_lbl = out / "labels" / "train"
    val_img = out / "images" / "val"
    val_lbl = out / "labels" / "val"
    for p in [train_img, train_lbl, val_img, val_lbl]:
        p.mkdir(parents=True, exist_ok=True)

    sb = create_client(url, key)
    print(f"Querying plate_events with operator_bbox...")

    # Pull all candidates. supabase-py doesn't expose JSONB filtering for
    # nested keys via the REST helper, so we filter client-side.
    # match_status filter intentionally omitted — operator_label='real_plate' +
    # operator_bbox are the only requirements. Filtering operator_label at the
    # SQL layer would be ideal but supabase-py doesn't expose nested-JSONB ops,
    # so we filter client-side after the fetch.
    res = sb.table("plate_events").select(
        "id,plate_text,confidence,image_url,raw_data,created_at,camera_id"
    ).not_.is_("image_url", "null").not_.is_("raw_data->>operator_bbox", "null").limit(args.limit).execute()

    rows_with_bbox = []
    for row in res.data or []:
        rd = row.get("raw_data") or {}
        if rd.get("operator_label") != "real_plate":
            continue
        bbox = rd.get("operator_bbox")
        if not bbox or not all(k in bbox for k in ("x1", "y1", "x2", "y2")):
            continue
        rows_with_bbox.append((row, bbox))

    print(f"Found {len(rows_with_bbox)} labeled+bboxed frames")
    if not rows_with_bbox:
        print("Nothing to export. Label more frames in the dashboard Training tab first.")
        sys.exit(0)

    # Shuffle + split
    import random
    random.seed(42)
    random.shuffle(rows_with_bbox)
    split = int(len(rows_with_bbox) * args.train_split)
    train_rows = rows_with_bbox[:split]
    val_rows = rows_with_bbox[split:]

    metadata_path = out / "metadata.csv"
    with open(metadata_path, "w", newline="") as mf:
        wr = csv.writer(mf)
        wr.writerow(["event_id", "split", "plate_text", "confidence", "created_at", "camera_id"])

        for split_name, rows, img_dir, lbl_dir in [
            ("train", train_rows, train_img, train_lbl),
            ("val", val_rows, val_img, val_lbl),
        ]:
            saved = 0
            for row, bbox in rows:
                eid = row["id"]
                try:
                    resp = requests.get(row["image_url"], timeout=15)
                    if not resp.ok:
                        print(f"  skip {eid}: HTTP {resp.status_code}")
                        continue
                    img = Image.open(io.BytesIO(resp.content)).convert("RGB")
                    w, h = img.size
                except Exception as e:
                    print(f"  skip {eid}: {e}")
                    continue

                # Normalize bbox is already 0-1; YOLO uses cx,cy,w,h normalized.
                cx = (bbox["x1"] + bbox["x2"]) / 2
                cy = (bbox["y1"] + bbox["y2"]) / 2
                bw = bbox["x2"] - bbox["x1"]
                bh = bbox["y2"] - bbox["y1"]

                img.save(img_dir / f"{eid}.jpg", "JPEG", quality=92)
                with open(lbl_dir / f"{eid}.txt", "w") as f:
                    f.write(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")
                wr.writerow([eid, split_name, row.get("plate_text", ""),
                             row.get("confidence", ""), row.get("created_at", ""),
                             row.get("camera_id", "")])
                saved += 1
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

    print(f"\nDone. Dataset at: {out}")
    print(f"Train: {len(train_rows)} | Val: {len(val_rows)}")
    print(f"\nNext: yolo detect train data={out}/dataset.yaml model=yolov9t.pt epochs=100 imgsz=640")


if __name__ == "__main__":
    main()
