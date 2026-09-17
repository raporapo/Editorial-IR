"""Speech recognition.

faster-whisper by default because it is the best quality-per-watt available for
this at the time of writing, and behind an interface because that will stop
being true. The model name is configuration, never a constant in the code.
"""

from __future__ import annotations

import os
from typing import Any

from ..errors import MissingDependency, ModelError

DEFAULT_MODEL = os.environ.get("OEA_ASR_MODEL", "small")
DEFAULT_COMPUTE = os.environ.get("OEA_ASR_COMPUTE", "int8")


def load(
    model_name: str = DEFAULT_MODEL,
    device: str = "auto",
    compute_type: str = DEFAULT_COMPUTE,
):
    try:
        from faster_whisper import WhisperModel  # noqa: PLC0415
    except ImportError as error:
        raise MissingDependency("transcription", "faster-whisper") from error

    try:
        return WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as error:  # noqa: BLE001
        raise ModelError(f"could not load the speech model {model_name!r}: {error}") from error


def transcribe(
    model,
    audio_path: str,
    *,
    language: str | None = None,
    vocabulary: list[str] | None = None,
    word_timestamps: bool = True,
    progress=None,
) -> dict[str, Any]:
    # Domain words go in as an initial prompt, which is how this family of models
    # is biased toward a vocabulary. Place names and people's names are exactly
    # what it otherwise gets wrong, and exactly what the user has already told us.
    prompt = ", ".join(vocabulary[:40]) if vocabulary else None

    try:
        segments, info = model.transcribe(
            audio_path,
            language=language,
            initial_prompt=prompt,
            word_timestamps=word_timestamps,
            vad_filter=True,
        )
    except Exception as error:  # noqa: BLE001
        raise ModelError(f"transcription failed: {error}") from error

    duration = getattr(info, "duration", 0) or 0
    utterances: list[dict[str, Any]] = []

    for segment in segments:
        text = (segment.text or "").strip()
        if not text:
            continue
        entry: dict[str, Any] = {
            "start_ms": round(segment.start * 1000),
            "end_ms": round(segment.end * 1000),
            "text": text,
            # Whisper reports an average log probability; mapping it into [0,1]
            # keeps the contract's meaning of confidence intact.
            "confidence": _confidence(getattr(segment, "avg_logprob", None)),
        }
        words = getattr(segment, "words", None)
        if words:
            entry["words"] = [
                {
                    "start_ms": round(word.start * 1000),
                    "end_ms": round(word.end * 1000),
                    "text": word.word.strip(),
                    "confidence": float(getattr(word, "probability", 0.5) or 0.5),
                }
                for word in words
                if word.start is not None and word.end is not None
            ]
        utterances.append(entry)

        if progress and duration:
            progress(min(1.0, segment.end / duration), text[:40])

    return {
        "language": getattr(info, "language", None) or language,
        "model": getattr(model, "model_size_or_path", None) or "faster-whisper",
        "utterances": utterances,
    }


def _confidence(avg_logprob: float | None) -> float:
    if avg_logprob is None:
        return 0.5
    # Around -1.0 is the point where this family's output stops being reliable.
    return max(0.0, min(1.0, 1.0 + avg_logprob))
