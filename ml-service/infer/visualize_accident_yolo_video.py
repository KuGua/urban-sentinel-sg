#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List

import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Visualize accident probability on video using a YOLO accident detector."
    )
    parser.add_argument("--video", required=True)
    parser.add_argument("--model", default=str(PROJECT_ROOT / "models" / "accident_yolov8_best.pt"))
    parser.add_argument("--out-video", required=True)
    parser.add_argument("--out-jsonl", required=True)
    parser.add_argument("--max-seconds", type=float, default=60.0)
    parser.add_argument("--detect-every", type=int, default=1)
    parser.add_argument("--window-sec", type=float, default=0.2)
    parser.add_argument("--conf-threshold", type=float, default=0.25)
    parser.add_argument(
        "--alarm-threshold",
        type=float,
        default=0.60,
        help="Threshold for marking high accident risk in overlay and jsonl.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        help="Inference device: auto|cpu|0. auto uses CUDA GPU if available.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    from ultralytics import YOLO  # pylint: disable=import-outside-toplevel

    video_path = Path(args.video)
    out_video = Path(args.out_video)
    out_jsonl = Path(args.out_jsonl)
    out_video.parent.mkdir(parents=True, exist_ok=True)
    out_jsonl.parent.mkdir(parents=True, exist_ok=True)

    device = _resolve_device(args.device)
    model = YOLO(str(args.model))

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    max_frames = int(round(max(args.max_seconds, 0.0) * fps))
    window_frames = max(1, int(round(max(args.window_sec, 0.1) * fps)))

    writer = cv2.VideoWriter(
        str(out_video),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )

    window_probs: List[float] = []
    window_idx = 0
    frame_idx = 0
    last_prob = 0.0
    pending_window_scores: List[float] = []

    with out_jsonl.open("w", encoding="utf-8") as jf:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if max_frames > 0 and frame_idx >= max_frames:
                break

            if frame_idx % max(1, args.detect_every) == 0:
                res = model.predict(
                    source=frame,
                    conf=float(args.conf_threshold),
                    device=device,
                    verbose=False,
                )
                boxes = res[0].boxes if res else None
                if boxes is not None and boxes.conf is not None and len(boxes.conf) > 0:
                    confs = boxes.conf.detach().cpu().numpy().astype(np.float32)
                    last_prob = float(np.max(confs))
                else:
                    last_prob = 0.0

            pending_window_scores.append(last_prob)
            is_boundary = ((frame_idx + 1) % window_frames == 0)
            if is_boundary:
                win_prob = float(np.max(np.array(pending_window_scores, dtype=np.float32)))
                pending_window_scores.clear()
                window_probs.append(win_prob)
                start_sec = float(window_idx * args.window_sec)
                end_sec = min(float((window_idx + 1) * args.window_sec), float((frame_idx + 1) / fps))
                rec = {
                    "windowIndex": int(window_idx),
                    "startSec": start_sec,
                    "endSec": end_sec,
                    "accidentProb": win_prob,
                    "isCrashCandidate": bool(win_prob >= args.alarm_threshold),
                }
                jf.write(json.dumps(rec, separators=(",", ":")) + "\n")
                window_idx += 1

            cur_win = min(int(frame_idx // window_frames), max(0, len(window_probs) - 1))
            cur_prob = window_probs[cur_win] if window_probs else last_prob
            color = (0, 255, 0) if cur_prob < args.alarm_threshold else (0, 0, 255)

            cv2.rectangle(frame, (0, 0), (760, 86), (0, 0, 0), -1)
            t_sec = frame_idx / max(fps, 1e-6)
            cv2.putText(
                frame,
                f"time: {t_sec:06.2f}s  window: {cur_win:02d}",
                (12, 30),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (255, 255, 255),
                2,
                cv2.LINE_AA,
            )
            cv2.putText(
                frame,
                f"accident_prob: {cur_prob:.3f}",
                (12, 65),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.95,
                color,
                2,
                cv2.LINE_AA,
            )
            bar_x, bar_y, bar_w, bar_h = 430, 48, 300, 18
            cv2.rectangle(frame, (bar_x, bar_y), (bar_x + bar_w, bar_y + bar_h), (120, 120, 120), 2)
            fill = int(round(np.clip(cur_prob, 0.0, 1.0) * bar_w))
            cv2.rectangle(frame, (bar_x + 1, bar_y + 1), (bar_x + fill, bar_y + bar_h - 1), color, -1)

            writer.write(frame)
            frame_idx += 1

        if pending_window_scores:
            win_prob = float(np.max(np.array(pending_window_scores, dtype=np.float32)))
            start_sec = float(window_idx * args.window_sec)
            end_sec = float(frame_idx / max(fps, 1e-6))
            rec = {
                "windowIndex": int(window_idx),
                "startSec": start_sec,
                "endSec": end_sec,
                "accidentProb": win_prob,
                "isCrashCandidate": bool(win_prob >= args.alarm_threshold),
            }
            jf.write(json.dumps(rec, separators=(",", ":")) + "\n")
            window_probs.append(win_prob)

    cap.release()
    writer.release()

    summary = {
        "video": str(video_path),
        "model": str(args.model),
        "device": str(device),
        "outVideo": str(out_video),
        "outJsonl": str(out_jsonl),
        "framesRendered": int(frame_idx),
        "secondsRendered": float(frame_idx / max(fps, 1e-6)),
        "windows": int(len(window_probs)),
        "maxProb": float(np.max(window_probs) if window_probs else 0.0),
        "meanProb": float(np.mean(window_probs) if window_probs else 0.0),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
