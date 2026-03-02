#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import random
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

import cv2
import requests
from ultralytics import YOLO

COCO_VEHICLE_IDS = (1, 2, 3, 5, 7)  # bicycle, car, motorcycle, bus, truck
CUSTOM_VEHICLE_LABELS = ("bicycle", "car", "motorcycle", "bus", "truck")


@dataclass
class CameraImage:
    camera_id: str
    image_url: str
    timestamp: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect Singapore traffic camera images from API and fine-tune vehicle detector."
    )
    parser.add_argument("--api-url", default="https://api.data.gov.sg/v1/transport/traffic-images")
    parser.add_argument("--account-key", default="", help="Optional AccountKey for private endpoints (e.g., LTA DataMall).")
    parser.add_argument("--duration-min", type=float, default=30.0, help="Total collection duration.")
    parser.add_argument("--interval-sec", type=float, default=20.0, help="Polling interval.")
    parser.add_argument("--max-cameras", type=int, default=0, help="Optional max cameras per poll (0 = all).")
    parser.add_argument("--request-timeout-sec", type=float, default=20.0)
    parser.add_argument("--seed-model", default="models/vehicle_best.pt")
    parser.add_argument("--project", default="runs")
    parser.add_argument("--name", default="vehicle_finetune_sg_api")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--device", default="auto", help="auto|cpu|0")
    parser.add_argument("--conf-threshold", type=float, default=0.25)
    parser.add_argument("--val-ratio", type=float, default=0.1)
    parser.add_argument("--min-boxes-per-image", type=int, default=1)
    parser.add_argument("--out-root", default="data/sg_traffic_vehicle")
    parser.add_argument("--random-state", type=int, default=42)
    return parser.parse_args()


def _resolve_device(device: str) -> str | int:
    if device != "auto":
        return int(device) if device.isdigit() else device
    try:
        import torch  # pylint: disable=import-outside-toplevel

        if torch.cuda.is_available():
            return 0
    except Exception:
        pass
    return "cpu"


def _fetch_traffic_images(
    session: requests.Session,
    api_url: str,
    account_key: str,
    timeout_sec: float,
) -> List[CameraImage]:
    headers = {"accept": "application/json"}
    if account_key:
        headers["AccountKey"] = account_key
    resp = session.get(api_url, headers=headers, timeout=timeout_sec)
    resp.raise_for_status()
    payload = resp.json()
    out: List[CameraImage] = []
    if isinstance(payload, dict) and isinstance(payload.get("value"), list):
        # LTA DataMall style: {"value": [{"CameraID","ImageLink","Timestamp",...}, ...]}
        for row in payload["value"]:
            try:
                cam_id = str(row.get("CameraID", "")).strip()
                image_url = str(row.get("ImageLink", "")).strip()
                ts = str(row.get("Timestamp", "")).strip()
                if cam_id and image_url:
                    out.append(CameraImage(camera_id=cam_id, image_url=image_url, timestamp=ts))
            except Exception:
                continue
        return out

    if isinstance(payload, dict) and isinstance(payload.get("items"), list):
        # data.gov.sg style: {"items":[{"timestamp","cameras":[{"camera_id","image",...}, ...]}]}
        for item in payload["items"]:
            ts = str(item.get("timestamp", "")).strip()
            cameras = item.get("cameras", [])
            if not isinstance(cameras, list):
                continue
            for cam in cameras:
                try:
                    cam_id = str(cam.get("camera_id", "")).strip()
                    image_url = str(cam.get("image", "")).strip()
                    if cam_id and image_url:
                        out.append(CameraImage(camera_id=cam_id, image_url=image_url, timestamp=ts))
                except Exception:
                    continue
    return out


def _safe_stem(ts: str, camera_id: str) -> str:
    if ts:
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            tkey = dt.strftime("%Y%m%d_%H%M%S")
        except Exception:
            tkey = ts.replace(":", "").replace("-", "").replace("T", "_").replace("Z", "")
    else:
        tkey = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    return f"{tkey}_{camera_id}"


