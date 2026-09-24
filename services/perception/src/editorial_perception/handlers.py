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

from .backends import asr, audio_tags, hashing, text_embedding, visual, vlm
from .backends import audio as audio_backend
from .backends import motion as motion_backend
from .backends import ocr as ocr_backend
from .errors import BadRequest, MissingDependency
from .media import detect_shots, has_ffmpeg, has_ffprobe, prepare, probe
from .protocol import PROTOCOL_VERSION, WORKER_VERSION, Session
from .scheduler import ModelScheduler

_scheduler = ModelScheduler(capacity=int(os.environ.get("OEA_MODEL_SLOTS", "1")))


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
            "analyze_video": has_ffmpeg(),
            "transcribe": _importable("faster_whisper"),
            "embed_frames": visual.available(),
            "ocr": ocr_backend.available(),
            "describe": bool(
                os.environ.get("OEA_VLM_BASE_URL") and os.environ.get("OEA_VLM_MODEL")
            ),
            # Asked, not asserted. This was hardcoded True while the loader
            # quietly returned None and the stage fell through to lexical
            # hashing, so the client wired a worker-backed encoder that does
            # not declare itself a stand-in and stamped the result as a
            # full-strength analysis. Search then could not match 夜景 to
            # "night view" at all — cosine exactly 0.0, since the two share no
            # character n-grams.
            "embed_text": text_embedding.available(),
            # Whether a query can be put in the *vision* model's space, which is
            # a different question from whether frames can be embedded. An
            # export with no text tower embeds frames perfectly well and cannot
            # be asked about them, and the client has to know which it has
            # before it builds an index it cannot search.
            "embed_text_visual": visual.available() and visual.has_text_tower(),
        },
        # Where the work would happen, which is not always here. `describe` is
        # an HTTP call to whatever OEA_VLM_BASE_URL names, and the client cannot
        # see that variable: it recorded every worker-backed stage as local, so
        # a run that posted the user's transcripts to a hosted endpoint was
        # written into the record as having stayed on the machine.
        "stage_locality": {"describe": _describe_locality()},
        # The visual text tower is English on every checkpoint this is likely to
        # be pointed at, and a Japanese query against it ranks noise confidently
        # rather than failing. The client declines instead.
        "stage_query_languages": _stage_query_languages(),
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


def _model_name(reference: str) -> str:
    """The identity of a model, given either its name or where it was unpacked."""
    if "/" not in reference and "\\" not in reference:
        return reference
    from pathlib import Path  # noqa: PLC0415

    # A repo id like "google/siglip-base-patch16-224" is a name and keeps both
    # halves; a filesystem path keeps only its last component.
    if not Path(reference).exists():
        return reference
    return Path(reference).resolve().name


def _stage_models() -> dict[str, str]:
    """What each stage would load, without loading any of it."""
    from .backends.asr import DEFAULT_COMPUTE  # noqa: PLC0415
    from .backends.asr import DEFAULT_MODEL as ASR_MODEL

    models = {
        # The compute type changes the numbers that come out, so it is part of
        # what identifies the model rather than a detail of how it was run.
        # The name, never the path. A locally-provisioned model is pointed at
        # with an absolute directory, and that directory was going into the
        # cache key and into every ModelRun record in the IR — which put
        # somebody's home directory inside a document meant to be shared, and
        # made the cache miss on the same model moved elsewhere.
        "transcribe": f"{_model_name(ASR_MODEL)}/{DEFAULT_COMPUTE}",
    }
    # The name that actually loaded, never the path it was asked for. A locally
    # provisioned model is pointed at with an absolute directory, and that
    # directory was going into the cache key and into every ModelRun record —
    # putting somebody's home directory inside a document meant to be shared.
    visual_model = visual.describe()
    if visual_model:
        models["embed_frames"] = visual_model
        if visual.has_text_tower():
            models["embed_text_visual"] = visual_model
    # The name that actually produced the vectors, which is not always the
    # name that was asked for: an unloadable model falls back to hashing, and
    # the cache must not serve one stage's vectors under the other's key.
    models["embed_text"] = text_embedding.describe()
    # Same algorithm and same name as the TypeScript analyser, so the cache
    # entry one runtime wrote is the one the other would have written.
    models["analyze_video"] = motion_backend.MODEL
    if ocr_backend.available():
        # The version, not the word "ocr". The cache keys on this, so a
        # placeholder meant an upgraded reader served the old reader's text.
        models["ocr"] = ocr_backend.describe()
    tagger = audio_tags.describe()
    if tagger:
        models["analyze_audio"] = tagger
    vlm = os.environ.get("OEA_VLM_MODEL")
    if vlm:
        models["describe"] = vlm
    return models


def _stage_query_languages() -> dict[str, str]:
    """Where a stage reads less than it analyses. Empty when nothing is narrowed."""
    languages: dict[str, str] = {}
    if visual.available() and visual.has_text_tower():
        loaded = visual.resolve()
        if loaded is not None:
            languages["embed_text_visual"] = str(loaded["text_language"])
    return languages


