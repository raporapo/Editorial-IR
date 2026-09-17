"""Everything that is ffmpeg's job.

Reimplementing container parsing or decoding in Python would be slower and
wrong, so this module is a careful wrapper and nothing more. It is also the only
part of the worker with no optional dependency: a machine with ffmpeg can always
probe and prepare, whatever else is missing.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .errors import MediaError

AUDIO_SAMPLE_RATE = 16_000


def has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def has_ffprobe() -> bool:
    return shutil.which("ffprobe") is not None


def _run(
    command: list[str], *, timeout: int = 3600, allow_failure: bool = False
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(  # noqa: S603 - the command is built here, not by a caller
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as error:
        raise MediaError(f"{command[0]} is not installed") from error
    except subprocess.TimeoutExpired as error:
        raise MediaError(f"{command[0]} timed out after {timeout}s") from error

    if result.returncode != 0 and not allow_failure:
        raise MediaError(
            f"{command[0]} failed",
            returncode=result.returncode,
            stderr=result.stderr[-2000:],
        )
    return result


def probe(path: str) -> dict[str, Any]:
    """Container metadata, mapped onto the ProbeResult contract."""
    if not Path(path).exists():
        raise MediaError(f"no file at {path}", path=path)

    result = _run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
        timeout=120,
    )
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise MediaError("ffprobe returned output that is not JSON", path=path) from error

    streams = parsed.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = parsed.get("format") or {}

    duration = (
        _float(fmt.get("duration"))
        or _float((video or {}).get("duration"))
        or _float((audio or {}).get("duration"))
        or 0.0
    )

    out: dict[str, Any] = {
        "duration_ms": max(0, round(duration * 1000)),
        "metadata": {**(fmt.get("tags") or {}), **((video or {}).get("tags") or {})},
    }

    if video:
        if video.get("width"):
            out["width"] = int(video["width"])
        if video.get("height"):
            out["height"] = int(video["height"])
        rational = _rational(video.get("avg_frame_rate") or video.get("r_frame_rate"))
        if rational:
            out["fps_num"], out["fps_den"] = rational
        if video.get("codec_name"):
            out["video_codec"] = video["codec_name"]
        rotation = _rotation(video)
        if rotation is not None:
            out["rotation"] = rotation

    if audio:
        if audio.get("codec_name"):
            out["audio_codec"] = audio["codec_name"]
        if audio.get("channels"):
            out["audio_channels"] = int(audio["channels"])
        if audio.get("sample_rate"):
            out["audio_sample_rate"] = int(audio["sample_rate"])

    if fmt.get("format_name"):
        out["container"] = fmt["format_name"]
    if fmt.get("bit_rate"):
        out["bit_rate"] = int(_float(fmt["bit_rate"]) or 0)

    creation = out["metadata"].get("creation_time") or out["metadata"].get("date")
    if creation:
        out["creation_time"] = creation

    return out


def prepare(
    path: str,
    work_dir: str,
    *,
    proxy_height: int = 480,
    extract_audio: bool = True,
    frame_fps: float = 1.0,
    crf: int = 28,
) -> dict[str, Any]:
    """Produces the derivatives everything downstream reads.

    Regenerable from the original, so the working directory is always safe to
    delete, and existing files are reused so an interrupted run does not start
    from nothing.
    """
    if not Path(path).exists():
        raise MediaError(f"no file at {path}", path=path)

    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {"frame_timestamps_ms": []}

    if proxy_height > 0:
        proxy = work / "proxy.mp4"
        if not proxy.exists():
            _run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    path,
                    # -2 keeps the width even, which h264 requires.
                    "-vf",
                    f"scale=-2:{proxy_height}",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    str(crf),
                    "-an",
                    "-movflags",
                    "+faststart",
                    str(proxy),
                ]
            )
        result["proxy_path"] = str(proxy)

    if extract_audio:
        audio = work / "audio.wav"
        if not audio.exists():
            _run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    path,
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    str(AUDIO_SAMPLE_RATE),
                    "-c:a",
                    "pcm_s16le",
                    str(audio),
                ]
            )
        result["audio_path"] = str(audio)

    if frame_fps > 0:
        frames = work / "frames"
        frames.mkdir(parents=True, exist_ok=True)
        if not any(frames.iterdir()):
            _run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    path,
                    "-vf",
                    f"fps={frame_fps}",
                    "-q:v",
                    "4",
                    str(frames / "%08d.jpg"),
                ]
            )
        result["frames_dir"] = str(frames)
        count = len(list(frames.glob("*.jpg")))
        result["frame_timestamps_ms"] = [round(i * 1000 / frame_fps) for i in range(count)]

    return result


# The contract's `threshold` is a *sensitivity* in [0,1], and the two backends
# measure content change on scales that have nothing to do with each other:
# ffmpeg's `scene` is roughly [0,1], PySceneDetect's ContentDetector is a mean
# HSV difference on a 0-255 scale whose own default is 27. Passing the same
# number to both meant the same request produced different shots depending on
# what happened to be installed — and the project's own rule is that which
# backend runs is a deployment detail.
#
# These two constants are that calibration. At the default sensitivity they give
# each backend a value that detects the same cuts.
# Each maps the default sensitivity onto a value that backend's own authors
# consider normal: 0.05 for ffmpeg's `scene`, and 27 for ContentDetector, which
# is PySceneDetect's documented default.
FFMPEG_SCALE = 1 / 3
PYSCENE_SCALE = 180


def detect_shots(path: str, threshold: float = 0.15, min_shot_ms: int = 800) -> dict[str, Any]:
    """Shot boundaries from ffmpeg's own scene metric.

    PySceneDetect is better and is a heavy dependency; ffmpeg is already here.
    When PySceneDetect is installed it is used instead, because the difference in
    boundary quality is worth having when the cost is already paid.

    ## Why the default moved from 0.3 to 0.15

    0.3 found nothing. Measured on twelve minutes of multi-scene footage with
    thirteen hard cuts: ffmpeg returned **one shot per file** and PySceneDetect
    returned **none at all**, and the effect downstream was one event per asset —
    a five-minute recording compiled into a single 253-second "moment". The whole
    pipeline reads shot boundaries, so under-detection here is not a small loss
    of resolution, it is the segmentation layer having nothing to work with.

    The scores say why. At the three true cuts in one file the metric read
    0.195, 0.123 and similar; everywhere else it sat at 0.010-0.024. So the
    separation is clean and roughly ten to one — and the old default sat above
    every real cut.

    ## Why erring sensitive is the right direction here

    A shot boundary is a *candidate* for an event boundary, not an event. The
    segmentation layer merges shots that belong together, so an extra boundary
    costs a merge; a missing one cannot be recovered by anything downstream.
    `min_shot_ms` bounds the over-segmentation, and the asymmetry does the rest.

    ## What is still open

    On the footage measured here the two backends still disagree — ffmpeg finds
    4/5/3 cuts against a truth of 4/5/4, PySceneDetect fewer. That footage is
    flat colour fields with synthetic grain, which is adversarial for a mean-HSV
    metric and not representative of a camera, so the numbers are not tuned to
    make it agree: tuning a default on a fixture like that would trade a
    measurable problem for an unmeasurable one. The honest instrument for this
    is real footage, and until there is some, `oea analyze` reports when an
    asset comes back as a single shot over several minutes so the case shows up
    where it can actually be judged.
    """
    try:
        return _detect_shots_pyscenedetect(path, threshold, min_shot_ms)
    except ImportError:
        pass

    result = _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-i",
            path,
            "-filter:v",
            f"select='gt(scene,{threshold * FFMPEG_SCALE})',showinfo",
            "-an",
            "-f",
            "null",
            "-",
        ],
        allow_failure=True,
    )
    boundaries = _parse_showinfo(result.stderr)
    duration_ms = probe(path)["duration_ms"]
    return {"model": "ffmpeg-scene", "shots": build_shots(boundaries, duration_ms, min_shot_ms)}


def _detect_shots_pyscenedetect(path: str, threshold: float, min_shot_ms: int) -> dict[str, Any]:
    from scenedetect import ContentDetector, detect  # noqa: PLC0415

    scenes = detect(path, ContentDetector(threshold=threshold * PYSCENE_SCALE))
    # No cuts is one shot, not no shots.
    #
    # PySceneDetect returns an empty list for a video it found no boundaries in,
    # meaning "the whole thing is one scene". Passing that straight through gave
    # a file with *zero* shots, while the ffmpeg path synthesised a whole-file
    # shot from the same finding — so a continuous take had shots or did not
    # depending on which backend was installed, and everything downstream that
    # counts shots saw a different number.
    if not scenes:
        return {
            "model": "pyscenedetect",
            "shots": build_shots([], probe(path)["duration_ms"], min_shot_ms),
        }
    shots = []
    for start, end in scenes:
        start_ms = round(start.get_seconds() * 1000)
        end_ms = round(end.get_seconds() * 1000)
        if end_ms - start_ms < min_shot_ms:
            continue
        shots.append(
            {
                "start_ms": start_ms,
                "end_ms": end_ms,
                # A third of the way in: past the transition, before the camera
                # moves on.
                "representative_frame_ms": start_ms + (end_ms - start_ms) // 3,
            }
        )
    return {"model": "pyscenedetect-content", "shots": shots}


def build_shots(boundary_ms: list[int], duration_ms: int, min_shot_ms: int) -> list[dict[str, Any]]:
    """Turns boundary instants into contiguous shots.

    Boundaries closer together than the minimum are dropped rather than kept as
    slivers: a two hundred millisecond shot is a flash frame or a compression
    artefact, and carrying it forward poisons the segmentation that reads shot
    counts.
    """
    cuts = [0] + sorted(t for t in boundary_ms if 0 < t < (duration_ms or t + 1))
    kept: list[int] = []
    for cut in cuts:
        if not kept or cut - kept[-1] >= min_shot_ms:
            kept.append(cut)

    end = duration_ms if duration_ms > 0 else (kept[-1] if kept else 0) + min_shot_ms
    shots = []
    for index, start in enumerate(kept):
        stop = kept[index + 1] if index + 1 < len(kept) else end
        if stop <= start:
            continue
        shots.append(
            {
                "start_ms": start,
                "end_ms": stop,
                "representative_frame_ms": start + (stop - start) // 3,
            }
        )
    return shots


def _parse_showinfo(stderr: str) -> list[int]:
    times: list[int] = []
    for part in stderr.split("pts_time:")[1:]:
        token = ""
        for char in part:
            if char.isdigit() or char == ".":
                token += char
            else:
                break
        try:
            times.append(round(float(token) * 1000))
        except ValueError:
            continue
    return times


def decode_pcm(path: str, sample_rate: int = 16000):
    """Mono float32 samples in [-1, 1], straight from ffmpeg.

    Reads from whatever the path is — an extracted wav or the original video —
    without writing an intermediate file, because the caller already has one
    temporary directory's worth of derivatives and does not need another.

    Returns an empty array for a file with no audio, which is a real case (a
    phone clip with the mic muted) and not an error: the stage that asked has
    nothing to say about it, and the analysis carries on.
    """
    import numpy as np  # noqa: PLC0415

    if not has_ffmpeg():
        raise MediaError("ffmpeg is needed to read audio")
    result = subprocess.run(  # noqa: S603
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            path,
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-",
        ],
        check=False,
        capture_output=True,
    )
    if result.returncode != 0 and not result.stdout:
        raise MediaError(f"could not read audio from {path}: {result.stderr.decode()[:200]}")
    # int16 is what was asked for; the models want float in [-1, 1].
    return np.frombuffer(result.stdout, np.int16).astype(np.float32) / 32768.0


def extract_frame(path: str, timestamp_ms: int, out_path: str) -> str:
    """Pulls one frame, for a model that wants a specific moment."""
    _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{timestamp_ms / 1000:.3f}",
            "-i",
            path,
            "-frames:v",
            "1",
            "-q:v",
            "3",
            out_path,
        ],
        timeout=120,
    )
    return out_path


def _float(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _rational(value: object) -> tuple[int, int] | None:
    if not isinstance(value, str) or "/" not in value:
        parsed = _float(value)
        return (round(parsed), 1) if parsed else None
    num, _, den = value.partition("/")
    try:
        numerator, denominator = int(num), int(den)
    except ValueError:
        return None
    if numerator == 0 or denominator == 0:
        return None
    return (numerator, denominator)


def _rotation(video: dict[str, Any]) -> int | None:
    for side in video.get("side_data_list") or []:
        if isinstance(side, dict) and side.get("rotation") is not None:
            return round(float(side["rotation"])) % 360
    tag = (video.get("tags") or {}).get("rotate")
    if tag is not None:
        try:
            return round(float(tag)) % 360
        except ValueError:
            return None
    return None


def image_size(path: str) -> tuple[int, int] | None:
    """Width and height of a JPEG or PNG, from its header.

    Frames are written at the source resolution, and a box a model reports in
    the pixels of one is meaningless to anyone who does not know which. Reading
    the two numbers out of the file is a dozen lines; taking a dependency on an
    imaging library so that on-screen text can be located is not a trade worth
    making in a worker whose whole point is that every model is optional.
    """
    try:
        with open(path, "rb") as handle:
            header = handle.read(2)
            if header == b"\x89P":
                handle.seek(0)
                data = handle.read(24)
                if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
                    return None
                return (
                    int.from_bytes(data[16:20], "big"),
                    int.from_bytes(data[20:24], "big"),
                )
            if header != b"\xff\xd8":
                return None
            while True:
                marker = handle.read(2)
                if len(marker) < 2 or marker[0] != 0xFF:
                    return None
                length = int.from_bytes(handle.read(2), "big")
                if length < 2:
                    return None
                # The frame-header markers, which are the ones carrying the size.
                # C4, C8 and CC share the range and do not.
                if 0xC0 <= marker[1] <= 0xCF and marker[1] not in (0xC4, 0xC8, 0xCC):
                    body = handle.read(5)
                    if len(body) < 5:
                        return None
                    return (
                        int.from_bytes(body[3:5], "big"),
                        int.from_bytes(body[1:3], "big"),
                    )
                handle.seek(length - 2, 1)
    except OSError:
        return None
