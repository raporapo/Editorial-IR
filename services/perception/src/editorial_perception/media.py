"""Everything that is ffmpeg's job.

Reimplementing container parsing or decoding in Python would be slower and
wrong, so this module is a careful wrapper and nothing more. It is also the only
part of the worker with no optional dependency: a machine with ffmpeg can always
probe and prepare, whatever else is missing.
"""

from __future__ import annotations

import functools
import json
import math
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .errors import MediaError, PerceptionError

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


#: Above this a declared rate is the container's clock showing through, not a
#: frame rate: Matroska stamps in milliseconds, and a stream with irregular
#: stamps declares 1000/1 (measured, on a synthetic 51.5 fps VFR file). 240 is
#: the fastest ordinary capture rate. The same constant as `MAX_NOMINAL_FPS` in
#: the TypeScript probe.
MAX_NOMINAL_FPS = 240

#: How far the counted rate may stray from the nominal one before a file is VFR.
VFR_TOLERANCE = 0.01

#: Handler names ffmpeg and Apple write when nobody named the track.
_GENERIC_HANDLERS = frozenset({"SoundHandler", "Core Media Audio", "Apple Sound Media Handler"})


def probe(path: str) -> dict[str, Any]:
    """Container metadata, mapped onto the ProbeResult contract.

    The same mapping as `toProbeResult` in the TypeScript probe, rule for rule:
    which runtime reads a file is a deployment detail, and an asset must not
    change because the other one happened to be installed.
    """
    if not Path(path).exists():
        raise MediaError(f"no file at {path}", path=path)

    parsed = _ffprobe_json(path, ["-show_format", "-show_streams"])
    picture = picture_stream(parsed.get("streams") or [])
    packets = None
    if picture is not None and _needs_packet_count(picture, parsed):
        packets = _count_packets(path, int(picture.get("index") or 0))
    return probe_result(parsed, packets)


def _ffprobe_json(path: str, args: list[str]) -> dict[str, Any]:
    result = _run(["ffprobe", "-v", "error", "-print_format", "json", *args, path], timeout=120)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise MediaError("ffprobe returned output that is not JSON", path=path) from error


def _count_packets(path: str, stream_index: int) -> int | None:
    """Frames in a container that does not say how many it holds.

    Matroska and WebM carry no frame count, and their declared rates agree even
    when the frames do not — a variable-rate WebM declares 30/1 twice with 132
    frames in 8 s. Counting packets reads without decoding: 56 ms for a 17 MB,
    143 s file. A count that fails costs the VFR check, not the probe.
    """
    try:
        counted = _ffprobe_json(
            path,
            [
                "-count_packets",
                "-select_streams",
                str(stream_index),
                "-show_entries",
                "stream=nb_read_packets",
            ],
        )
    except MediaError:
        return None
    streams = counted.get("streams") or []
    value = _float((streams[0] if streams else {}).get("nb_read_packets"))
    return int(value) if value and value > 0 else None


