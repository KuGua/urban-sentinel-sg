from __future__ import annotations

from dataclasses import dataclass
import os
import tempfile
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np


@dataclass(frozen=True)
class LWCCDensifierConfig:
    model_name: str = "CSRNet"
    model_weights: str = "SHA"
    roi_factor: float = 1.00


@dataclass(frozen=True)
class HybridAreaConfig:
    avg_height_m: float = 1.70
    min_height_samples: int = 3
    min_h_px: float = 35.0
    max_h_px: float = 520.0
    head_box_height_ratio: float = 0.35
    head_box_width_ratio: float = 0.60
    head_spacing_to_body_ratio: float = 2.8


class LWCCDensifier:
    """
    LWCC density wrapper with full-frame and default-ROI crowd indices.
    """

    def __init__(self, model_name: str = "CSRNet", roi_factor: float = 1.00, model_weights: str = "SHA"):
        self.cfg = LWCCDensifierConfig(
            model_name=str(model_name),
            model_weights=str(model_weights),
            roi_factor=float(max(0.05, min(1.0, roi_factor))),
        )
        try:
            from lwcc.LWCC import get_count as lwcc_get_count  # type: ignore
        except Exception as exc:
            raise RuntimeError(f"Failed to import LWCC.get_count: {exc}") from exc
        self._get_count = lwcc_get_count

    @staticmethod
    def _default_roi_polygon(w: int, h: int, roi_factor: float) -> np.ndarray:
        roi_h = int(round(float(h) * float(roi_factor)))
        roi_h = max(1, min(h, roi_h))
        y0 = int(h - roi_h)
        return np.asarray([(0, y0), (w, y0), (w, h), (0, h)], dtype=np.int32)

    @staticmethod
    def _roi_mask(w: int, h: int, roi_factor: float) -> Tuple[np.ndarray, np.ndarray]:
        poly = LWCCDensifier._default_roi_polygon(w=w, h=h, roi_factor=roi_factor)
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(mask, [poly], 1)
        return mask, poly

    @staticmethod
    def _as_density_map(raw_density: Any) -> np.ndarray:
        dm = np.asarray(raw_density, dtype=np.float32)
        if dm.ndim != 2:
            raise ValueError(f"Invalid density_map shape: {dm.shape}")
        return np.maximum(dm, 0.0)

    @staticmethod
    def _resize_density_preserve_sum(density_map: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
        if density_map.shape == (out_h, out_w):
            return density_map
        src_sum = float(np.maximum(density_map, 0.0).sum())
        resized = cv2.resize(density_map, (out_w, out_h), interpolation=cv2.INTER_CUBIC).astype(np.float32)
        resized = np.maximum(resized, 0.0)
        dst_sum = float(resized.sum())
        if src_sum > 0.0 and dst_sum > 0.0:
            resized *= float(src_sum / dst_sum)
        return resized

    def infer_frame(self, frame_bgr: np.ndarray) -> Dict[str, Any]:
        if frame_bgr is None or frame_bgr.ndim != 3 or frame_bgr.shape[2] != 3:
            raise ValueError("frame_bgr must be np.ndarray [H, W, 3] in BGR format")

        h, w = frame_bgr.shape[:2]
        total_pixels = float(max(1, h * w))
        mask, roi_poly = self._roi_mask(w=w, h=h, roi_factor=self.cfg.roi_factor)

        density_map_raw = None
        count_total_raw = 0.0
        first_exc: Exception | None = None
        try:
            # Preferred call per spec.
            count_total_raw, density_map_raw = self._get_count(
                frame_bgr,
                model_name=self.cfg.model_name,
                model_weights=self.cfg.model_weights,
                return_density=True,
            )
        except Exception as exc:
            first_exc = exc

        # Some lwcc versions accept only image path. Fallback via temp file.
        if density_map_raw is None:
            tmp_path = ""
            try:
                ok, enc = cv2.imencode(".png", frame_bgr)
                if not ok:
                    raise RuntimeError("cv2.imencode('.png', frame) failed")
                with tempfile.NamedTemporaryFile(prefix="lwcc_frame_", suffix=".png", delete=False) as tmp:
                    tmp_path = tmp.name
                enc.tofile(tmp_path)
                count_total_raw, density_map_raw = self._get_count(
                    tmp_path,
                    model_name=self.cfg.model_name,
                    model_weights=self.cfg.model_weights,
                    return_density=True,
                )
            except Exception as exc:
                if first_exc is not None:
                    raise RuntimeError(f"LWCC inference failed: {first_exc}; fallback failed: {exc}") from exc
                raise RuntimeError(f"LWCC inference failed: {exc}") from exc
            finally:
                if tmp_path:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass

        if density_map_raw is None:
            raise RuntimeError("LWCC returned None density_map")

        density_map = self._as_density_map(density_map_raw)
        density_map = self._resize_density_preserve_sum(density_map, out_w=w, out_h=h)

        # Prefer integral of density map for internal consistency.
        count_total = float(density_map.sum())
        if np.isfinite(float(count_total_raw)):
            # Keep close to LWCC returned count when both are valid.
            count_total = float(count_total_raw)

        roi_count = float((density_map * mask.astype(np.float32)).sum())
        roi_pixels = float(max(1.0, float(mask.sum())))
        crowd_index = float(count_total / total_pixels)
        roi_index = float(roi_count / roi_pixels)

        return {
            "count_total": float(count_total),
            "crowd_index": float(crowd_index),
            "roi_count": float(roi_count),
            "roi_index": float(roi_index),
            "density_map": density_map,
            "roi_mask": mask,
            "roi_polygon": roi_poly,
            "frame_shape": (int(h), int(w)),
        }


class LWCCYoloHybridDensifier(LWCCDensifier):
    """
    Hybrid estimator:
    - people count from LWCC density map
    - area from YOLO person/body reference
    - density_m2 = lwcc_count / estimated_area_m2
    """

    def __init__(
        self,
        model_name: str = "CSRNet",
        roi_factor: float = 1.00,
        model_weights: str = "SHA",
        yolo_model: str = "ml-service/models/yolov8n.pt",
        yolo_conf: float = 0.25,
        device: str = "auto",
        avg_height_m: float = 1.70,
        min_height_samples: int = 3,
        min_h_px: float = 35.0,
        max_h_px: float = 520.0,
        head_box_height_ratio: float = 0.35,
        head_box_width_ratio: float = 0.60,
        head_spacing_to_body_ratio: float = 2.8,
    ):
        super().__init__(model_name=model_name, roi_factor=roi_factor, model_weights=model_weights)
        self.area_cfg = HybridAreaConfig(
            avg_height_m=float(avg_height_m),
            min_height_samples=int(max(1, min_height_samples)),
            min_h_px=float(min_h_px),
            max_h_px=float(max_h_px),
            head_box_height_ratio=float(head_box_height_ratio),
            head_box_width_ratio=float(head_box_width_ratio),
            head_spacing_to_body_ratio=float(head_spacing_to_body_ratio),
        )
        self.yolo_model_name = str(yolo_model)
        self.yolo_conf = float(yolo_conf)
        self.device = self._resolve_yolo_device(device)
        self.yolo_available = False
        self.yolo_reason = ""
        self._yolo = None
        try:
            from ultralytics import YOLO  # type: ignore

            self._yolo = YOLO(self.yolo_model_name)
            self.yolo_available = True
        except Exception as exc:
            self.yolo_reason = str(exc)

    @staticmethod
    def _resolve_yolo_device(device: str) -> str | int:
        d = str(device).strip().lower()
        if d != "auto":
            return device
        try:
            import torch  # type: ignore

            return 0 if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    @staticmethod
    def _center_from_bbox(bbox: List[float]) -> Tuple[float, float]:
        x1, y1, x2, y2 = [float(v) for v in bbox]
        return 0.5 * (x1 + x2), 0.5 * (y1 + y2)

    def _head_bbox_from_person(self, bbox: List[float], frame_w: int, frame_h: int) -> List[float]:
        x1, y1, x2, y2 = [float(v) for v in bbox]
        w = max(1.0, x2 - x1)
        h = max(1.0, y2 - y1)
        cx = 0.5 * (x1 + x2)
        hw = max(4.0, w * self.area_cfg.head_box_width_ratio)
        hh = max(4.0, h * self.area_cfg.head_box_height_ratio)
        return [
            max(0.0, cx - 0.5 * hw),
            max(0.0, y1),
            min(float(frame_w - 1), cx + 0.5 * hw),
            min(float(frame_h - 1), y1 + hh),
        ]

    def _detect_people_heads(self, frame_bgr: np.ndarray) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        if not self.yolo_available or self._yolo is None:
            return [], []
        try:
            results = self._yolo.predict(
                source=frame_bgr,
                device=self.device,
                classes=[0],  # person
                conf=self.yolo_conf,
                verbose=False,
            )
        except Exception as exc:
            self.yolo_reason = str(exc)
            return [], []
        if not results:
            return [], []
        boxes = results[0].boxes
        if boxes is None:
            return [], []
        xyxy = boxes.xyxy.cpu().numpy() if boxes.xyxy is not None else np.empty((0, 4))
        confs = boxes.conf.cpu().numpy() if boxes.conf is not None else np.empty((0,))
        h, w = frame_bgr.shape[:2]
        people: List[Dict[str, Any]] = []
        heads: List[Dict[str, Any]] = []
        for i in range(len(xyxy)):
            x1, y1, x2, y2 = [float(v) for v in xyxy[i].tolist()]
            conf = float(confs[i]) if i < len(confs) else 0.0
            pb = [x1, y1, x2, y2]
            people.append({"bbox": pb, "conf": conf})
            heads.append({"bbox": self._head_bbox_from_person(pb, frame_w=w, frame_h=h), "conf": conf})
        return people, heads

    def infer_frame(self, frame_bgr: np.ndarray) -> Dict[str, Any]:
        out = super().infer_frame(frame_bgr)
        h, w = frame_bgr.shape[:2]
        mask = out["roi_mask"].astype(bool)
        roi_pixels = float(max(1, int(mask.sum())))
        roi_count = float(out["roi_count"])
        count_total = float(out["count_total"])

        people, heads = self._detect_people_heads(frame_bgr)
        valid_h: List[float] = []
        roi_people = 0
        roi_heads = 0
        for det in people:
            bbox = det["bbox"]
            cx, cy = self._center_from_bbox(bbox)
            xi = int(round(cx))
            yi = int(round(cy))
            if 0 <= xi < w and 0 <= yi < h and mask[yi, xi]:
                roi_people += 1
                body_h = float(bbox[3]) - float(bbox[1])
                if self.area_cfg.min_h_px <= body_h <= self.area_cfg.max_h_px:
                    valid_h.append(body_h)
        for det in heads:
            bbox = det["bbox"]
            cx, cy = self._center_from_bbox(bbox)
            xi = int(round(cx))
            yi = int(round(cy))
            if 0 <= xi < w and 0 <= yi < h and mask[yi, xi]:
                roi_heads += 1

        # Fallback when person-body references are insufficient:
        # use nearest head-point spacing from LWCC density peaks.
        if len(valid_h) < int(self.area_cfg.min_height_samples):
            peak_points_roi = self._roi_head_peaks_from_density(out["density_map"], mask)
            spacing_h = self._body_height_from_head_spacing(peak_points_roi)
            valid_h.extend(spacing_h)

        scale_px_per_m = None
        area_m2_est = None
        density_m2_lwcc = None
        if len(valid_h) >= int(self.area_cfg.min_height_samples) and self.area_cfg.avg_height_m > 0:
            h_med = float(np.median(np.asarray(valid_h, dtype=np.float32)))
            scale_px_per_m = h_med / float(self.area_cfg.avg_height_m)
            if scale_px_per_m > 1e-6:
                area_m2_est = float(roi_pixels / (scale_px_per_m * scale_px_per_m))
                if area_m2_est > 1e-9:
                    density_m2_lwcc = float(roi_count / area_m2_est)

        out["yolo_people_count_roi"] = int(roi_people)
        out["yolo_head_count_roi"] = int(roi_heads)
        out["yolo_people_count_total"] = int(len(people))
        out["yolo_head_count_total"] = int(len(heads))
        out["yolo_people_bboxes"] = [list(map(float, d["bbox"])) for d in people]
        out["yolo_head_bboxes"] = [list(map(float, d["bbox"])) for d in heads]
        out["yolo_available"] = bool(self.yolo_available)
        out["yolo_reason"] = str(self.yolo_reason)
        out["lwcc_density_m2"] = float(density_m2_lwcc) if density_m2_lwcc is not None else None
        out["area_m2_est"] = float(area_m2_est) if area_m2_est is not None else None
        out["scale_px_per_m"] = float(scale_px_per_m) if scale_px_per_m is not None else None
        out["lwcc_count_total"] = float(count_total)
        out["lwcc_count_roi"] = float(roi_count)
        return out

    @staticmethod
    def _roi_head_peaks_from_density(density_map: np.ndarray, roi_mask: np.ndarray) -> np.ndarray:
        dm = np.asarray(density_map, dtype=np.float32)
        dm = np.maximum(dm, 0.0)
        if dm.ndim != 2 or dm.size == 0:
            return np.empty((0, 2), dtype=np.float32)
        dm_s = cv2.GaussianBlur(dm, (0, 0), sigmaX=0.7, sigmaY=0.7)
        mx = float(dm_s.max())
        if mx <= 1e-8:
            return np.empty((0, 2), dtype=np.float32)
        kernel = np.ones((3, 3), dtype=np.uint8)
        local_max = dm_s >= cv2.dilate(dm_s, kernel)
        thr = max(0.08 * mx, float(dm_s.mean() + 0.8 * dm_s.std()))
        mask = local_max & (dm_s >= thr) & roi_mask.astype(bool)
        ys, xs = np.where(mask)
        if xs.size < 2:
            return np.empty((0, 2), dtype=np.float32)
        pts = np.stack([xs.astype(np.float32), ys.astype(np.float32)], axis=1)
        return pts

    def _body_height_from_head_spacing(self, points_xy: np.ndarray) -> List[float]:
        if points_xy.ndim != 2 or points_xy.shape[0] < 2:
            return []
        pts = np.asarray(points_xy, dtype=np.float32)
        out: List[float] = []
        for i in range(pts.shape[0]):
            p = pts[i]
            diff = pts - p
            dist = np.sqrt(np.sum(diff * diff, axis=1))
            dist[i] = np.inf
            nn = float(np.min(dist))
            if np.isfinite(nn) and nn > 0:
                hpx = nn * float(self.area_cfg.head_spacing_to_body_ratio)
                if self.area_cfg.min_h_px <= hpx <= self.area_cfg.max_h_px:
                    out.append(float(hpx))
        return out
