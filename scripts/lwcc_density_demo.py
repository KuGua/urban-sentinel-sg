from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]

import sys

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from crowd_counting.lwcc_density import LWCCDensifier


def _draw_overlay(
    frame: np.ndarray,
    result: dict,
    *,
    show_heatmap: bool = True,
    heatmap_alpha: float = 0.35,
) -> np.ndarray:
    out = frame.copy()
    density_map = result["density_map"]
    roi_poly = result["roi_polygon"]

    if show_heatmap:
        heat = np.maximum(np.asarray(density_map, dtype=np.float32), 0.0)
        h, w = out.shape[:2]
        heat = cv2.resize(heat, (w, h), interpolation=cv2.INTER_CUBIC)
        mx = float(heat.max())
        if mx > 1e-8:
            heat_u8 = np.clip((heat / mx) * 255.0, 0.0, 255.0).astype(np.uint8)
            heat_color = cv2.applyColorMap(heat_u8, cv2.COLORMAP_JET)
            a = float(max(0.0, min(1.0, heatmap_alpha)))
            out = cv2.addWeighted(out, 1.0 - a, heat_color, a, 0.0)

    cv2.polylines(out, [roi_poly], isClosed=True, color=(0, 255, 255), thickness=2)

    lines = [
        f"count_total: {float(result['count_total']):.2f}",
        f"crowd_index: {float(result['crowd_index']):.8f}",
        f"roi_count:   {float(result['roi_count']):.2f}",
        f"roi_index:   {float(result['roi_index']):.8f}",
    ]
    line_h = 20
    x0, y0 = 8, 18
    box_h = 8 + len(lines) * line_h
    cv2.rectangle(out, (x0 - 6, y0 - 14), (x0 + 360, y0 - 14 + box_h), (0, 0, 0), -1)
    for i, line in enumerate(lines):
        y = y0 + i * line_h
        cv2.putText(out, line, (x0, y), cv2.FONT_HERSHEY_SIMPLEX, 0.56, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="LWCC density demo for camera/video.")
    p.add_argument("--video", default="", help="Video file path. If empty, use camera.")
    p.add_argument("--camera", type=int, default=0, help="Camera index when --video is empty.")
    p.add_argument("--model-name", default="CSRNet")
    p.add_argument("--model-weights", default="SHA")
    p.add_argument("--roi-factor", type=float, default=0.60, help="Default ROI height ratio in (0,1].")
    p.add_argument("--no-heatmap", action="store_true", help="Disable density heatmap overlay.")
    p.add_argument("--heatmap-alpha", type=float, default=0.35)
    p.add_argument("--max-frames", type=int, default=0)
    p.add_argument("--out-video", default="", help="Optional output mp4 path.")
    p.add_argument("--window-name", default="LWCC Density Demo")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    densifier = LWCCDensifier(
        model_name=args.model_name,
        model_weights=args.model_weights,
        roi_factor=float(args.roi_factor),
    )

    cap = cv2.VideoCapture(args.video if args.video else int(args.camera))
    if not cap.isOpened():
        raise RuntimeError(f"Failed to open source: {args.video or args.camera}")

    writer = None
    if args.out_video:
        out_path = Path(args.out_video)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        fps = cap.get(cv2.CAP_PROP_FPS)
        if not fps or fps <= 0:
            fps = 20.0
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        writer = cv2.VideoWriter(
            str(out_path),
            cv2.VideoWriter_fourcc(*"mp4v"),
            float(fps),
            (w, h),
        )

    cv2.namedWindow(args.window_name, cv2.WINDOW_NORMAL)
    n = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                break

            result = densifier.infer_frame(frame)
            vis = _draw_overlay(
                frame,
                result,
                show_heatmap=not args.no_heatmap,
                heatmap_alpha=float(args.heatmap_alpha),
            )

            if writer is not None:
                writer.write(vis)

            cv2.imshow(args.window_name, vis)
            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord("q")):
                break

            n += 1
            if args.max_frames > 0 and n >= int(args.max_frames):
                break
    finally:
        cap.release()
        if writer is not None:
            writer.release()
        cv2.destroyAllWindows()

    print(f"Processed frames: {n}")


if __name__ == "__main__":
    main()
