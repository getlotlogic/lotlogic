# Fine-tuning the plate detector on Charlotte data

## Pipeline

1. Operator labels frames in dashboard Training tab → bbox stored in `plate_events.raw_data.operator_bbox`
2. `scripts/export-yolo-dataset.py` pulls labeled frames + bboxes → YOLO-format dataset
3. Fine-tune yolo-v9-t on the Charlotte dataset (Colab free tier or local CPU)
4. Export to ONNX
5. Drop new ONNX into Railway sidecar via `DETECTOR_MODEL` env var

## Step 1: Export the dataset

```bash
pip install supabase requests pyyaml pillow
export SUPABASE_URL=https://nzdkoouoaedbbccraoti.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>  # from Supabase Settings → API
python scripts/export-yolo-dataset.py --out ./yolo-dataset
```

Output:
```
yolo-dataset/
  images/train/<event_id>.jpg
  images/val/<event_id>.jpg
  labels/train/<event_id>.txt
  labels/val/<event_id>.txt
  dataset.yaml
  metadata.csv
```

Target: 200+ labeled frames minimum, 1000+ ideal.

## Step 2: Fine-tune

### Option A — Local CPU (slow, free)

```bash
pip install ultralytics
yolo detect train \
    data=yolo-dataset/dataset.yaml \
    model=yolov9t.pt \
    epochs=100 \
    imgsz=640 \
    project=lotlogic-finetune \
    device=cpu
```

Expect ~30-60 min on a modern laptop CPU for 500 frames.

### Option B — Google Colab (free GPU, faster)

1. Upload `yolo-dataset/` to Google Drive
2. Open https://colab.research.google.com → New notebook → Runtime → Change runtime type → T4 GPU
3. Run:

```python
!pip install ultralytics
from google.colab import drive
drive.mount('/content/drive')
!cp -r /content/drive/MyDrive/yolo-dataset /content/
!yolo detect train data=/content/yolo-dataset/dataset.yaml model=yolov9t.pt epochs=100 imgsz=640 project=/content/lotlogic-finetune
```

~5-10 min on T4 for 500 frames.

### Option C — Rent a GPU (~$1, fastest)

RunPod / Vast.ai RTX 4090 for 1 hour. Same training command. ~2-3 min.

## Step 3: Export to ONNX

```bash
yolo export model=lotlogic-finetune/train/weights/best.pt format=onnx
```

Produces `best.onnx` (~6-12 MB).

## Step 4: Validate against held-out set

```bash
yolo detect val model=lotlogic-finetune/train/weights/best.pt data=yolo-dataset/dataset.yaml
```

Compare mAP against the baseline yolo-v9-t (0.958 on multi-region dataset).
Target: ≥0.97 mAP on the Charlotte val split.

## Step 5: Deploy

The simplest path: bake the new ONNX into the sidecar Docker image.

```bash
# In openalpr-sidecar/, add the trained model to the build context
cp /path/to/best.onnx openalpr-sidecar/charlotte-finetuned-v1.onnx

# Update Dockerfile to copy + register the model
# (or use a Cloudflare R2 / GitHub Releases hosted URL fetched at build time)
```

Update `openalpr-sidecar/app.py` to load from local path instead of model name when `DETECTOR_MODEL_PATH` env var is set.

Then on Railway, set:
```
DETECTOR_MODEL_PATH=/app/charlotte-finetuned-v1.onnx
```

Push → Railway rebuilds → new model live.

## Continuous retraining (Phase 4)

The training_curator agent (designed but not yet built) will:
1. Run weekly
2. Pull new labeled frames from `plate_events`
3. Append to dataset and re-fine-tune
4. A/B test new model vs current via shadow scoring
5. Auto-promote if accuracy improves

Spec: `docs/superpowers/specs/2026-04-24-training-curator-design.md`