def picture_stream(streams: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The first video stream that is a picture of the recording.

    Album art in an MP3 or M4A is a one-frame video stream marked
    `attached_pic` (declaring 90000/1), and taking it as the picture recorded a
    podcast episode as 600x600 `mjpeg`.
    """
    return next(
        (
            s
            for s in streams
            if s.get("codec_type") == "video"
            and (s.get("disposition") or {}).get("attached_pic") != 1
        ),
        None,
    )


def is_still_format(format_name: str | None) -> bool:
    """Whether the container is ffmpeg's reader for a single picture.

    Such a reader reports 25/1 for every JPEG and PNG, and a still has no rate.
    """
    if not format_name:
        return False
    return any(name == "image2" or name.endswith("_pipe") for name in format_name.split(","))


def _needs_packet_count(picture: dict[str, Any], parsed: dict[str, Any]) -> bool:
    if is_still_format((parsed.get("format") or {}).get("format_name")):
        return False
    return not ((_float(picture.get("nb_frames")) or 0) > 0)


def probe_result(parsed: dict[str, Any], packet_count: int | None = None) -> dict[str, Any]:
    """ffprobe's JSON as a ProbeResult. Split out so it can be tested without ffprobe."""
    streams = parsed.get("streams") or []
    video = picture_stream(streams)
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    audio = audios[0] if audios else None
    fmt = parsed.get("format") or {}
    still = is_still_format(fmt.get("format_name"))

    duration = (
        _float(fmt.get("duration"))
        or _float((video or {}).get("duration"))
        or _float((audio or {}).get("duration"))
        or 0.0
    )

    out: dict[str, Any] = {
        # Half up, as `Math.round` does in the TypeScript probe. `round()` rounds
        # half to even, and measured on an Ogg Opus file ffprobe reports 2.006500 s:
        # 2007 ms from one runtime and 2006 from the other, for the same file.
        "duration_ms": max(0, math.floor(duration * 1000 + 0.5)),
        "metadata": {**(fmt.get("tags") or {}), **((video or {}).get("tags") or {})},
    }

    if video:
        if video.get("width"):
            out["width"] = int(video["width"])
        if video.get("height"):
            out["height"] = int(video["height"])
        if not still:
            nominal, average, variable = frame_rates(video, fmt, packet_count)
            if nominal:
                out["fps_num"], out["fps_den"] = nominal
            if average:
                out["avg_fps_num"], out["avg_fps_den"] = average
            if variable is not None:
                out["variable_frame_rate"] = variable
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
    out["audio_streams"] = [_audio_stream(stream, index) for index, stream in enumerate(audios)]

    if fmt.get("format_name"):
        out["container"] = fmt["format_name"]
    if fmt.get("bit_rate"):
        out["bit_rate"] = int(_float(fmt["bit_rate"]) or 0)

    creation = capture_tag(out["metadata"])
    if creation:
        out["creation_time"] = creation
    timecode = start_timecode(video, streams, fmt.get("tags") or {})
    if timecode:
        out["start_timecode"] = timecode

    return out


#: Where a container keeps its capture time, the one with an offset first. The
#: same order as `captureTag` in the TypeScript probe.
_CAPTURE_TAGS = ("com.apple.quicktime.creationdate", "creation_time", "date")


def capture_tag(tags: dict[str, Any]) -> str | None:
    """The capture time a container wrote, the one with an offset first.

    `com.apple.quicktime.creationdate` carries the zone and survives an export or
    a phone's trim that rewrites `creation_time` to the moment of the export.
    """
    for key in _CAPTURE_TAGS:
        value = tag_value(tags, key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def tag_value(tags: dict[str, Any] | None, key: str) -> Any:
    """A tag by name, whatever its case: Matroska's are in capitals (`TIMECODE`).

    The exact name wins; otherwise the first match in name order. The same rule as
    `tagValue` in the TypeScript probe.
    """
    if not tags:
        return None
    if key in tags:
        return tags[key]
    wanted = key.lower()
    matches = sorted(name for name in tags if name.lower() == wanted)
    return tags[matches[0]] if matches else None


_SMPTE = re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})([:;.,])(\d{2,3})$")


def smpte_timecode(value: Any) -> str | None:
    """`HH:MM:SS:FF`, with `;` before the frames for drop-frame, or nothing.

    `.` and `,` are drop-frame from tools that cannot write a semicolon. The same
    rule as `smpteTimecode` in the TypeScript probe.
    """
    if not isinstance(value, str):
        return None
    match = _SMPTE.match(value.strip())
    if not match:
        return None
    hours, minutes, seconds, separator, frames = match.groups()
    if int(hours) > 23 or int(minutes) > 59 or int(seconds) > 59:
        return None
    drop = ":" if separator == ":" else ";"
    return f"{hours.zfill(2)}:{minutes}:{seconds}{drop}{frames}"


