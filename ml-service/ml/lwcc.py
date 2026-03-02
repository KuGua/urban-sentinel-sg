from __future__ import annotations

import importlib
from typing import Any, Dict, Iterable, List, Sequence, Tuple

import cv2
import numpy as np

from .zones import AnalysisZone


Point = Tuple[float, float]


def _to_numpy_2d(value: Any) -> np.ndarray | None:
    if value is None:
        return None
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    arr = np.asarray(value)
    if arr.ndim == 4:
        arr = arr[0, 0]
    elif arr.ndim == 3:
        arr = arr[0]
    if arr.ndim != 2:
        return None
    return arr.astype(np.float32, copy=False)


def _normalize_points(points: Iterable[Any], frame_w: int, frame_h: int) -> List[Point]:
    out: List[Point] = []
    for item in points:
        if isinstance(item, dict):
            if "x" in item and "y" in item:
                x = float(item["x"])
                y = float(item["y"])
            else:
                continue
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            x = float(item[0])
            y = float(item[1])
        else:
            continue
        if 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0:
            x *= float(frame_w - 1)
            y *= float(frame_h - 1)
        out.append((x, y))
    return out


def _extract_points(output: Any, frame_w: int, frame_h: int) -> List[Point]:
    if isinstance(output, dict):
        for key in ("points", "head_points", "coords", "locations"):
            val = output.get(key)
            if isinstance(val, (list, tuple)):
                return _normalize_points(val, frame_w=frame_w, frame_h=frame_h)
    return []


def _extract_density_map(output: Any) -> np.ndarray | None:
    if isinstance(output, dict):
        for key in ("density_map", "density", "map", "pred_map"):
            dm = _to_numpy_2d(output.get(key))
            if dm is not None:
                return dm
    return _to_numpy_2d(output)


def _head_bbox(cx: float, cy: float, frame_w: int, frame_h: int, box_size_px: float) -> List[float]:
    half = 0.5 * float(box_size_px)
    x1 = max(0.0, float(cx - half))
    y1 = max(0.0, float(cy - half))
    x2 = min(float(frame_w - 1), float(cx + half))
    y2 = min(float(frame_h - 1), float(cy + half))
    return [x1, y1, x2, y2]


def _points_from_density_map(
    density_map: np.ndarray,
    frame_w: int,
    frame_h: int,
    *,
    peak_kernel: int = 5,
    peak_threshold: float = 0.15,
    max_heads: int = 500,
) -> Tuple[List[Point], np.ndarray]:
    dm = np.asarray(density_map, dtype=np.float32)
    dm = np.maximum(dm, 0.0)
    if dm.size == 0:
        return [], dm

    dm_smooth = cv2.GaussianBlur(dm, (0, 0), sigmaX=0.7, sigmaY=0.7)
    mx = float(dm_smooth.max())
    if mx <= 1e-8:
        return [], dm_smooth

    k = int(max(3, peak_kernel))
    if k % 2 == 0:
        k += 1
    kernel = np.ones((k, k), dtype=np.uint8)
    local_max = dm_smooth >= cv2.dilate(dm_smooth, kernel)
    thr = max(float(peak_threshold) * mx, float(dm_smooth.mean() + 1.2 * dm_smooth.std()))
    mask = local_max & (dm_smooth >= thr)
    ys, xs = np.where(mask)
    if xs.size == 0:
        return [], dm_smooth

    scores = dm_smooth[ys, xs]
    order = np.argsort(-scores)
    if max_heads > 0:
        order = order[: int(max_heads)]

    d_h, d_w = dm_smooth.shape[:2]
    sx = float(frame_w) / float(max(d_w, 1))
    sy = float(frame_h) / float(max(d_h, 1))
    points: List[Point] = []
    for idx in order.tolist():
        x = (float(xs[idx]) + 0.5) * sx
        y = (float(ys[idx]) + 0.5) * sy
        points.append((x, y))
    return points, dm_smooth