def _download_images(
    session: requests.Session,
    cameras: Iterable[CameraImage],
    images_dir: Path,
    timeout_sec: float,
) -> List[Path]:
    images_dir.mkdir(parents=True, exist_ok=True)
    saved: List[Path] = []
    for cam in cameras:
        stem = _safe_stem(cam.timestamp, cam.camera_id)
        path = images_dir / f"{stem}.jpg"
        if path.exists():
            continue
        try:
            r = session.get(cam.image_url, timeout=timeout_sec)
            r.raise_for_status()
            path.write_bytes(r.content)
            saved.append(path)
        except Exception:
            continue
    return saved


def _extract_model_names(model: YOLO) -> Dict[int, str]:
    names = getattr(model, "names", {})
    if isinstance(names, dict):
        return {int(k): str(v).strip().lower() for k, v in names.items()}
    if isinstance(names, list):
        return {i: str(v).strip().lower() for i, v in enumerate(names)}
    return {}


def _vehicle_mode(model: YOLO) -> Tuple[List[int], Dict[int, int]]:
    """
    Returns:
      classes_for_predict, class_id_to_custom_id
    """
    names = _extract_model_names(model)
    label_set = set(names.values())
    custom_map = {i: i for i in range(5)}
    if len(names) == 5 and set(CUSTOM_VEHICLE_LABELS) == label_set:
        return [0, 1, 2, 3, 4], custom_map
    coco_to_custom = {1: 0, 2: 1, 3: 2, 5: 3, 7: 4}
    return list(COCO_VEHICLE_IDS), coco_to_custom


def _autolabel_images(
    model: YOLO,
    image_paths: List[Path],
    labels_dir: Path,
    conf_threshold: float,
    min_boxes_per_image: int,
) -> int:
    labels_dir.mkdir(parents=True, exist_ok=True)
    target_classes, cls_to_custom = _vehicle_mode(model)
    kept = 0
    for p in image_paths:
        img = cv2.imread(str(p))
        if img is None:
            continue
        h, w = img.shape[:2]
        out_lines: List[str] = []
        try:
            res = model.predict(source=img, classes=target_classes, conf=conf_threshold, verbose=False)
        except Exception:
            continue
        if res and res[0].boxes is not None and res[0].boxes.xyxy is not None:
            boxes = res[0].boxes.xyxy.detach().cpu().numpy()
            confs = res[0].boxes.conf.detach().cpu().numpy() if res[0].boxes.conf is not None else []
            clss = res[0].boxes.cls.detach().cpu().numpy() if res[0].boxes.cls is not None else []
            for i in range(len(boxes)):
                cid = int(clss[i]) if i < len(clss) else -1
                if cid not in cls_to_custom:
                    continue
                c = float(confs[i]) if i < len(confs) else 0.0
                if c < conf_threshold:
                    continue
                x1, y1, x2, y2 = [float(v) for v in boxes[i].tolist()]
                bw = max(1.0, x2 - x1)
                bh = max(1.0, y2 - y1)
                cx = x1 + bw * 0.5
                cy = y1 + bh * 0.5
                out_lines.append(
                    f"{cls_to_custom[cid]} {cx / w:.6f} {cy / h:.6f} {bw / w:.6f} {bh / h:.6f}"
                )
        if len(out_lines) < min_boxes_per_image:
            continue
        (labels_dir / f"{p.stem}.txt").write_text("\n".join(out_lines), encoding="utf-8")
        kept += 1
    return kept


