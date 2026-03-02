# LWCC Density Wrapper

## Install

```bash
python -m pip install lwcc
```

`lwcc` first run may download pretrained weights (for example `CSRNet_SHA.pth`) into `C:\.lwcc\weights`.

## Module

Path: `crowd_counting/lwcc_density.py`

```python
from crowd_counting.lwcc_density import LWCCDensifier

densifier = LWCCDensifier(model_name="CSRNet", model_weights="SHA", roi_factor=0.6)
result = densifier.infer_frame(frame_bgr)
```

Hybrid mode (LWCC count + YOLO body/head area estimate):

```python
from crowd_counting.lwcc_density import LWCCYoloHybridDensifier

hybrid = LWCCYoloHybridDensifier(
    model_name="CSRNet",
    model_weights="SHA",
    roi_factor=0.6,
    yolo_model="ml-service/models/yolov8n.pt",
    yolo_conf=0.25,
    avg_height_m=1.70,
)
result = hybrid.infer_frame(frame_bgr)
```

Returned fields:

- `count_total`: estimated people count on full frame
- `crowd_index`: `count_total / (frame_width * frame_height)`
- `roi_count`: estimated people count in default ROI
- `roi_index`: `roi_count / roi_pixels`
- `density_map`: LWCC density map resized to frame resolution (sum-preserving)
- `roi_mask`: binary ROI mask
- `roi_polygon`: ROI polygon points
- `frame_shape`: `(h, w)`

Hybrid extra fields:

- `area_m2_est`: estimated ROI area (square meters) from person/body reference
- `lwcc_density_m2`: `lwcc_count_roi / area_m2_est`
- `yolo_people_count_roi`, `yolo_head_count_roi`
- `yolo_people_count_total`, `yolo_head_count_total`
- `yolo_available`, `yolo_reason`

## Default ROI Rule

Default ROI is the lower `roi_factor` portion of the frame:

- `roi_factor=0.6` means bottom 60%
- `roi_y0 = h - h * roi_factor`
- polygon = `[(0, roi_y0), (w, roi_y0), (w, h), (0, h)]`

You can change this with `roi_factor` in `LWCCDensifier(...)`.

## Demo

Path: `scripts/lwcc_density_demo.py`

Camera:

```bash
python scripts/lwcc_density_demo.py --camera 0 --model-name CSRNet --model-weights SHA
```

Video:

```bash
python scripts/lwcc_density_demo.py --video /path/to/video.mp4 --out-video artifacts/lwcc_demo.mp4
```

Useful flags:

- `--roi-factor 0.6`
- `--no-heatmap`
- `--heatmap-alpha 0.35`
- `--max-frames 300`

## Crowd Index Interpretation

`crowd_index` and `roi_index` are normalized by pixels (people per pixel).  
They are best used as trend/anomaly indicators over time for the same camera view.

- Higher value => denser crowd for that view
- Cross-camera comparison needs calibration (different perspective/FOV)