def start_timecode(
    picture: dict[str, Any] | None,
    streams: list[dict[str, Any]],
    format_tags: dict[str, Any],
) -> str | None:
    """The first frame's timecode: the picture's own, a `tmcd` track's, the container's.

    Measured on ffmpeg 6.1: a MOV written with `-timecode 01:00:00;00` carries it
    on the picture stream and on its `tmcd` data stream; an MXF and a DV only on the
    container, and an MKV there too as `TIMECODE`. The same order as
    `startTimecode` in the TypeScript probe.
    """
    candidates = [tag_value((picture or {}).get("tags"), "timecode")]
    candidates += [
        tag_value(s.get("tags"), "timecode") for s in streams if s.get("codec_type") == "data"
    ]
    candidates.append(tag_value(format_tags, "timecode"))
    for candidate in candidates:
        timecode = smpte_timecode(candidate)
        if timecode:
            return timecode
    return None


def _audio_stream(stream: dict[str, Any], index: int) -> dict[str, Any]:
    out: dict[str, Any] = {"index": index}
    if stream.get("codec_name"):
        out["codec"] = stream["codec_name"]
    if stream.get("channels"):
        out["channels"] = int(stream["channels"])
    if (_float(stream.get("sample_rate")) or 0) > 0:
        out["sample_rate"] = int(stream["sample_rate"])
    tags = stream.get("tags") or {}
    language = tags.get("language")
    if language and language != "und":
        out["language"] = language
    handler = tags.get("handler_name")
    title = tags.get("title") or (handler if handler and handler not in _GENERIC_HANDLERS else None)
    if title:
        out["title"] = title
    return out


def frame_rates(
    video: dict[str, Any], fmt: dict[str, Any], packet_count: int | None = None
) -> tuple[tuple[int, int] | None, tuple[int, int] | None, bool | None]:
    """The nominal rate, the reported average, and whether the frames follow either.

    `r_frame_rate` is what the camera was set to and what an NLE conforms to;
    `avg_frame_rate` was taken instead, and a phone clip that dropped frames came
    out at 91/4 = 22.75 fps and made the sequence that rate. A file is
    variable-rate when the frames it holds run more than 1% off the nominal
    rate — by the container's own average where it lists its frames, and by the
    packets counted over the picture's length where it does not.
    """
    declared = _rational(video.get("r_frame_rate"))
    average = _rational(video.get("avg_frame_rate"))

    def plausible(rate: tuple[int, int] | None) -> tuple[int, int] | None:
        return rate if rate and rate[0] / rate[1] <= MAX_NOMINAL_FPS else None

    nominal = plausible(declared) or plausible(average)

    # A container that lists its frames (MP4, MOV) has already averaged them over
    # their own durations. The count over the stream's duration was wrong for a
    # clip trimmed with `-c copy`, whose edit list shortens the duration and not
    # the list: 131 frames in 4.067 s, "32.2 fps", for a 30 fps clip whose
    # average said 30/1. Elsewhere the average is a declaration, and the
    # packets are counted. `frameRates` in TypeScript, rule for rule.
    listed = (_float(video.get("nb_frames")) or 0) > 0
    seconds = _picture_seconds(video, fmt)
    counted = (
        packet_count / seconds
        if not listed and packet_count and packet_count > 1 and seconds and seconds > 0
        else None
    )
    measured = counted if counted is not None else (average[0] / average[1] if average else None)

    variable = None
    if declared and measured is not None:
        rate = declared[0] / declared[1]
        variable = abs(measured - rate) / rate > VFR_TOLERANCE
    return nominal, average, variable


# ASCII, as a JavaScript `\w` and `\d` are.
_DURATION_TAG = re.compile(r"DURATION(-\w+)?", re.IGNORECASE | re.ASCII)
_CLOCK = re.compile(r"(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)", re.ASCII)


def _picture_seconds(video: dict[str, Any], fmt: dict[str, Any]) -> float | None:
    """How long the picture runs, which is not how long the file runs.

    Matroska and WebM give a stream no `duration`, and the file lasts until its
    longest stream ends: a constant 30 fps WebM whose audio ran a second past the
    picture — 90 frames in 3.000 s, the file 4.008 s — measured 22.45 fps over
    the file and was called variable-rate. The muxer writes the picture's own
    length as a `DURATION` tag (`DURATION-eng` from mkvmerge). `pictureSeconds`
    in the TypeScript probe, rule for rule.
    """
    seconds = _float(video.get("duration"))
    if seconds and seconds > 0:
        return seconds
    tags = video.get("tags") or {}
    tagged = next((value for key, value in tags.items() if _DURATION_TAG.fullmatch(key)), None)
    match = _CLOCK.fullmatch(tagged.strip()) if isinstance(tagged, str) else None
    if match:
        clock = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
        if clock > 0:
            return clock
    return _float(fmt.get("duration"))


