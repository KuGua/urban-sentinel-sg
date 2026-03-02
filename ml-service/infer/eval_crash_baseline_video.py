#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import List

import cv2
import joblib
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate crash baseline model on a video and emit per-window scores."
    )
    parser.add_argument("--video", required=True, help="Input video path.")
    parser.add_argument("--model", required=True, help="Path to crash baseline .joblib model.")
    parser.add_argument("--out-jsonl", required=True, help="Output JSONL path.")
    parser.add_argument("--sample-fps", type=float, default=8.0, help="Temporal sampling FPS.")
    parser.add_argument("--window-sec", type=float, default=2.0, help="Window size in seconds.")
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.6,
        help="Probability threshold for crash candidate windows.",
    )
    return parser.parse_args()


def extract_window_features(
    video_path: Path,
    sample_fps: float,
    window_sec: float,
) -> tuple[np.ndarray, List[dict], float]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    src_fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    stride = max(1, int(round(src_fps / max(sample_fps, 0.1))))
    frames_per_window = max(4, int(round(sample_fps * window_sec)))

    features: List[List[float]] = []
    windows: List[dict] = []
    prev_gray = None
    motion_vals: List[float] = []
    bright_vals: List[float] = []
    edge_vals: List[float] = []
    sampled_idx = 0
    src_idx = 0
    window_start_sample = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if src_idx % stride != 0:
            src_idx += 1
            continue

        small = cv2.resize(frame, (320, 180), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gray_f = gray.astype(np.float32)
        if prev_gray is None:
            motion = 0.0
        else:
            motion = float(np.mean(np.abs(gray_f - prev_gray)))
        prev_gray = gray_f

        edges = cv2.Canny(gray, 80, 180)
        edge_density = float(np.count_nonzero(edges)) / float(edges.size)
        brightness = float(np.mean(gray_f))

        motion_vals.append(motion)
        bright_vals.append(brightness)
        edge_vals.append(edge_density)
        sampled_idx += 1

        if len(motion_vals) >= frames_per_window:
            m = np.array(motion_vals, dtype=np.float32)
            b = np.array(bright_vals, dtype=np.float32)
            e = np.array(edge_vals, dtype=np.float32)
            dm = np.diff(m)
            feat = [
                float(np.mean(m)),
                float(np.std(m)),
                float(np.max(m)),
                float(np.percentile(m, 90)),
                float(np.mean(np.abs(dm))) if dm.size else 0.0,
                float(np.max(np.abs(dm))) if dm.size else 0.0,
                float(np.mean(b)),
                float(np.std(b)),
                float(np.mean(e)),
                float(np.std(e)),
            ]
            features.append(feat)

            start_sec = float(window_start_sample) / max(sample_fps, 0.1)
            end_sec = float(sampled_idx) / max(sample_fps, 0.1)
            windows.append(
                {
                    "windowIndex": len(windows),
                    "startSec": start_sec,
                    "endSec": end_sec,
                }
            )

            motion_vals.clear()
            bright_vals.clear()
            edge_vals.clear()
            window_start_sample = sampled_idx

        src_idx += 1

    cap.release()
    if not features:
        raise RuntimeError("No valid windows extracted from video.")
    return np.array(features, dtype=np.float32), windows, src_fps


def main() -> None:
    args = parse_args()
    video = Path(args.video)
    model_path = Path(args.model)
    out_jsonl = Path(args.out_jsonl)
    out_jsonl.parent.mkdir(parents=True, exist_ok=True)

    bundle = joblib.load(model_path)
    model = bundle["model"] if isinstance(bundle, dict) and "model" in bundle else bundle

    feats, windows, src_fps = extract_window_features(
        video_path=video,
        sample_fps=args.sample_fps,
        window_sec=args.window_sec,
    )

    probs = model.predict_proba(feats)[:, 1]
    flags = probs >= float(args.threshold)

    with out_jsonl.open("w", encoding="utf-8") as f:
        for info, p, flag in zip(windows, probs, flags):
            rec = {
                "windowIndex": int(info["windowIndex"]),
                "startSec": float(info["startSec"]),
                "endSec": float(info["endSec"]),
                "crashProb": float(p),
                "isCrashCandidate": bool(flag),
            }
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")

    top_idx = np.argsort(-probs)[: min(5, len(probs))]
    top_windows = [
        {
            "windowIndex": int(windows[i]["windowIndex"]),
            "startSec": float(windows[i]["startSec"]),
            "endSec": float(windows[i]["endSec"]),
            "crashProb": float(probs[i]),
        }
        for i in top_idx
    ]

    summary = {
        "video": str(video),
        "model": str(model_path),
        "videoFps": src_fps,
        "sampleFps": float(args.sample_fps),
        "windowSec": float(args.window_sec),
        "threshold": float(args.threshold),
        "numWindows": int(len(windows)),
        "numCrashCandidates": int(np.sum(flags)),
        "meanCrashProb": float(np.mean(probs)),
        "maxCrashProb": float(np.max(probs)),
        "topWindows": top_windows,
        "outJsonl": str(out_jsonl),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
