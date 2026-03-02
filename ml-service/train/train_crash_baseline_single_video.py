#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import List

import cv2
import joblib
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import accuracy_score, f1_score, roc_auc_score
from sklearn.model_selection import train_test_split


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train a weakly-supervised crash baseline model from a single video."
    )
    parser.add_argument("--video", required=True, help="Input crash compilation video path.")
    parser.add_argument("--out-model", required=True, help="Output model .joblib path.")
    parser.add_argument("--out-meta", required=True, help="Output metadata .json path.")
    parser.add_argument("--sample-fps", type=float, default=8.0, help="Temporal sampling FPS.")
    parser.add_argument("--window-sec", type=float, default=2.0, help="Feature window size.")
    parser.add_argument("--max-windows", type=int, default=0, help="Optional cap for windows.")
    parser.add_argument("--random-state", type=int, default=42)
    return parser.parse_args()


def _z(v: np.ndarray) -> np.ndarray:
    m = float(np.mean(v))
    s = float(np.std(v))
    return (v - m) / max(s, 1e-6)


def _extract_window_features(video_path: Path, sample_fps: float, window_sec: float, max_windows: int) -> np.ndarray:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    src_fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    stride = max(1, int(round(src_fps / max(sample_fps, 0.1))))
    frames_per_window = max(4, int(round(sample_fps * window_sec)))

    features: List[List[float]] = []
    prev_gray = None
    motion_vals: List[float] = []
    bright_vals: List[float] = []
    edge_vals: List[float] = []
    sampled_idx = 0
    src_idx = 0

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
                float(np.mean(np.abs(dm))) if dm.size else 0.0,  # motion jerk
                float(np.max(np.abs(dm))) if dm.size else 0.0,
                float(np.mean(b)),
                float(np.std(b)),
                float(np.mean(e)),
                float(np.std(e)),
            ]
            features.append(feat)
            motion_vals.clear()
            bright_vals.clear()
            edge_vals.clear()

            if max_windows > 0 and len(features) >= max_windows:
                break

        src_idx += 1

    cap.release()
    if not features:
        raise RuntimeError("No windows extracted from video.")
    return np.array(features, dtype=np.float32)


def _weak_label(features: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mean_motion = features[:, 0]
    max_motion = features[:, 2]
    jerk_mean = features[:, 4]
    motion_std = features[:, 1]

    score = 0.50 * _z(max_motion) + 0.25 * _z(jerk_mean) + 0.25 * _z(motion_std)
    lo = float(np.quantile(score, 0.40))
    hi = float(np.quantile(score, 0.70))

    y = np.full((len(score),), -1, dtype=np.int32)
    y[score <= lo] = 0
    y[score >= hi] = 1
    keep = y >= 0
    return y, keep


def main() -> None:
    args = parse_args()
    video = Path(args.video)
    out_model = Path(args.out_model)
    out_meta = Path(args.out_meta)
    out_model.parent.mkdir(parents=True, exist_ok=True)
    out_meta.parent.mkdir(parents=True, exist_ok=True)

    feats = _extract_window_features(
        video_path=video,
        sample_fps=args.sample_fps,
        window_sec=args.window_sec,
        max_windows=args.max_windows,
    )
    y_all, keep = _weak_label(feats)
    X = feats[keep]
    y = y_all[keep]

    if len(np.unique(y)) < 2 or len(y) < 20:
        raise RuntimeError("Insufficient labeled windows after weak labeling; need richer video content.")

    X_tr, X_va, y_tr, y_va = train_test_split(
        X, y, test_size=0.25, random_state=args.random_state, stratify=y
    )

    clf = HistGradientBoostingClassifier(
        max_depth=4,
        learning_rate=0.06,
        max_iter=240,
        random_state=args.random_state,
    )
    clf.fit(X_tr, y_tr)
    proba = clf.predict_proba(X_va)[:, 1]
    pred = (proba >= 0.5).astype(np.int32)

    metrics = {
        "val_auc": float(roc_auc_score(y_va, proba)),
        "val_f1": float(f1_score(y_va, pred)),
        "val_acc": float(accuracy_score(y_va, pred)),
    }

    payload = {
        "model_type": "crash_baseline_hgb_single_video",
        "feature_names": [
            "motion_mean",
            "motion_std",
            "motion_max",
            "motion_p90",
            "motion_jerk_mean",
            "motion_jerk_max",
            "brightness_mean",
            "brightness_std",
            "edge_density_mean",
            "edge_density_std",
        ],
        "window_sec": float(args.window_sec),
        "sample_fps": float(args.sample_fps),
    }

    joblib.dump({"model": clf, "meta": payload}, out_model)

    meta = {
        "video": str(video),
        "num_windows_total": int(len(feats)),
        "num_windows_used": int(len(X)),
        "num_negative": int(np.sum(y == 0)),
        "num_positive": int(np.sum(y == 1)),
        "weak_labeling": {"low_quantile": 0.40, "high_quantile": 0.70},
        "metrics": metrics,
        "artifacts": {"model": str(out_model), "meta": str(out_meta)},
    }
    out_meta.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