#: The rate a proxy is made at when the file declares none worth believing: a
#: Matroska screen recording declares its millisecond clock, 1000/1, and the
#: probe refuses anything above `MAX_NOMINAL_FPS`. Only then — as a cap on every
#: file it cost a 120 fps clip every other frame, and each cut was found one
#: source frame late (1008 ms became 1017). `PROXY_FALLBACK_FPS` in TypeScript.
PROXY_FALLBACK_FPS = 60

#: Identifies the speech measure, so a stored measurement made another way is
#: not trusted. The same string as `MEASURE` in the TypeScript preparer, and the
#: same file: either runtime may read what the other wrote.
_MEASURE = "rms-zcr-100ms-1"
_MEASUREMENTS_FILE = "audio-streams.json"


def prepare(
    path: str,
    work_dir: str,
    *,
    proxy_height: int = 480,
    extract_audio: bool = True,
    frame_fps: float = 1.0,
    crf: int = 28,
    audio_stream_index: int | None = None,
    constant_frame_rate: bool = True,
) -> dict[str, Any]:
    """Produces the derivatives everything downstream reads.

    Regenerable from the original, so the working directory is always safe to
    delete. The TypeScript preparer follows the same three rules and makes the
    same files:

    - **Each derivative is on its own.** Audio used to be extracted before the
      frames with nothing between them, so a video with no audio track lost its
      frames to the audio step's error. A failure is reported in `failed` and the
      others are still made.
    - **Each is named after everything that makes it different** — proxy height
      and rate, audio stream, frame rate — so a reused work directory never
      serves one made differently. `audio-synced.wav` was the first such name.
    - **Nothing half-written is reused.** Each is written under a temporary name
      and renamed into place; the frames directory as a whole. Existing files
      used to be trusted as they were, so a proxy cut short by an interrupted run
      was found, and kept, by every run after it.
    """
    if not Path(path).exists():
        raise MediaError(f"no file at {path}", path=path)

    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)
    # What the file holds, from the file: the caller's asset may predate the
    # stream list, or carry a rate from before it meant the nominal one.
    probed = probe(path)
    result: dict[str, Any] = {"frame_timestamps_ms": []}
    failed: list[dict[str, str]] = []

    def attempt(derivative: str, make: Callable[[], None]) -> None:
        try:
            make()
        except Exception as error:  # noqa: BLE001 - reported per derivative, not raised
            failed.append({"derivative": derivative, "reason": _reason(error)})

    # A moving picture: not album art, which the probe leaves out, and not a
    # still, which is its own frame — a one-frame proxy of a photo is read by
    # nobody.
    picture = (
        probed.get("video_codec") is not None
        and (probed.get("width") or 0) > 0
        and not is_still_format(probed.get("container"))
    )

    if proxy_height > 0 and picture:

        def make_proxy() -> None:
            rate = proxy_frame_rate(probed) if constant_frame_rate else None
            proxy = work / proxy_file_name(proxy_height, rate)
            if not proxy.exists():
                _write_atomically(
                    proxy, lambda partial: proxy_args(path, partial, proxy_height, crf, rate)
                )
            result["proxy_path"] = str(proxy)

        attempt("proxy", make_proxy)

    # A probe that does not list streams still says whether there is a first one.
    streams = probed.get("audio_streams")
    if streams is None:
        streams = [{"index": 0}] if probed.get("audio_codec") is not None else []
    result["audio_stream_count"] = len(streams)
    if extract_audio and streams:

        def make_audio() -> None:
            chosen = _prepare_audio(path, work, len(streams), audio_stream_index, failed)
            result["audio_path"] = chosen["path"]
            result["audio_stream_index"] = chosen["index"]
            result["audio_stream_reason"] = chosen["reason"]

        attempt("audio", make_audio)

    if frame_fps > 0 and picture:

        def make_frames() -> None:
            frames = work / frames_dir_name(frame_fps)
            if not frames.exists():
                partial = _partial_path(frames)
                shutil.rmtree(partial, ignore_errors=True)
                partial.mkdir(parents=True)
                try:
                    _run(frame_args(path, str(partial), frame_fps))
                    partial.rename(frames)
                except Exception:
                    shutil.rmtree(partial, ignore_errors=True)
                    # Another run finished the same directory first: success.
                    if not frames.exists():
                        raise
            result["frames_dir"] = str(frames)
            result["frame_timestamps_ms"] = frame_timestamps_in(frames, frame_fps)

        attempt("frames", make_frames)

    if failed:
        result["failed"] = failed
    return result


