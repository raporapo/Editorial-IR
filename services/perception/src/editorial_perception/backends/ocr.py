"""On-screen text.

Optional, and worth having: a shop sign, a station name or a slide title is
often the only place a proper noun appears anywhere in the material, and it is
exactly the thing a user searches for later.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from ..errors import MissingDependency, ModelError


def describe() -> str:
    """The reader's identity, which is its version and not the word "ocr".

    This stage reported the literal string `ocr` as its model, and that string
    went into the perception cache key and into the ModelRun record of a
    document meant to be shared. Two consequences, both silent: upgrading
    rapidocr changed the on-screen text it reads and served the old result from
    cache anyway, and the provenance record named a model that does not exist.

    The weights ship inside the wheel — `ch_PP-OCRv4_det`, `ch_PP-OCRv4_rec` and
    `ch_ppocr_mobile_v2.0_cls`, all PaddleOCR-derived — so the package version is
    exactly the right granularity: it is what changes when they do.
    """
    try:
        from importlib.metadata import PackageNotFoundError, version  # noqa: PLC0415
    except ImportError:  # pragma: no cover - importlib.metadata is stdlib on 3.11
        return "rapidocr"
    try:
        return f"rapidocr-{version('rapidocr-onnxruntime')}"
    except PackageNotFoundError:
        # Importable but not installed as a distribution, which happens in a
        # vendored checkout. The name without a version still beats "ocr".
        return "rapidocr"


def available() -> bool:
    import importlib.util  # noqa: PLC0415

    return importlib.util.find_spec("rapidocr_onnxruntime") is not None


def load():
    try:
        from rapidocr_onnxruntime import RapidOCR  # noqa: PLC0415
    except ImportError as error:
        raise MissingDependency("on-screen text", "rapidocr-onnxruntime") from error
    try:
        return RapidOCR()
    except Exception as error:  # noqa: BLE001
        raise ModelError(f"could not start the text reader: {error}") from error


def read_frames(
    engine,
    path: str,
    timestamps_ms: list[int],
    *,
    frames_dir: str | None = None,
    progress=None,
) -> dict[str, Any]:
    # Never beside the media. The caller normally says where, and when it does
    # not, a scratch directory is the answer — writing a `_frames` folder into
    # somebody's footage directory is the ingest promise ("the original is never
    # modified and never moved") broken one directory at a time, and the files
    # outlive the run.
    if frames_dir:
        work = Path(frames_dir)
        work.mkdir(parents=True, exist_ok=True)
        return _read(engine, path, timestamps_ms, work, progress)

    with tempfile.TemporaryDirectory(prefix="oea-ocr-") as scratch:
        return _read(engine, path, timestamps_ms, Path(scratch), progress)


def _read(engine, path: str, timestamps_ms: list[int], work: Path, progress) -> dict[str, Any]:
    from ..media import extract_frame, image_size  # noqa: PLC0415

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

        # The frame is written at the source resolution, so the divisor is a
        # property of the file the reader was handed, not of the video.
        size = image_size(str(frame_path))

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
                    "bbox": _normalise_box(box, size),
                }
            )

        if progress:
            progress(min(1.0, (index + 1) / max(1, len(timestamps_ms))))

    return {"model": describe(), "observations": observations}


def _normalise_box(box, size: tuple[int, int] | None) -> list[float] | None:
    """The reader's corner points as `[x, y, w, h]` in [0,1].

    The contract says normalised, and this returned raw pixels: the test was
    inverted, so a box already in [0,1] was thrown away and one in pixels was
    passed through and stored as though it were a fraction of the frame. Every
    box in the representation was a number in the wrong units.
    """
    try:
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
    except (TypeError, ValueError, IndexError):
        return None
    if not xs or not ys:
        return None

    left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
    if right > 1 or bottom > 1:
        # Pixels. Without the frame size there is nothing to divide by, and a
        # number nobody can interpret is worse than no number.
        if size is None:
            return None
        width, height = size
        if width <= 0 or height <= 0:
            return None
        left, right = left / width, right / width
        top, bottom = top / height, bottom / height

    left, top = max(0.0, min(1.0, left)), max(0.0, min(1.0, top))
    right, bottom = max(0.0, min(1.0, right)), max(0.0, min(1.0, bottom))
    return [left, top, right - left, bottom - top]