def zone_counts_from_density_map(
    density_map: np.ndarray,
    zones: Iterable[AnalysisZone],
    frame_shape_hw: Tuple[int, int],
) -> Dict[str, float]:
    in_h, in_w = frame_shape_hw
    dm = np.asarray(density_map, dtype=np.float32)
    dm = np.maximum(dm, 0.0)
    d_h, d_w = dm.shape[:2]
    if d_h <= 0 or d_w <= 0:
        return {z.zone_id: 0.0 for z in zones}

    out: Dict[str, float] = {}
    for zone in zones:
        zone_mask = zone.mask.astype(np.uint8)
        if zone_mask.shape != (in_h, in_w):
            zone_mask = cv2.resize(
                zone_mask,
                (in_w, in_h),
                interpolation=cv2.INTER_NEAREST,
            )
        dm_mask = cv2.resize(
            zone_mask,
            (d_w, d_h),
            interpolation=cv2.INTER_NEAREST,
        ).astype(bool)
        out[zone.zone_id] = float(dm[dm_mask].sum()) if dm_mask.any() else 0.0
    return out


class LWCCCrowdDetector:
    def __init__(
        self,
        module_name: str = "lwcc",
        model_name: str = "",
        conf_threshold: float = 0.2,
        head_box_size_px: float = 14.0,
        peak_kernel: int = 5,
        peak_threshold: float = 0.15,
        max_heads: int = 500,
        device: str | int = "auto",
    ):
        self.module_name = str(module_name).strip() or "lwcc"
        self.model_name = str(model_name).strip()
        self.conf_threshold = float(conf_threshold)
        self.head_box_size_px = float(head_box_size_px)
        self.peak_kernel = int(peak_kernel)
        self.peak_threshold = float(peak_threshold)
        self.max_heads = int(max_heads)
        self.device = device

        self.available = False
        self.reason = ""
        self.last_aux: Dict[str, Any] = {}

        self._module = None
        self._backend = None
        self._infer_fn = None
        self._init_backend()

    def _init_backend(self) -> None:
        try:
            self._module = importlib.import_module(self.module_name)
        except Exception as exc:
            self.reason = f"LWCC module import failed: {exc}"
            return

        backend = None
        try:
            for cls_name in ("LWCC", "CrowdCounter"):
                cls = getattr(self._module, cls_name, None)
                if cls is None:
                    continue
                init_attempts: List[Dict[str, Any]] = []
                if self.model_name:
                    init_attempts.extend(
                        [
                            {"model_path": self.model_name, "device": self.device},
                            {"checkpoint": self.model_name, "device": self.device},
                            {"weights": self.model_name, "device": self.device},
                            {"model_path": self.model_name},
                            {"checkpoint": self.model_name},
                            {"weights": self.model_name},
                        ]
                    )
                init_attempts.append({"device": self.device})
                init_attempts.append({})
                for kwargs in init_attempts:
                    try:
                        backend = cls(**kwargs)
                        break
                    except TypeError:
                        continue
                    except Exception:
                        continue
                if backend is None and self.model_name:
                    try:
                        backend = cls(self.model_name)
                    except Exception:
                        backend = None
                break
            if backend is None:
                loader = getattr(self._module, "load_model", None)
                if callable(loader):
                    if self.model_name:
                        try:
                            backend = loader(self.model_name, device=self.device)
                        except TypeError:
                            try:
                                backend = loader(model_path=self.model_name, device=self.device)
                            except TypeError:
                                backend = loader(self.model_name)
                    else:
                        try:
                            backend = loader(device=self.device)
                        except TypeError:
                            backend = loader()
            if backend is None:
                backend = self._module
        except Exception as exc:
            self.reason = f"LWCC backend init failed: {exc}"
            return

        infer_fn = None
        for fn_name in ("predict", "infer", "forward"):
            fn = getattr(backend, fn_name, None)
            if callable(fn):
                infer_fn = fn
                break
        if infer_fn is None and callable(backend):
            infer_fn = backend

        if infer_fn is None:
            self.reason = "LWCC backend has no callable predict/infer/forward interface"
            return

        self._backend = backend
        self._infer_fn = infer_fn
        self.available = True

    def _run_infer(self, frame_bgr: np.ndarray) -> Any:
        if self._infer_fn is None:
            return None
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        attempts = [
            ((frame_bgr,), {}),
            ((rgb,), {}),
            ((), {"image": frame_bgr}),
            ((), {"image": rgb}),
            ((), {"frame": frame_bgr}),
            ((), {"frame": rgb}),
        ]
        last_exc: Exception | None = None
        for args, kwargs in attempts:
            try:
                return self._infer_fn(*args, **kwargs)
            except TypeError as exc:
                last_exc = exc
                continue
        if last_exc is not None:
            raise last_exc
        return self._infer_fn(frame_bgr)

    def detect_with_aux(self, frame_bgr: np.ndarray) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        if not self.available:
            return [], {}
        if frame_bgr is None or frame_bgr.ndim != 3:
            self.reason = "invalid input frame for LWCC"
            self.available = False
            return [], {}

        frame_h, frame_w = frame_bgr.shape[:2]
        try:
            raw_output = self._run_infer(frame_bgr)
        except Exception as exc:
            self.reason = f"LWCC inference failed: {exc}"
            self.available = False
            return [], {}

        density_map = _extract_density_map(raw_output)
        points = _extract_points(raw_output, frame_w=frame_w, frame_h=frame_h)
        dm_for_points = density_map
        if not points and density_map is not None:
            points, dm_for_points = _points_from_density_map(
                density_map,
                frame_w=frame_w,
                frame_h=frame_h,
                peak_kernel=self.peak_kernel,
                peak_threshold=self.peak_threshold,
                max_heads=self.max_heads,
            )

        count_est = float(len(points))
        if density_map is not None:
            count_est = max(count_est, float(np.maximum(density_map, 0.0).sum()))

        conf_default = float(max(0.01, min(1.0, self.conf_threshold)))
        dm_max = float(dm_for_points.max()) if dm_for_points is not None and dm_for_points.size else 0.0
        head_box = float(max(4.0, self.head_box_size_px))
        person_box = float(max(head_box + 2.0, head_box * 2.6))

        detections: List[Dict[str, Any]] = []
        for cx, cy in points:
            conf = conf_default
            if dm_for_points is not None and dm_for_points.size and dm_max > 1e-8:
                d_h, d_w = dm_for_points.shape[:2]
                xi = int(max(0, min(d_w - 1, round(cx * d_w / max(frame_w, 1)))))
                yi = int(max(0, min(d_h - 1, round(cy * d_h / max(frame_h, 1)))))
                conf = float(max(conf_default, min(1.0, dm_for_points[yi, xi] / dm_max)))

            detections.append(
                {
                    "bbox": _head_bbox(cx, cy, frame_w=frame_w, frame_h=frame_h, box_size_px=head_box),
                    "conf": conf,
                    "label": "head",
                    "classId": -1,
                    "className": "lwcc_head",
                }
            )
            detections.append(
                {
                    "bbox": _head_bbox(cx, cy, frame_w=frame_w, frame_h=frame_h, box_size_px=person_box),
                    "conf": conf,
                    "label": "person",
                    "classId": 0,
                    "className": "lwcc_person_proxy",
                }
            )

        aux: Dict[str, Any] = {
            "density_map": density_map,
            "point_count": int(len(points)),
            "count_estimate": float(count_est),
            "head_points": points,
        }
        self.last_aux = aux
        return detections, aux

    def detect(self, frame_bgr: np.ndarray) -> List[Dict[str, Any]]:
        detections, _aux = self.detect_with_aux(frame_bgr)
        return detections