def _prepare_audio(
    path: str,
    work: Path,
    count: int,
    asked: int | None,
    failed: list[dict[str, str]],
) -> dict[str, Any]:
    """The audio stream to analyse, extracted.

    With several, each is extracted and the one with the most speech kept.
    ffmpeg's own choice is the stream with the most channels, which on a camera
    is the stereo room tone and not the mono lavalier beside it: measured, five
    spoken sentences transcribed as none.
    """

    def extract(index: int) -> Path:
        target = work / audio_file_name(index)
        if not target.exists():
            _write_atomically(target, lambda partial: audio_args(path, partial, index))
        return target

    if asked is not None and count > 1:
        if asked >= count:
            raise MediaError(f"there is no audio stream {asked}; the file has {count}")
        return {"path": str(extract(asked)), "index": asked, "reason": "asked for"}
    if count == 1:
        return {"path": str(extract(0)), "index": 0, "reason": "the only one"}

    stored = _read_stream_measurements(work, count)
    measured: list[dict[str, Any]] = []
    for index in range(count):
        try:
            target = extract(index)
        except Exception as error:  # noqa: BLE001 - one unreadable track is not all of them
            failed.append({"derivative": "audio", "reason": f"stream {index}: {_reason(error)}"})
            continue
        measured.append(stored[index] if stored else measure_speech(str(target), index))
    if not measured:
        raise MediaError("none of the audio streams could be extracted")
    if stored is None and len(measured) == count:
        _write_stream_measurements(work, measured)

    choice = choose_audio_stream(measured, count)
    return {"path": str(work / audio_file_name(choice["index"])), **choice}


def _reason(error: Exception) -> str:
    """A failure in one line: what failed, and ffmpeg's first word on why.

    ffmpeg says the cause first and its consequences after — "Output file does
    not contain any stream", then "Invalid argument". `failureReason` in the
    TypeScript preparer writes the same line.
    """
    message = str(error) or type(error).__name__
    stderr = error.details.get("stderr") if isinstance(error, PerceptionError) else None
    if isinstance(stderr, str):
        lines = (_CONTEXT_PREFIX.sub("", line).strip() for line in stderr.splitlines())
        first = next((line for line in lines if line), "")
        if first:
            return f"{message}: {first}"
    return message


_CONTEXT_PREFIX = re.compile(r"^\[[^\]]*\]\s*")


def _write_atomically(target: Path, args_for: Callable[[str], list[str]]) -> None:
    partial = _partial_path(target)
    try:
        _run(args_for(str(partial)))
        partial.replace(target)
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def _partial_path(target: Path) -> Path:
    """A sibling name for the unfinished file, keeping the extension ffmpeg reads the format by."""
    return target.with_name(f"{target.stem}.partial-{os.getpid()}{target.suffix}")


def proxy_frame_rate(probed: dict[str, Any]) -> tuple[int, int]:
    """The rate a constant-rate proxy is made at: the nominal one, or the fallback."""
    num = int(probed.get("fps_num") or 0)
    den = int(probed.get("fps_den") or 1)
    if num <= 0 or den <= 0 or num / den > MAX_NOMINAL_FPS:
        return (PROXY_FALLBACK_FPS, 1)
    return (num, den)


