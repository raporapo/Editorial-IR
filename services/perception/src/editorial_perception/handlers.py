"""The operations this worker implements.

Each handler is thin: validate, call a backend, shape the result to the
contract. Model loading goes through the scheduler so that two large models are
never resident at once, and the loaders are lazy so a worker that is only ever
asked to probe never imports torch.
"""

from __future__ import annotations

import os
import re
import sys
from typing import Any

from .backends import asr, hashing, text_embedding, visual, vlm
from .backends import audio as audio_backend
from .backends import ocr as ocr_backend
from .errors import BadRequest, MissingDependency
from .media import detect_shots, has_ffmpeg, has_ffprobe, prepare, probe
from .protocol import PROTOCOL_VERSION, WORKER_VERSION, Session
from .scheduler import ModelScheduler

_scheduler = ModelScheduler(capacity=int(os.environ.get("OEA_MODEL_SLOTS", "1")))
_text_model_loaded = False
_text_model = None


def handle_health(params: dict[str, Any], session: Session) -> dict[str, Any]:
    """What this worker can actually do, right now.

    Answered by importing rather than by claiming: a capability that says yes and
    then fails on first use is worse than one that admits it is missing, because
    the compiler is built to degrade around a missing stage.
    """
    return {
        "protocol_version": PROTOCOL_VERSION,
        "worker_version": WORKER_VERSION,
        "python_version": sys.version.split()[0],
        "capabilities": {
            "probe": has_ffprobe(),
            "prepare": has_ffmpeg(),
            "detect_shots": has_ffmpeg(),
            "analyze_audio": True,
            "transcribe": _importable("faster_whisper"),
            "embed_frames": _importable("transformers") and _importable("torch"),
            "ocr": _importable("rapidocr_onnxruntime"),
            "describe": bool(
                os.environ.get("OEA_VLM_BASE_URL") and os.environ.get("OEA_VLM_MODEL")
            ),
            "embed_text": True,
        },
        # Where the work would happen, which is not always here. `describe` is
        # an HTTP call to whatever OEA_VLM_BASE_URL names, and the client cannot
        # see that variable: it recorded every worker-backed stage as local, so
        # a run that posted the user's transcripts to a hosted endpoint was
        # written into the record as having stayed on the machine.
        "stage_locality": {"describe": _describe_locality()},
        # The names that actually decide each stage's output. The client keys
        # its cache on these, and it had no way to learn them: every
        # worker-backed stage reported a placeholder, so changing the ASR model
        # and re-running served the old model's transcript.
        "stage_models": _stage_models(),
        "device": _device(),
        "vram_total_mb": _vram_mb(),
        "ffmpeg_available": has_ffmpeg(),
    }


_LOOPBACK = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:|/|$)")


def _stage_models() -> dict[str, str]:
    """What each stage would load, without loading any of it."""
    from .backends.asr import DEFAULT_COMPUTE  # noqa: PLC0415
    from .backends.asr import DEFAULT_MODEL as ASR_MODEL
    from .backends.text_embedding import DEFAULT_MODEL as TEXT_MODEL  # noqa: PLC0415
    from .backends.visual import DEFAULT_MODEL as VISUAL_MODEL  # noqa: PLC0415

    models = {
        # The compute type changes the numbers that come out, so it is part of
        # what identifies the model rather than a detail of how it was run.
        "transcribe": f"{ASR_MODEL}/{DEFAULT_COMPUTE}",
        "embed_frames": VISUAL_MODEL,
    }
    if TEXT_MODEL:
        models["embed_text"] = TEXT_MODEL
    vlm = os.environ.get("OEA_VLM_MODEL")
    if vlm:
        models["describe"] = vlm
    return models


def _describe_locality() -> str:
    base_url = os.environ.get("OEA_VLM_BASE_URL")
    if not base_url:
        return "unknown"
    return "local" if _LOOPBACK.match(base_url) else "remote_api"


def handle_probe(params: dict[str, Any], session: Session) -> dict[str, Any]:
    return probe(_require(params, "path"))


