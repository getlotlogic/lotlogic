"""Custom YOLO detector for our fine-tuned ONNX export.

The pre-bundled open-image-models detectors use *-end2end ONNX graphs with
NMS baked in. Our ultralytics export (yolov9t fine-tuned on Charlotte data)
produces a raw-prediction graph: shape (1, 5, 8400) where 5 = [cx, cy, w, h, conf]
for a single class ("plate"), 8400 = candidate boxes at 640x640.

This wrapper:
  - loads the ONNX with onnxruntime (CPU)
  - letterboxes input to imgsz x imgsz
  - runs inference
  - decodes raw predictions
  - applies confidence threshold + class-agnostic NMS
  - rescales bboxes back to original image coordinates

Output shape matches open-image-models DetectionResult (.bounding_box.x1/y1/x2/y2,
.confidence, .label) so app.py can swap detectors with a single env-var flip.
"""

from dataclasses import dataclass
from typing import List, Tuple

import cv2
import numpy as np
import onnxruntime as ort


@dataclass
class _BBox:
    x1: int
    y1: int
    x2: int
    y2: int


@dataclass
class _Detection:
    label: str
    confidence: float
    bounding_box: _BBox


class CustomYoloDetector:
    """Drop-in replacement for open_image_models.LicensePlateDetector.

    Works with any single-class YOLOv8/v9 ONNX exported from ultralytics
    without `nms=True`. Output channels assumed to be [cx, cy, w, h, conf].
    """

    def __init__(
        self,
        model_path: str,
        imgsz: int = 640,
        conf_thresh: float = 0.25,
        iou_thresh: float = 0.45,
        label: str = "License Plate",
    ) -> None:
        self.imgsz = imgsz
        self.conf_thresh = conf_thresh
        self.iou_thresh = iou_thresh
        self.label = label

        sess_opts = ort.SessionOptions()
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            model_path,
            sess_options=sess_opts,
            providers=["CPUExecutionProvider"],
        )
        self.input_name = self.session.get_inputs()[0].name

    def _letterbox(self, img: np.ndarray) -> Tuple[np.ndarray, float, int, int]:
        """Resize while preserving aspect ratio, then pad to imgsz×imgsz.
        Returns the padded image plus the scale + (pad_x, pad_y) needed to
        invert the transform when rescaling bboxes."""
        h, w = img.shape[:2]
        scale = min(self.imgsz / w, self.imgsz / h)
        new_w, new_h = int(round(w * scale)), int(round(h * scale))
        resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((self.imgsz, self.imgsz, 3), 114, dtype=np.uint8)
        pad_x = (self.imgsz - new_w) // 2
        pad_y = (self.imgsz - new_h) // 2
        canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized
        return canvas, scale, pad_x, pad_y

    @staticmethod
    def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thresh: float) -> List[int]:
        """Class-agnostic NMS. Returns kept indices, highest score first."""
        if boxes.size == 0:
            return []
        x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        areas = (x2 - x1) * (y2 - y1)
        order = scores.argsort()[::-1]
        keep: List[int] = []
        while order.size > 0:
            i = int(order[0])
            keep.append(i)
            if order.size == 1:
                break
            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])
            inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
            iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
            order = order[1:][iou < iou_thresh]
        return keep

    def predict(self, img: np.ndarray) -> List[_Detection]:
        if img is None or img.size == 0:
            return []
        h0, w0 = img.shape[:2]

        padded, scale, pad_x, pad_y = self._letterbox(img)
        # BGR -> RGB, HWC -> CHW, normalize to [0, 1], add batch dim.
        x = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        x = np.transpose(x, (2, 0, 1))[None, ...]

        out = self.session.run(None, {self.input_name: x})[0]
        # Ultralytics yolov9t output: (1, 5, N) where 5 = [cx, cy, w, h, conf].
        # Some exports flip the last two axes — handle both.
        if out.ndim == 3 and out.shape[1] in (5, 6):
            preds = out[0].T  # (N, 5)
        elif out.ndim == 3 and out.shape[2] in (5, 6):
            preds = out[0]  # (N, 5)
        else:
            return []

        confs = preds[:, 4]
        mask = confs >= self.conf_thresh
        preds = preds[mask]
        confs = confs[mask]
        if preds.shape[0] == 0:
            return []

        # Convert cx,cy,w,h -> x1,y1,x2,y2 in letterbox coords.
        cx, cy, ww, hh = preds[:, 0], preds[:, 1], preds[:, 2], preds[:, 3]
        boxes_lb = np.stack([cx - ww / 2, cy - hh / 2, cx + ww / 2, cy + hh / 2], axis=1)

        keep = self._nms(boxes_lb, confs, self.iou_thresh)
        boxes_lb = boxes_lb[keep]
        confs = confs[keep]

        # Undo letterbox: subtract pad, divide by scale, clamp to image.
        boxes_lb[:, [0, 2]] -= pad_x
        boxes_lb[:, [1, 3]] -= pad_y
        boxes = boxes_lb / scale
        boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, w0 - 1)
        boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, h0 - 1)

        results: List[_Detection] = []
        for (x1, y1, x2, y2), conf in zip(boxes, confs):
            results.append(
                _Detection(
                    label=self.label,
                    confidence=float(conf),
                    bounding_box=_BBox(int(x1), int(y1), int(x2), int(y2)),
                )
            )
        return results