def _describe_locality() -> str:
    base_url = os.environ.get("OEA_VLM_BASE_URL")
    if not base_url:
        return "unknown"
    return "local" if _LOOPBACK.match(base_url) else "remote_api"


def handle_probe(params: dict[str, Any], session: Session) -> dict[str, Any]:
    return probe(_require(params, "path"))


def handle_prepare(params: dict[str, Any], session: Session) -> dict[str, Any]:
    asked = params.get("audio_stream_index")
    return prepare(
        _require(params, "path"),
        _require(params, "work_dir"),
        proxy_height=int(params.get("proxy_height", 480)),
        extract_audio=bool(params.get("extract_audio", True)),
        frame_fps=float(params.get("frame_fps", 1.0)),
        audio_stream_index=None if asked is None else int(asked),
        # Constant unless asked otherwise, as the contract says: the proxy is
        # what every timestamp downstream is taken from.
        constant_frame_rate=params.get("constant_frame_rate") is not False,
    )


def handle_detect_shots(params: dict[str, Any], session: Session) -> dict[str, Any]:
    return detect_shots(
        _require(params, "path"),
        threshold=float(params.get("threshold", 0.3)),
        min_shot_ms=int(params.get("min_shot_ms", 800)),
    )


def handle_analyze_audio(params: dict[str, Any], session: Session) -> dict[str, Any]:
    audio_path = _require(params, "audio_path")
    result = audio_backend.analyze(
        audio_path,
        hop_ms=int(params.get("hop_ms", 100)),
        silence_threshold_db=float(params.get("silence_threshold_db", -40)),
    )

    # `classify_events` has been in the request contract, defaulting to true and
    # documented as "classify laughter, applause, music and so on", since before
    # anything could do it. The rule engine's `has_laughter` and `has_music`
    # were reachable and never fired.
    #
    # Tagging is an addition to this stage rather than a stage of its own: the
    # events it produces have the same shape as the silence and speech ones
    # already here, and a model that is absent costs the classification without
    # costing the loudness analysis that every cut point depends on.
    if params.get("classify_events", True) and audio_tags.available():
        try:
            tagged = audio_tags.tag(
                _scheduler.get("audio_tags", audio_tags.load),
                audio_path,
                progress=lambda fraction: session.progress(fraction),
            )
        except Exception as error:  # noqa: BLE001
            session.log(f"audio tagging failed, keeping the loudness analysis: {error}")
        else:
            result["events"] = _ordered(result.get("events", []) + tagged["events"])
            if tagged.get("model"):
                result["model"] = f"{result.get('model') or 'audio'}+{tagged['model']}"
    return result


def _ordered(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(events, key=lambda event: (event["start_ms"], event["event_type"]))


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
        # Passed through rather than guessed. Without it the stage wrote frames
        # into the directory the footage lives in and left them there.
        frames_dir=params.get("frames_dir"),
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
    texts = params.get("texts") or []
    if not isinstance(texts, list) or not texts:
        raise BadRequest("embed_text needs a non-empty list of texts")
    wanted = [str(text) for text in texts]

    space = str(params.get("space", "text"))
    if space not in ("text", "visual"):
        raise BadRequest("space must be 'text' or 'visual'", given=space)

    if space == "visual":
        # Refused rather than answered in the other space. Silently returning
        # sentence-encoder vectors here would put two embedding spaces in one
        # index, which produces a confident ranking out of noise and cannot be
        # detected downstream — the index only catches it when the two models
        # happen to disagree about how wide a vector is.
        loaded = _scheduler.get("visual", visual.load)
        if not visual.has_text_tower(loaded):
            raise MissingDependency("visual queries", "a vision model with a text tower")
        vectors = visual.encode_text(loaded, wanted)
        return {
            "model": loaded["name"],
            "dim": int(vectors.shape[1]) if vectors.shape[0] else 1,
            "vectors": [[round(float(value), 6) for value in row] for row in vectors],
        }

    # Memoised in the backend rather than here, so that the capability report
    # and the stage-name report share this session instead of building their
    # own. Answering "can you embed text?" used to cost a model load.
    return text_embedding.embed(
        text_embedding.resolve(), wanted, str(params.get("role", "passage"))
    )


def handle_analyze_video(params: dict[str, Any], session: Session) -> dict[str, Any]:
    """How much the picture moves and where it is black, on the proxy."""
    return motion_backend.analyze(
        _require(params, "path"),
        sample_fps=float(params.get("sample_fps", 5)),
        static_threshold=float(params.get("static_threshold", 0.5)),
        min_static_ms=int(params.get("min_static_ms", 3000)),
        black_luma=float(params.get("black_luma", 24)),
        min_black_ms=int(params.get("min_black_ms", 500)),
    )


HANDLERS = {
    "health": handle_health,
    "probe": handle_probe,
    "prepare": handle_prepare,
    "detect_shots": handle_detect_shots,
    "analyze_audio": handle_analyze_audio,
    "analyze_video": handle_analyze_video,
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
