from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

import numpy as np


@dataclass
class Detection:
    bbox: List[float]  # [x1, y1, x2, y2]
    conf: float


def _resolve_device(device: str | int) -> str | int:
    if isinstance(device, int):
        return device
    if str(device).lower() != "auto":
        return device
    try:
        import torch  # pylint: disable=import-outside-toplevel

        if torch.cuda.is_available():
            return 0
    except Exception:
        pass
    return "cpu"


def _extract_names(model: Any) -> Dict[int, str]:
    raw_names = getattr(model, "names", {})
    if isinstance(raw_names, dict):
        return {int(k): str(v) for k, v in raw_names.items()}
    if isinstance(raw_names, list):
        return {i: str(v) for i, v in enumerate(raw_names)}
    return {}


class YoloV8HeadVehicleDetector:
    """YOLOv8 wrapper for person + vehicle + head-proxy detection."""

    COCO_PERSON_CLASS = 0
    COCO_VEHICLE_CLASSES = (1, 2, 3, 5, 7)  # bicycle, car, motorcycle, bus, truck

    def __init__(
        self,
        model_name: str = "yolov8n.pt",
        conf_threshold: float = 0.25,
        include_person: bool = True,
        include_vehicle: bool = True,
        include_head_proxy: bool = True,
        head_box_height_ratio: float = 0.35,
        head_box_width_ratio: float = 0.60,
        device: str | int = "auto",
    ):
        self.model_name = model_name
        self.conf_threshold = float(conf_threshold)
        self.include_person = bool(include_person)
        self.include_vehicle = bool(include_vehicle)
        self.include_head_proxy = bool(include_head_proxy)
        self.head_box_height_ratio = float(head_box_height_ratio)
        self.head_box_width_ratio = float(head_box_width_ratio)
        self.device = _resolve_device(device)
        self.available = False
        self.reason = ""
        self._model = None

        try:
            from ultralytics import YOLO  # pylint: disable=import-outside-toplevel
        except Exception as exc:  # pragma: no cover
            self.reason = f"ultralytics unavailable: {exc}"
            return

        try:
            self._model = YOLO(model_name)
            self.available = True
        except Exception as exc:  # pragma: no cover
            self.reason = f"model load failed: {exc}"
            self._model = None
            self.available = False

    def _target_classes(self) -> List[int]:
        classes: List[int] = []
        if self.include_person:
            classes.append(self.COCO_PERSON_CLASS)
        if self.include_vehicle:
            classes.extend(self.COCO_VEHICLE_CLASSES)
        return classes

    @staticmethod
    def _vehicle_name(class_id: int) -> str:
        return {
            1: "bicycle",
            2: "car",
            3: "motorcycle",
            5: "bus",
            7: "truck",
        }.get(class_id, "vehicle")

    def _head_bbox_from_person(
        self, bbox: List[float], frame_width: int, frame_height: int
    ) -> List[float]:
        x1, y1, x2, y2 = [float(v) for v in bbox]
        w = max(1.0, x2 - x1)
        h = max(1.0, y2 - y1)
        cx = 0.5 * (x1 + x2)

        head_w = max(4.0, w * self.head_box_width_ratio)
        head_h = max(4.0, h * self.head_box_height_ratio)

        hx1 = max(0.0, cx - 0.5 * head_w)
        hx2 = min(float(frame_width - 1), cx + 0.5 * head_w)
        hy1 = max(0.0, y1)
        hy2 = min(float(frame_height - 1), y1 + head_h)
        return [hx1, hy1, hx2, hy2]

    def detect(self, frame_bgr: np.ndarray) -> List[Dict[str, float | List[float]]]:
        if not self.available or self._model is None:
            return []

        target_classes = self._target_classes()
        if not target_classes:
            return []

        try:
            results = self._model.predict(
                source=frame_bgr,
                device=self.device,
                classes=target_classes,
                conf=self.conf_threshold,
                verbose=False,
            )
        except Exception as exc:  # pragma: no cover
            self.reason = f"inference failed: {exc}"
            self.available = False
            return []

        if not results:
            return []

        parsed: List[Dict[str, float | List[float]]] = []
        boxes = results[0].boxes
        if boxes is None:
            return parsed

        xyxy = boxes.xyxy.cpu().numpy() if boxes.xyxy is not None else np.empty((0, 4))
        confs = boxes.conf.cpu().numpy() if boxes.conf is not None else np.empty((0,))
        classes = boxes.cls.cpu().numpy() if boxes.cls is not None else np.empty((0,))
        frame_h, frame_w = frame_bgr.shape[:2]

        for i in range(len(xyxy)):
            x1, y1, x2, y2 = xyxy[i].tolist()
            conf = float(confs[i]) if i < len(confs) else 0.0
            class_id = int(classes[i]) if i < len(classes) else -1

            label = "unknown"
            class_name = "unknown"
            if class_id == self.COCO_PERSON_CLASS:
                label = "person"
                class_name = "person"
            elif class_id in self.COCO_VEHICLE_CLASSES:
                label = "vehicle"
                class_name = self._vehicle_name(class_id)

            det: Dict[str, float | int | str | List[float]] = {
                "bbox": [x1, y1, x2, y2],
                "conf": conf,
                "label": label,
                "classId": class_id,
                "className": class_name,
            }
            parsed.append(det)

            if self.include_head_proxy and class_id == self.COCO_PERSON_CLASS:
                head_bbox = self._head_bbox_from_person(
                    [x1, y1, x2, y2],
                    frame_width=frame_w,
                    frame_height=frame_h,
                )
                parsed.append(
                    {
                        "bbox": head_bbox,
                        "conf": conf,
                        "label": "head",
                        "classId": -1,
                        "className": "head_proxy",
                    }
                )

        return parsed