def proxy_file_name(height: int, rate: tuple[int, int] | None) -> str:
    if rate is None:
        return f"proxy-{height}p.mp4"
    num, den = rate
    return f"proxy-{height}p-cfr{num}{'' if den == 1 else f'-{den}'}.mp4"


def audio_file_name(stream_index: int) -> str:
    """Named for its stream, so a reused work directory never serves another stream's audio."""
    return f"audio-a{stream_index}.wav"


def frames_dir_name(fps: float) -> str:
    rate = str(int(fps)) if float(fps).is_integer() else f"{fps:.3f}".rstrip("0")
    return f"frames-{rate}fps"


def proxy_args(
    path: str, output: str, height: int, crf: int, rate: tuple[int, int] | None
) -> list[str]:
    # Constant rate by the `fps` filter: it and `-fps_mode cfr -r` made the same
    # 600 frames at 30/1 from a 455-frame variable-rate phone clip, and the filter
    # needs no version check (`-fps_mode` arrived in ffmpeg 5.1). Before `scale`,
    # so frames about to be dropped are never scaled. -2 keeps the width even,
    # which h264 requires.
    filters = ([f"fps={rate[0]}/{rate[1]}"] if rate else []) + [f"scale=-2:{height}"]
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path,
        "-vf",
        ",".join(filters),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        str(crf),
        "-an",
        "-movflags",
        "+faststart",
        output,
    ]


def audio_args(path: str, output: str, stream_index: int = 0) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path,
        # Always a named stream; left to itself ffmpeg takes the one with the
        # most channels.
        "-map",
        f"0:a:{stream_index}",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(AUDIO_SAMPLE_RATE),
        # Keep the audio on the file's clock: a track with gaps in its timestamps
        # was concatenated, so everything after the first gap came out early —
        # measured, up to 12 s on a 60 s capture. Fill gaps with silence and pad
        # a late start.
        "-af",
        "aresample=async=1:first_pts=0",
        "-c:a",
        "pcm_s16le",
        output,
    ]


def frame_args(path: str, frames_dir: str, fps: float) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path,
        "-vf",
        f"fps={fps}",
        "-q:v",
        "4",
        str(Path(frames_dir) / "%08d.jpg"),
    ]


def frame_timestamps_in(frames: Path, fps: float) -> list[int]:
    """Timestamps of the frames a finished directory holds, the way TypeScript reports them.

    Only files named by index count. Rounded half up, as `Math.round` does:
    `round()` rounds half to even, and at 16 fps the second frame is 62.5 ms.
    """
    count = sum(1 for name in os.listdir(frames) if _INDEXED_FRAME.fullmatch(name))
    return [math.floor(i * 1000 / fps + 0.5) for i in range(count)]


_INDEXED_FRAME = re.compile(r"\d{8}\.jpg")


def measure_speech(wav_path: str, index: int) -> dict[str, Any]:
    """Speech evidence for one extracted stream, by the audio stage's own measure.

    The same energy and zero-crossing analysis `analyze_audio` reports, with its
    defaults, so "most speech" means what `speech_prob` means everywhere else.
    Room tone has no dynamic range, and the analysis reports no speech in it by
    construction.
    """
    from .backends import audio as audio_backend  # noqa: PLC0415

    analysed = audio_backend.analyze(wav_path, 100, -40.0)
    return speech_of(analysed["speech_prob"], analysed["rms_db"], index)


def speech_of(speech_prob: list[float], rms_db: list[float], index: int) -> dict[str, Any]:
    # The lower median by integer index: `percentile` rounds a half-way index
    # differently in the two runtimes, and this choice has to be the same in both.
    ordered = sorted(rms_db)
    return {
        "index": index,
        "speech_hops": sum(1 for p in speech_prob if p >= 0.5),
        "hops": len(speech_prob),
        "median_db": ordered[(len(ordered) - 1) >> 1] if ordered else -100.0,
    }


