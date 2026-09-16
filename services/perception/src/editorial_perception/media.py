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


def _run(command: list[str], *, timeout: int = 3600, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
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

    duration = _float(fmt.get("duration")) or _float((video or {}).get("duration")) or _float((audio or {}).get("duration")) or 0.0

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
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", path,
                    # -2 keeps the width even, which h264 requires.
                    "-vf", f"scale=-2:{proxy_height}",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf),
                    "-an", "-movflags", "+faststart",
                    str(proxy),
                ]
            )
        result["proxy_path"] = str(proxy)

    if extract_audio:
        audio = work / "audio.wav"
        if not audio.exists():
            _run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", path,
                    "-vn", "-ac", "1", "-ar", str(AUDIO_SAMPLE_RATE), "-c:a", "pcm_s16le",
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
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", path,
                    "-vf", f"fps={frame_fps}",
                    "-q:v", "4",
                    str(frames / "%08d.jpg"),
                ]
            )
        result["frames_dir"] = str(frames)
        count = len(list(frames.glob("*.jpg")))
        result["frame_timestamps_ms"] = [round(i * 1000 / frame_fps) for i in range(count)]

    return result


def detect_shots(path: str, threshold: float = 0.3, min_shot_ms: int = 800) -> dict[str, Any]:
    """Shot boundaries from ffmpeg's own scene metric.

    PySceneDetect is better and is a heavy dependency; ffmpeg is already here.
    When PySceneDetect is installed it is used instead, because the difference in
    boundary quality is worth having when the cost is already paid.
    """
    try:
        return _detect_shots_pyscenedetect(path, threshold, min_shot_ms)
    except ImportError:
        pass

    result = _run(
        ["ffmpeg", "-hide_banner", "-i", path, "-filter:v", f"select='gt(scene,{threshold})',showinfo", "-an", "-f", "null", "-"],
        allow_failure=True,
    )
    boundaries = _parse_showinfo(result.stderr)
    duration_ms = probe(path)["duration_ms"]
    return {"model": "ffmpeg-scene", "shots": build_shots(boundaries, duration_ms, min_shot_ms)}


def _detect_shots_pyscenedetect(path: str, threshold: float, min_shot_ms: int) -> dict[str, Any]:
    from scenedetect import ContentDetector, detect  # noqa: PLC0415

    scenes = detect(path, ContentDetector(threshold=threshold * 100))
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


def extract_frame(path: str, timestamp_ms: int, out_path: str) -> str:
    """Pulls one frame, for a model that wants a specific moment."""
    _run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{timestamp_ms / 1000:.3f}",
            "-i", path,
            "-frames:v", "1", "-q:v", "3",
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