class YoloV8SplitHeadVehicleDetector:
    """Two-model detector: person/head and vehicle are inferred by separate YOLO models."""

    COCO_PERSON_CLASS = 0
    COCO_VEHICLE_CLASSES = (1, 2, 3, 5, 7)  # bicycle, car, motorcycle, bus, truck
    CUSTOM_VEHICLE_CLASSES = (0, 1, 2, 3, 4)  # bicycle, car, motorcycle, bus, truck
    REQUIRED_VEHICLE_NAMES = {"bicycle", "car", "motorcycle", "bus", "truck"}

    def __init__(
        self,
        person_model_name: str = "models/yolov8n.pt",
        vehicle_model_name: str = "models/vehicle_best.pt",
        person_conf_threshold: float = 0.25,
        vehicle_conf_threshold: float = 0.25,
        include_head_proxy: bool = True,
        head_box_height_ratio: float = 0.35,
        head_box_width_ratio: float = 0.60,
        device: str | int = "auto",
    ):
        self.person_model_name = person_model_name
        self.vehicle_model_name = vehicle_model_name
        self.person_conf_threshold = float(person_conf_threshold)
        self.vehicle_conf_threshold = float(vehicle_conf_threshold)
        self.include_head_proxy = bool(include_head_proxy)
        self.head_box_height_ratio = float(head_box_height_ratio)
        self.head_box_width_ratio = float(head_box_width_ratio)
        self.device = _resolve_device(device)
        self.available = False
        self.reason = ""

        self._person_model = None
        self._vehicle_model = None
        self._vehicle_target_classes: List[int] = list(self.CUSTOM_VEHICLE_CLASSES)
        self._vehicle_names: Dict[int, str] = {
            0: "bicycle",
            1: "car",
            2: "motorcycle",
            3: "bus",
            4: "truck",
        }

        reasons: List[str] = []
        try:
            from ultralytics import YOLO  # pylint: disable=import-outside-toplevel
        except Exception as exc:  # pragma: no cover
            self.reason = f"ultralytics unavailable: {exc}"
            return

        try:
            self._person_model = YOLO(person_model_name)
        except Exception as exc:  # pragma: no cover
            reasons.append(f"person model load failed: {exc}")

        try:
            self._vehicle_model = YOLO(vehicle_model_name)
            self._configure_vehicle_model()
        except Exception as exc:  # pragma: no cover
            reasons.append(f"vehicle model load failed: {exc}")

        self.available = (self._person_model is not None) or (self._vehicle_model is not None)
        self.reason = "; ".join(reasons)

    def _configure_vehicle_model(self) -> None:
        if self._vehicle_model is None:
            return
        names = _extract_names(self._vehicle_model)
        names_lower = {int(k): str(v).strip().lower() for k, v in names.items()}
        model_labels = set(names_lower.values())
        is_custom_vehicle_5 = (
            len(names_lower) == 5 and model_labels == self.REQUIRED_VEHICLE_NAMES
        )
        if is_custom_vehicle_5:
            self._vehicle_target_classes = list(self.CUSTOM_VEHICLE_CLASSES)
            self._vehicle_names = {k: names_lower.get(k, "vehicle") for k in self.CUSTOM_VEHICLE_CLASSES}
            return

        # Fallback to COCO class ids on general YOLO models.
        self._vehicle_target_classes = list(self.COCO_VEHICLE_CLASSES)
        default_coco_names = {
            1: "bicycle",
            2: "car",
            3: "motorcycle",
            5: "bus",
            7: "truck",
        }
        self._vehicle_names = {
            cid: names_lower.get(cid, default_coco_names[cid]) for cid in self.COCO_VEHICLE_CLASSES
        }

    def _head_bbox_from_person(
        self, bbox: List[float], frame_width: int, frame_height: int
    ) -> List[float]:
        x1, y1, x2, y2 = [float(v) for v in bbox]
        w = max(1.0, x2 - x1)
        h = max(1.0, y2 - y1)
        cx = 0.5 * (x1 + x2)

        head_w = max(4.0, w * self.head_box_width_ratio)
        head_h = max(4.0, h * self.head_box_height_ratio)

        hx1 = max(0.0, cx - 0.5 * head_w)
        hx2 = min(float(frame_width - 1), cx + 0.5 * head_w)
        hy1 = max(0.0, y1)
        hy2 = min(float(frame_height - 1), y1 + head_h)
        return [hx1, hy1, hx2, hy2]

    def _predict(self, model: Any, classes: List[int], conf: float, frame_bgr: np.ndarray) -> List[Dict[str, Any]]:
        try:
            results = model.predict(
                source=frame_bgr,
                device=self.device,
                classes=classes,
                conf=conf,
                verbose=False,
            )
        except Exception as exc:  # pragma: no cover
            if self.reason:
                self.reason += "; "
            self.reason += f"inference failed: {exc}"
            return []
        if not results:
            return []

        boxes = results[0].boxes
        if boxes is None:
            return []

        xyxy = boxes.xyxy.cpu().numpy() if boxes.xyxy is not None else np.empty((0, 4))
        confs = boxes.conf.cpu().numpy() if boxes.conf is not None else np.empty((0,))
        classes_arr = boxes.cls.cpu().numpy() if boxes.cls is not None else np.empty((0,))

        parsed: List[Dict[str, Any]] = []
        for i in range(len(xyxy)):
            x1, y1, x2, y2 = [float(v) for v in xyxy[i].tolist()]
            conf_i = float(confs[i]) if i < len(confs) else 0.0
            cls_i = int(classes_arr[i]) if i < len(classes_arr) else -1
            parsed.append({"bbox": [x1, y1, x2, y2], "conf": conf_i, "classId": cls_i})
        return parsed

    def detect(self, frame_bgr: np.ndarray) -> List[Dict[str, float | int | str | List[float]]]:
        if not self.available:
            return []

        frame_h, frame_w = frame_bgr.shape[:2]
        out: List[Dict[str, float | int | str | List[float]]] = []

        if self._person_model is not None:
            person_dets = self._predict(
                model=self._person_model,
                classes=[self.COCO_PERSON_CLASS],
                conf=self.person_conf_threshold,
                frame_bgr=frame_bgr,
            )
            for det in person_dets:
                bbox = det["bbox"]
                conf = float(det["conf"])
                out.append(
                    {
                        "bbox": bbox,
                        "conf": conf,
                        "label": "person",
                        "classId": self.COCO_PERSON_CLASS,
                        "className": "person",
                    }
                )
                if self.include_head_proxy:
                    head_bbox = self._head_bbox_from_person(
                        bbox, frame_width=frame_w, frame_height=frame_h
                    )
                    out.append(
                        {
                            "bbox": head_bbox,
                            "conf": conf,
                            "label": "head",
                            "classId": -1,
                            "className": "head_proxy",
                        }
                    )

        if self._vehicle_model is not None:
            vehicle_dets = self._predict(
                model=self._vehicle_model,
                classes=self._vehicle_target_classes,
                conf=self.vehicle_conf_threshold,
                frame_bgr=frame_bgr,
            )
            for det in vehicle_dets:
                cid = int(det["classId"])
                out.append(
                    {
                        "bbox": det["bbox"],
                        "conf": float(det["conf"]),
                        "label": "vehicle",
                        "classId": cid,
                        "className": self._vehicle_names.get(cid, "vehicle"),
                    }
                )

        return out


class YoloV8PersonDetector(YoloV8HeadVehicleDetector):
    """Backward-compatible detector that only returns person boxes."""

    def __init__(
        self,
        model_name: str = "yolov8n.pt",
        conf_threshold: float = 0.25,
        device: str | int = "auto",
    ):
        super().__init__(
            model_name=model_name,
            conf_threshold=conf_threshold,
            include_person=True,
            include_vehicle=False,
            include_head_proxy=False,
            device=device,
        )