def choose_audio_stream(measured: list[dict[str, Any]], stream_count: int) -> dict[str, Any]:
    """The stream with the most speech, and why, exactly as `chooseAudioStream` decides it.

    Share of hops compared by cross-multiplying integer counts, then the louder
    median, then the earlier stream.
    """
    ranked = sorted(
        measured,
        key=functools.cmp_to_key(
            lambda a, b: (
                b["speech_hops"] * max(1, a["hops"]) - a["speech_hops"] * max(1, b["hops"])
                or _sign(b["median_db"] - a["median_db"])
                or a["index"] - b["index"]
            )
        ),
    )
    best = ranked[0]
    if len(ranked) < 2:
        return {"index": best["index"], "reason": "the only one that could be read"}
    following = ranked[1]

    def share(entry: dict[str, Any]) -> float:
        return entry["speech_hops"] / max(1, entry["hops"])

    if best["speech_hops"] * max(1, following["hops"]) > following["speech_hops"] * max(
        1, best["hops"]
    ):
        return {
            "index": best["index"],
            "reason": f"most speech of {stream_count} "
            f"({_hundredths(share(best))} vs {_hundredths(share(following))})",
        }
    if best["median_db"] > following["median_db"]:
        return {
            "index": best["index"],
            "reason": f"as much speech as the others of {stream_count} "
            f"({_hundredths(share(best))}), and the loudest "
            f"({_tenths(best['median_db'])} vs {_tenths(following['median_db'])} dB)",
        }
    return {
        "index": best["index"],
        "reason": f"the first of {stream_count}, which all measured alike",
    }


def _sign(value: float) -> int:
    return (value > 0) - (value < 0)


def _hundredths(value: float) -> str:
    """Formatted from integers, so both runtimes write the same characters."""
    n = math.floor(value * 100 + 0.5)
    return f"{n // 100}.{n % 100:02d}"


def _tenths(value: float) -> str:
    n = math.floor(value * 10 + 0.5)
    sign = "-" if n < 0 else ""
    magnitude = abs(n)
    return f"{sign}{magnitude // 10}.{magnitude % 10}"


