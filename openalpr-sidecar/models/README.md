# Custom-trained ONNX models

Drop `lotlogic-plate.onnx` (the Charlotte fine-tune from
`scripts/colab-train-yolo.ipynb`) into this directory. The Dockerfile
COPYs the directory into `/app/models/` and the sidecar reads the model
when `DETECTOR_MODEL_PATH=/app/models/lotlogic-plate.onnx` is set on
Railway.

If the .onnx is absent, the COPY silently no-ops (glob match) and the
sidecar falls back to the bundled `yolo-v9-s-608-license-plate-end2end`.

The model weights are committed directly (yolov9t fused is ~5–10 MB,
well under GitHub's 100 MB hard limit). If we ever bump to a larger
variant (yolov9c or v9e), switch this directory to git-lfs.