def _split_dataset(
    images_dir: Path,
    labels_dir: Path,
    out_root: Path,
    val_ratio: float,
    random_state: int,
) -> Tuple[int, int]:
    all_images = sorted(images_dir.glob("*.jpg"))
    pairs: List[Tuple[Path, Path]] = []
    for img in all_images:
        lbl = labels_dir / f"{img.stem}.txt"
        if lbl.exists():
            pairs.append((img, lbl))
    if len(pairs) < 10:
        raise RuntimeError(f"Too few labeled samples for training: {len(pairs)}")

    rng = random.Random(random_state)
    rng.shuffle(pairs)
    n_val = max(1, int(round(len(pairs) * max(0.01, min(0.4, val_ratio)))))
    val_pairs = pairs[:n_val]
    train_pairs = pairs[n_val:]

    for split in ("train", "val"):
        (out_root / "images" / split).mkdir(parents=True, exist_ok=True)
        (out_root / "labels" / split).mkdir(parents=True, exist_ok=True)

    for split, items in (("train", train_pairs), ("val", val_pairs)):
        for img, lbl in items:
            (out_root / "images" / split / img.name).write_bytes(img.read_bytes())
            (out_root / "labels" / split / lbl.name).write_text(lbl.read_text(encoding="utf-8"), encoding="utf-8")

    return len(train_pairs), len(val_pairs)


def _write_data_yaml(out_root: Path) -> Path:
    yml = out_root / "sg_traffic_vehicle.yaml"
    yml.write_text(
        "\n".join(
            [
                f"path: {out_root.resolve().as_posix()}",
                "train: images/train",
                "val: images/val",
                "names:",
                "  0: bicycle",
                "  1: car",
                "  2: motorcycle",
                "  3: bus",
                "  4: truck",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    return yml


def main() -> None:
    args = parse_args()
    account_key = args.account_key.strip()
    if not account_key:
        import os

        account_key = os.getenv("SG_ROADCAM_API_KEY", "").strip()

    out_root = Path(args.out_root)
    raw_images_dir = out_root / "raw_images"
    raw_labels_dir = out_root / "raw_labels"
    out_root.mkdir(parents=True, exist_ok=True)

    model = YOLO(args.seed_model)
    sess = requests.Session()

    deadline = time.time() + max(1.0, args.duration_min * 60.0)
    total_downloaded = 0
    print(
        f"[collect] api={args.api_url} duration_min={args.duration_min} interval_sec={args.interval_sec} "
        f"out={out_root.resolve()}"
    )
    while time.time() < deadline:
        cams = _fetch_traffic_images(
            session=sess,
            api_url=args.api_url,
            account_key=account_key,
            timeout_sec=args.request_timeout_sec,
        )
        if args.max_cameras > 0:
            cams = cams[: args.max_cameras]
        saved = _download_images(
            session=sess,
            cameras=cams,
            images_dir=raw_images_dir,
            timeout_sec=args.request_timeout_sec,
        )
        total_downloaded += len(saved)
        print(f"[collect] cameras={len(cams)} new_images={len(saved)} total_images={total_downloaded}")
        wait_s = max(0.0, args.interval_sec)
        if wait_s <= 0:
            break
        time.sleep(wait_s)

    all_imgs = sorted(raw_images_dir.glob("*.jpg"))
    if len(all_imgs) < 20:
        raise RuntimeError(f"Collected images too few: {len(all_imgs)}")

    kept = _autolabel_images(
        model=model,
        image_paths=all_imgs,
        labels_dir=raw_labels_dir,
        conf_threshold=args.conf_threshold,
        min_boxes_per_image=args.min_boxes_per_image,
    )
    print(f"[label] autolabeled={kept}/{len(all_imgs)}")

    train_n, val_n = _split_dataset(
        images_dir=raw_images_dir,
        labels_dir=raw_labels_dir,
        out_root=out_root,
        val_ratio=args.val_ratio,
        random_state=args.random_state,
    )
    data_yaml = _write_data_yaml(out_root=out_root)
    device = _resolve_device(args.device)
    print(f"[train] device={device} epochs={args.epochs} imgsz={args.imgsz} batch={args.batch}")

    train_model = YOLO(args.seed_model)
    train_model.train(
        data=str(data_yaml),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        project=args.project,
        name=args.name,
        workers=0,
        cache=False,
    )

    summary = {
        "api_url": args.api_url,
        "out_root": str(out_root.resolve()),
        "seed_model": args.seed_model,
        "train_samples": train_n,
        "val_samples": val_n,
        "total_downloaded_images": total_downloaded,
        "autolabeled_images": kept,
        "device": str(device),
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "run_project": args.project,
        "run_name": args.name,
    }
    (out_root / "finetune_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