def _read_stream_measurements(work: Path, count: int) -> dict[int, dict[str, Any]] | None:
    """Measurements from an earlier run, when they cover every stream.

    Measuring reads every stream's audio in a pure-Python loop, and prepare runs
    on every analysis that is not reused.
    """
    target = work / _MEASUREMENTS_FILE
    if not target.exists():
        return None
    try:
        stored = json.loads(target.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if stored.get("measure") != _MEASURE or not isinstance(stored.get("streams"), list):
        return None
    by_index: dict[int, dict[str, Any]] = {}
    for entry in stored["streams"]:
        if not isinstance(entry, dict):
            return None
        index = entry.get("index")
        values = [entry.get(key) for key in ("speech_hops", "hops", "median_db")]
        if (
            not isinstance(index, int)
            or not all(isinstance(value, int | float) for value in values)
            or not (work / audio_file_name(index)).exists()
        ):
            return None
        by_index[index] = {
            "index": index,
            "speech_hops": entry["speech_hops"],
            "hops": entry["hops"],
            "median_db": entry["median_db"],
        }
    if any(index not in by_index for index in range(count)):
        return None
    return by_index


def _write_stream_measurements(work: Path, measured: list[dict[str, Any]]) -> None:
    target = work / _MEASUREMENTS_FILE
    partial = _partial_path(target)
    ordered = sorted(measured, key=lambda entry: entry["index"])
    partial.write_text(json.dumps({"measure": _MEASURE, "streams": ordered}) + "\n")
    partial.replace(target)


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


def detect_shots(path: str, threshold: float = 0.3, min_shot_ms: int = 800) -> dict[str, Any]:
    """Shot boundaries from ffmpeg's own scene metric.

    PySceneDetect is better and is a heavy dependency; ffmpeg is already here.
    When PySceneDetect is installed it is used instead, because the difference in
    boundary quality is worth having when the cost is already paid.

    ## Where 0.3 comes from

    The number is a *sensitivity*, not a raw metric value: the scale constants
    above turn it into whatever each backend measures in. Two rounds of
    measurement set it.

    The first was the bug, and it was the scaling rather than the number. The
    threshold used to reach ffmpeg unscaled, so 0.3 meant a raw cutoff of 0.3 —
    above every real cut. Twelve minutes of multi-scene footage with thirteen
    hard cuts returned one shot per file, and the effect downstream was one
    event per asset: a five-minute recording compiled into a single 253-second
    "moment". Scaling alone fixed it, and it is why 0.3 now means 0.1.

    Worth recording because it was nearly mis-attributed: the default here was
    also lowered to 0.15 at the time, and that had no effect at all. The
    pipeline passes its own sensitivity from `observe.ts` and has sent 0.3 since
    the compiler was written, so this default is reached only by a direct
    caller. The improvement came entirely from the scaling; the lowered default
    was an inconsistency hiding behind it, which is why the two sides now share
    a constant and `scripts/check-python.mjs` fails if they drift apart.

    The second round confirmed the value the pipeline was already using, on 62
    minutes of real camera footage across four unedited takes — where every
    boundary found is by definition wrong:

        sensitivity   raw cutoff   false boundaries   per minute
              0.10        0.033            194           3.13
              0.15        0.050             79           1.28
              0.20        0.067             33           0.53
              0.30        0.100             14           0.23

    The distributions were consistent across all four clips: the median score
    sat near 0.014, the 90th percentile near 0.027, and the 99th between 0.054
    and 0.090. **0.3 is the smallest value tested whose cutoff clears the 99th
    percentile of all four**, which is the criterion: a threshold inside the
    noise distribution admits noise at exactly the rate the distribution says it
    will, and 0.15 sat below every one of them — five times the false boundaries
    for anyone who had reached that default.

    ## What is still not measured

    Recall. Everything above is the false-positive side, because unedited takes
    give that for free and an edited clip with known cut times is what the other
    side needs. It is possible that 0.3 misses real cuts, and the instrument for
    catching that is `oea analyze` reporting when an asset comes back as a
    single shot over several minutes.

    `scripts/scene-report.mjs` produces the table above from footage that never
    leaves the machine it is on, which is how these numbers were obtained.

    ## The direction this points, which is not a threshold

    The false positives were not evenly spread: they came in bursts of a few
    seconds during violent camera movement — three consecutive frames scoring
    0.178, 0.246 and 0.328 in one case, with a maximum of 0.435 across the set.
    That overlaps the range a genuine cut occupies, so **no threshold separates
    these cleanly** and raising this number further would start costing real
    cuts to buy diminishing returns.

    What does separate them is shape rather than height: a cut is one frame
    where everything changes and then stays changed, while camera motion is
    elevated for seconds at a time. Suppressing a candidate whose neighbours are
    also elevated would use that, and it needs the recall data first — a rule
    that quiets sustained motion could quiet a rapid-cut sequence just as well.
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


def moment_frame_name(timestamp_ms: int) -> str:
    """The file a frame pulled for one moment is written to.

    Never a bare eight-digit number, which is how `prepare` names its sampled
    frames — by 1-based *index*. The visual stage wrote `{ms:08d}.jpg` into that
    same directory, so a moment at 1000 ms in a twenty-minute file found
    prepare's frame 1000 already there, the picture at 999 s, and embedded that.
    The two names now cannot meet, whatever directory they are put in.
    """
    return f"at-{timestamp_ms:08d}ms.jpg"


def extract_frame(path: str, timestamp_ms: int, out_path: str) -> str:
    """Pulls one frame, for a model that wants a specific moment.

    No seek for the first frame. `-ss 0` on a JPEG — a still, whose only frame
    is at 0 — measured as ffmpeg exiting 0 having written nothing ("No filtered
    frames for output stream"), so every JPEG photo was silently never looked at
    or read while PNGs were. And a frame that was not written is an error here
    rather than a file some later `open` fails on quietly.
    """
    seek = ["-ss", f"{timestamp_ms / 1000:.3f}"] if timestamp_ms > 0 else []
    _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            *seek,
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
    if not Path(out_path).exists():
        raise MediaError(f"ffmpeg wrote no frame at {timestamp_ms} ms", path=path)
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