def handle_prepare(params: dict[str, Any], session: Session) -> dict[str, Any]:
    return prepare(
        _require(params, "path"),
        _require(params, "work_dir"),
        proxy_height=int(params.get("proxy_height", 480)),
        extract_audio=bool(params.get("extract_audio", True)),
        frame_fps=float(params.get("frame_fps", 1.0)),
    )


def handle_detect_shots(params: dict[str, Any], session: Session) -> dict[str, Any]:
    return detect_shots(
        _require(params, "path"),
        threshold=float(params.get("threshold", 0.3)),
        min_shot_ms=int(params.get("min_shot_ms", 800)),
    )


def handle_analyze_audio(params: dict[str, Any], session: Session) -> dict[str, Any]:
    return audio_backend.analyze(
        _require(params, "audio_path"),
        hop_ms=int(params.get("hop_ms", 100)),
        silence_threshold_db=float(params.get("silence_threshold_db", -40)),
    )


def handle_transcribe(params: dict[str, Any], session: Session) -> dict[str, Any]:
    model = _scheduler.get("speech", asr.load)
    return asr.transcribe(
        model,
        _require(params, "audio_path"),
        language=params.get("language"),
        vocabulary=params.get("vocabulary") or [],
        word_timestamps=bool(params.get("word_timestamps", True)),
        progress=lambda fraction, message: session.progress(fraction, message),
    )


def handle_embed_frames(params: dict[str, Any], session: Session) -> dict[str, Any]:
    loaded = _scheduler.get("visual", visual.load)
    return visual.embed_frames(
        loaded,
        _require(params, "path"),
        [int(t) for t in params.get("timestamps_ms") or []],
        label_vocabulary=params.get("label_vocabulary") or [],
        progress=lambda fraction: session.progress(fraction),
    )


def handle_ocr(params: dict[str, Any], session: Session) -> dict[str, Any]:
    engine = _scheduler.get("ocr", ocr_backend.load)
    return ocr_backend.read_frames(
        engine,
        _require(params, "path"),
        [int(t) for t in params.get("timestamps_ms") or []],
        frames_dir=params.get("frames_dir"),
        progress=lambda fraction: session.progress(fraction),
    )


def handle_describe(params: dict[str, Any], session: Session) -> dict[str, Any]:
    # The vision-language model is reached over HTTP even when it is local, so it
    # holds no accelerator memory here and takes no scheduler slot.
    return vlm.describe(params)


def handle_embed_text(params: dict[str, Any], session: Session) -> dict[str, Any]:
    global _text_model_loaded, _text_model  # noqa: PLW0603 - one process-wide model
    texts = params.get("texts") or []
    if not isinstance(texts, list) or not texts:
        raise BadRequest("embed_text needs a non-empty list of texts")

    if not _text_model_loaded:
        _text_model = text_embedding.load()
        _text_model_loaded = True

    return text_embedding.embed(
        _text_model, [str(text) for text in texts], str(params.get("role", "passage"))
    )


HANDLERS = {
    "health": handle_health,
    "probe": handle_probe,
    "prepare": handle_prepare,
    "detect_shots": handle_detect_shots,
    "analyze_audio": handle_analyze_audio,
    "transcribe": handle_transcribe,
    "embed_frames": handle_embed_frames,
    "ocr": handle_ocr,
    "describe": handle_describe,
    "embed_text": handle_embed_text,
}


def _require(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise BadRequest(f"{key} is required", given=list(params.keys()))
    return value


def _importable(module: str) -> bool:
    import importlib.util  # noqa: PLC0415

    return importlib.util.find_spec(module) is not None


def _device() -> str:
    try:
        import torch  # noqa: PLC0415
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _vram_mb() -> int | None:
    try:
        import torch  # noqa: PLC0415

        if not torch.cuda.is_available():
            return None
        return round(torch.cuda.get_device_properties(0).total_memory / (1024 * 1024))
    except Exception:  # noqa: BLE001
        return None


__all__ = ["HANDLERS", "MissingDependency", "hashing"]
