"""On-screen text.

Optional, and worth having: a shop sign, a station name or a slide title is
often the only place a proper noun appears anywhere in the material, and it is
exactly the thing a user searches for later.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..errors import MissingDependency, ModelError


def load():
    try:
        from rapidocr_onnxruntime import RapidOCR  # noqa: PLC0415
    except ImportError as error:
        raise MissingDependency("on-screen text", "rapidocr-onnxruntime") from error
    try:
        return RapidOCR()
    except Exception as error:  # noqa: BLE001
        raise ModelError(f"could not start the text reader: {error}") from error


def read_frames(engine, path: str, timestamps_ms: list[int], *, frames_dir: str | None = None, progress=None) -> dict[str, Any]:
    from ..media import extract_frame  # noqa: PLC0415

    work = Path(frames_dir) if frames_dir else Path(path).parent / "_frames"
    work.mkdir(parents=True, exist_ok=True)

    observations: list[dict[str, Any]] = []
    for index, timestamp in enumerate(timestamps_ms):
        frame_path = work / f"{timestamp:08d}.jpg"
        if not frame_path.exists():
            try:
                extract_frame(path, timestamp, str(frame_path))
            except Exception:  # noqa: BLE001
                continue

        try:
            result, _ = engine(str(frame_path))
        except Exception:  # noqa: BLE001 - one unreadable frame is not fatal
            continue

        for entry in result or []:
            box, text, score = entry[0], entry[1], entry[2]
            cleaned = (text or "").strip()
            # Below this the reader is inventing characters, and a wrong proper
            # noun in the index is worse than a missing one.
            if len(cleaned) < 2 or float(score) < 0.5:
                continue
            observations.append(
                {
                    "start_ms": timestamp,
                    # On-screen text persists; a second either side is a
                    # reasonable assumption without tracking it across frames.
                    "end_ms": timestamp + 1000,
                    "text": cleaned,
                    "confidence": float(score),
                    "bbox": _normalise_box(box),
                }
            )

        if progress:
            progress(min(1.0, (index + 1) / max(1, len(timestamps_ms))))

    return {"model": "rapidocr", "observations": observations}


def _normalise_box(box) -> list[float] | None:
    try:
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
    except (TypeError, ValueError, IndexError):
        return None
    # Pixel coordinates are useless to a consumer that does not know the frame
    # size, so they are left out unless they can be normalised.
    return None if max(xs) <= 1 and max(ys) <= 1 else [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]
