from __future__ import annotations

import base64
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import cv2
import numpy as np
from flask import Flask, jsonify, request

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
REPO_ROOT = PROJECT_ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from ml.detector import YoloV8SplitHeadVehicleDetector  # noqa: E402
from crowd_counting.lwcc_density import LWCCYoloHybridDensifier  # noqa: E402


def _parse_data_url_to_bgr(data_url: str) -> np.ndarray:
    if not data_url:
        raise ValueError("imageBase64 is required")
    raw = data_url
    if "," in data_url:
        raw = data_url.split(",", 1)[1]
    try:
        decoded = base64.b64decode(raw, validate=True)
    except Exception as exc:  # pragma: no cover
        raise ValueError(f"invalid base64 image: {exc}") from exc

    arr = np.frombuffer(decoded, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("failed to decode image into BGR")
    return img


def _vehicle_detections(dets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for d in dets:
        if str(d.get("label", "")) != "vehicle":
            continue
        bbox = d.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4:
            continue
        out.append(
            {
                "bbox": [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
                "conf": float(d.get("conf", 0.0)),
                "className": str(d.get("className", "vehicle")),
            }
        )
    return out


app = Flask(__name__)

DETECTOR = YoloV8SplitHeadVehicleDetector(
    person_model_name=os.getenv("ML_PERSON_MODEL", str(PROJECT_ROOT / "models" / "yolov8n.pt")),
    vehicle_model_name=os.getenv("ML_VEHICLE_MODEL", str(PROJECT_ROOT / "models" / "vehicle_best.pt")),
    person_conf_threshold=float(os.getenv("ML_PERSON_CONF", "0.25")),
    vehicle_conf_threshold=float(os.getenv("ML_VEHICLE_CONF", "0.25")),
    include_head_proxy=False,
    device=os.getenv("ML_DEVICE", "auto"),
)

HYBRID_DENSIFIER = LWCCYoloHybridDensifier(
    model_name=os.getenv("ML_LWCC_MODEL_NAME", "CSRNet"),
    model_weights=os.getenv("ML_LWCC_MODEL_WEIGHTS", "SHA"),
    roi_factor=1.0,
    yolo_model=os.getenv("ML_PERSON_MODEL", str(PROJECT_ROOT / "models" / "yolov8n.pt")),
    yolo_conf=float(os.getenv("ML_PERSON_CONF", "0.25")),
    device=os.getenv("ML_DEVICE", "auto"),
    avg_height_m=float(os.getenv("ML_AVG_HEIGHT_M", "1.70")),
    min_height_samples=int(os.getenv("ML_MIN_HEIGHT_SAMPLES", "3")),
)


def _risk_level_by_density_m2(value: float | None) -> str:
    if value is None or not np.isfinite(float(value)):
        return "unknown"
    d = float(value)
    if d > 6.0:
        return "extreme"
    if d > 4.0:
        return "high_risk"
    if d >= 2.0:
        return "crowded"
    return "safe"


def _risk_score_by_density_m2(value: float | None) -> float:
    if value is None or not np.isfinite(float(value)):
        return 0.0
    # Normalize with 6 ppl/m2 ~= max risk.
    return float(max(0.0, min(1.0, float(value) / 6.0)))


@app.get("/health")
def health() -> Any:
    return jsonify(
        {
            "ok": bool(DETECTOR.available or HYBRID_DENSIFIER.yolo_available),
            "reason": DETECTOR.reason if DETECTOR.available else HYBRID_DENSIFIER.yolo_reason,
            "personModel": DETECTOR.person_model_name,
            "vehicleModel": DETECTOR.vehicle_model_name,
            "densityModel": os.getenv("ML_LWCC_MODEL_NAME", "CSRNet"),
            "densityWeights": os.getenv("ML_LWCC_MODEL_WEIGHTS", "SHA"),
        }
    )


@app.post("/infer/traffic-camera")
def infer_traffic_camera() -> Any:
    body = request.get_json(silent=True) or {}
    camera_id = str(body.get("cameraId", "")).strip()
    image_base64 = str(body.get("imageBase64", "")).strip()
    image_url = str(body.get("imageUrl", "")).strip()
    captured_at = str(body.get("capturedAt", "")).strip()

    if not camera_id:
        return jsonify({"error": "cameraId is required"}), 400

    try:
        frame_bgr = _parse_data_url_to_bgr(image_base64)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    img_h, img_w = frame_bgr.shape[:2]
    vehicle_dets = _vehicle_detections(DETECTOR.detect(frame_bgr)) if DETECTOR.available else []
    try:
        density = HYBRID_DENSIFIER.infer_frame(frame_bgr)
    except Exception as exc:
        return jsonify({"error": f"density infer failed: {exc}"}), 503

    density_m2 = density.get("lwcc_density_m2")
    risk_level = _risk_level_by_density_m2(float(density_m2) if density_m2 is not None else None)
    risk_score = _risk_score_by_density_m2(float(density_m2) if density_m2 is not None else None)
    people_boxes = density.get("yolo_people_bboxes", [])
    head_boxes = density.get("yolo_head_bboxes", [])

    return jsonify(
        {
            "cameraId": camera_id,
            "model": Path(DETECTOR.vehicle_model_name).name,
            "ts": int(time.time() * 1000),
            "capturedAt": captured_at or None,
            "imageUrl": image_url or None,
            "imageWidth": int(img_w),
            "imageHeight": int(img_h),
            "vehicleCount": len(vehicle_dets),
            "detections": vehicle_dets,
            "peopleCount": float(density.get("lwcc_count_total", 0.0)),
            "estimatedAreaM2": density.get("area_m2_est"),
            "densityM2": density_m2,
            "riskLevel": risk_level,
            "riskScore": risk_score,
            "yoloPeopleCount": int(density.get("yolo_people_count_total", 0)),
            "yoloHeadCount": int(density.get("yolo_head_count_total", 0)),
            "yoloPeopleDetections": [
                {"bbox": [float(b[0]), float(b[1]), float(b[2]), float(b[3])]} for b in people_boxes if isinstance(b, list) and len(b) == 4
            ],
            "yoloHeadDetections": [
                {"bbox": [float(b[0]), float(b[1]), float(b[2]), float(b[3])]} for b in head_boxes if isinstance(b, list) and len(b) == 4
            ],
            "populationDensity": {
                "peopleCount": float(density.get("lwcc_count_total", 0.0)),
                "estimatedAreaM2": density.get("area_m2_est"),
                "densityM2": density_m2,
                "riskLevel": risk_level,
                "riskScore": risk_score,
                "yoloPeopleCount": int(density.get("yolo_people_count_total", 0)),
                "yoloHeadCount": int(density.get("yolo_head_count_total", 0)),
                "yoloPeopleDetections": [
                    {"bbox": [float(b[0]), float(b[1]), float(b[2]), float(b[3])]}
                    for b in people_boxes
                    if isinstance(b, list) and len(b) == 4
                ],
                "yoloHeadDetections": [
                    {"bbox": [float(b[0]), float(b[1]), float(b[2]), float(b[3])]}
                    for b in head_boxes
                    if isinstance(b, list) and len(b) == 4
                ],
            },
        }
    )


if __name__ == "__main__":
    host = os.getenv("ML_BIND_HOST", "127.0.0.1")
    port = int(os.getenv("ML_BIND_PORT", "8099"))
    app.run(host=host, port=port, debug=False)
