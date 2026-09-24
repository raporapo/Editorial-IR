"""How much the picture moves, and where it is black.

The same algorithm as the TypeScript implementation
(packages/perception/src/ffmpeg/video.ts), deliberately and down to the
rounding: which runtime measured the footage is a deployment detail, and the
analysis must not change because Python happened to be installed.

Its only job is to tell the expensive stages where there is nothing to look
at, so it is cheap — a 64x36 greyscale decode at five samples a second — and it
fails towards "moving": a moment wrongly called still loses content, one wrongly
called moving costs a few tokens.

- The downscale separates grain from motion. Sensor noise is independent per
  pixel and averages away over a 30x30 block; a person does not.
- The largest cell of a 3x4 grid, not the frame mean, so a person crossing one
  corner of a wide shot still counts.
- The 98th-percentile luma for black, not the mean, so a city at night is not
  black.
"""

from __future__ import annotations

import math
import os
import subprocess
import tempfile
from typing import Any

from ..errors import MediaError

WIDTH = 64
HEIGHT = 36
GRID_ROWS = 3
GRID_COLS = 4
MODEL = "cell-max-64x36"


def motion_args(path: str, fps: float, output: str) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-v",
        "error",
        "-i",
        path,
        "-an",
        "-sn",
        "-dn",
        "-vf",
        f"fps={_number(fps)},scale={WIDTH}:{HEIGHT}:flags=area,format=gray",
        "-f",
        "rawvideo",
        "-y",
        output,
    ]


def analyze(
    path: str,
    sample_fps: float = 5.0,
    static_threshold: float = 0.5,
    min_static_ms: int = 3000,
    black_luma: float = 24.0,
    min_black_ms: int = 500,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="oea-motion-") as scratch:
        out = os.path.join(scratch, "samples.gray")
        completed = subprocess.run(
            motion_args(path, sample_fps, out), capture_output=True, text=True, check=False
        )
        if completed.returncode != 0:
            raise MediaError(
                "ffmpeg could not decode the picture",
                path=path,
                stderr=completed.stderr[-2000:],
            )
        try:
            with open(out, "rb") as handle:
                samples = handle.read()
        except FileNotFoundError:
            samples = b""
    return analyse_samples(
        samples,
        sample_fps=sample_fps,
        static_threshold=static_threshold,
        min_static_ms=min_static_ms,
        black_luma=black_luma,
        min_black_ms=min_black_ms,
    )


def analyse_samples(
    samples: bytes,
    *,
    sample_fps: float = 5.0,
    static_threshold: float = 0.5,
    min_static_ms: int = 3000,
    black_luma: float = 24.0,
    min_black_ms: int = 500,
) -> dict[str, Any]:
    """The whole decision surface, on the bytes ffmpeg's rawvideo writes."""
    size = WIDTH * HEIGHT
    count = len(samples) // size
    hop_ms = max(1, _js_round(1000 / sample_fps))

    motion: list[float] = []
    luma: list[float] = []
    peak: list[int] = []
    previous: bytes | None = None
    for i in range(count):
        frame = samples[i * size : (i + 1) * size]
        mean, p98 = _luma(frame)
        luma.append(_round(mean, 2))
        peak.append(p98)
        motion.append(0.0 if previous is None else _round(cell_max_difference(previous, frame), 3))
        previous = frame
    # The first sample has nothing to differ from: give it its successor's value
    # rather than zero, so a file never opens with a fabricated moment of stillness.
    if len(motion) > 1:
        motion[0] = motion[1]

    events: list[dict[str, Any]] = []
    for start, end in _runs([m < static_threshold for m in motion]):
        start_ms, end_ms = start * hop_ms, end * hop_ms
        if end_ms - start_ms < min_static_ms:
            continue
        run = motion[start:end]
        mean = sum(run) / len(run)
        events.append(
            {
                "start_ms": start_ms,
                "end_ms": end_ms,
                "event_type": "static",
                "confidence": _round(min(0.95, max(0.5, 1 - mean / static_threshold)), 3),
            }
        )
    for start, end in _runs([p < black_luma for p in peak]):
        start_ms, end_ms = start * hop_ms, end * hop_ms
        if end_ms - start_ms < min_black_ms:
            continue
        events.append(
            {"start_ms": start_ms, "end_ms": end_ms, "event_type": "black", "confidence": 0.9}
        )
    events.sort(key=lambda e: (e["start_ms"], e["event_type"]))

    return {"model": MODEL, "hop_ms": hop_ms, "motion": motion, "luma": luma, "events": events}


def cell_max_difference(previous: bytes, current: bytes) -> float:
    """Largest mean absolute difference of any grid cell, in grey levels."""
    cell_w = WIDTH // GRID_COLS
    cell_h = HEIGHT // GRID_ROWS
    largest = 0.0
    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            total = 0
            for y in range(row * cell_h, (row + 1) * cell_h):
                offset = y * WIDTH + col * cell_w
                a = previous[offset : offset + cell_w]
                b = current[offset : offset + cell_w]
                total += sum(abs(x - z) for x, z in zip(a, b, strict=True))
            largest = max(largest, total / (cell_w * cell_h))
    return largest


def _luma(frame: bytes) -> tuple[float, int]:
    histogram = [0] * 256
    for value in frame:
        histogram[value] += 1
    target = math.ceil(len(frame) * 0.98)
    seen = 0
    p98 = 255
    for value, n in enumerate(histogram):
        seen += n
        if seen >= target:
            p98 = value
            break
    return (sum(frame) / len(frame) if frame else 0.0), p98


def _runs(flags: list[bool]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    start = -1
    for i, on in enumerate([*flags, False]):
        if on and start < 0:
            start = i
        if not on and start >= 0:
            out.append((start, i))
            start = -1
    return out


def _js_round(value: float) -> int:
    """JavaScript's Math.round, which rounds halves up where Python's rounds to even."""
    return math.floor(value + 0.5)


def _round(value: float, digits: int) -> float:
    scale = 10**digits
    return math.floor(value * scale + 0.5) / scale


def _number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)
