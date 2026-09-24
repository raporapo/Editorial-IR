"""Speech recognition.

faster-whisper by default because it is the best quality-per-watt available for
this at the time of writing, and behind an interface because that will stop
being true. The model name is configuration, never a constant in the code.
"""

from __future__ import annotations

import os
from typing import Any

from ..errors import MissingDependency, ModelError

# `base`, measured rather than assumed. On a 4-core CPU with int8:
#
#   tiny   3.9x realtime   base  2.25x realtime   small  0.74x realtime
#
# `small` was the default and is slower than the audio it is transcribing — a
# 20-minute video costs 27 minutes of ASR alone, on the machine most people will
# run this on. That is the kind of default that gets the whole project abandoned
# at the first real file.
#
# It is not only faster. On the one Japanese sample available here, `base`
# transcribed 弁当制 and 持っていけない correctly while `small` produced 弁当性 and
# dropped the potential form — so the usual "bigger is more accurate" intuition
# did not hold, and there was no accuracy being bought with that time. One
# sample is not a benchmark; the speed figures are solid and the quality claim is
# only that `small` is not obviously better.
#
# GPUs change this completely. Anyone with one should set OEA_ASR_MODEL=small or
# large-v3, which is why this is an environment variable and not a constant.
DEFAULT_MODEL = os.environ.get("OEA_ASR_MODEL", "base")
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
        pieces = _split_on_pauses(segment)
        if pieces is not None:
            utterances.extend(pieces)
            if progress and duration:
                progress(min(1.0, segment.end / duration), text[:40])
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


#: A pause between two words longer than this ends an utterance, whatever the
#: segment says.
#:
#: With the voice-activity filter on, faster-whisper cuts the silence out before
#: decoding and can hand back one segment spanning it. Measured: "Let me leave it
#: running for a while. Okay, I am back." came back as one segment from 8.4 s to
#: 91.0 s, around eighty seconds of digital silence — while its own word timings
#: put "while." ending at 10.1 s and "Okay," starting at 90.0 s. The event over
#: that frozen, silent minute then had a speech ratio of 1.0, and nine seconds of
#: it went into the cut. Two seconds is longer than any pause inside a sentence
#: and far shorter than the gaps the filter removes.
SPLIT_PAUSE_S = 2.0


def _split_on_pauses(segment: Any) -> list[dict[str, Any]] | None:
    """The segment as several utterances, when its words say it was several.

    None when it needs no splitting, so the ordinary path — and its handling of
    words with no timing — is left exactly as it was.
    """
    words = list(getattr(segment, "words", None) or [])
    timed = [w for w in words if w.start is not None and w.end is not None]
    if len(timed) < 2:
        return None
    if not any(b.start - a.end > SPLIT_PAUSE_S for a, b in zip(timed, timed[1:], strict=False)):
        return None

    groups: list[list[Any]] = [[]]
    last_end: float | None = None
    for w in words:
        if w.start is not None and last_end is not None and w.start - last_end > SPLIT_PAUSE_S:
            groups.append([])
        groups[-1].append(w)
        if w.end is not None:
            last_end = w.end

    confidence = _confidence(getattr(segment, "avg_logprob", None))
    pieces: list[dict[str, Any]] = []
    for group in groups:
        timed_group = [w for w in group if w.start is not None and w.end is not None]
        # Words keep their own spacing: English words arrive with a leading
        # space and Japanese ones with none, so joining as given is right for both.
        text = "".join(w.word for w in group).strip()
        if not timed_group or not text:
            continue
        pieces.append(
            {
                "start_ms": round(timed_group[0].start * 1000),
                "end_ms": round(timed_group[-1].end * 1000),
                "text": text,
                "confidence": confidence,
                "words": [
                    {
                        "start_ms": round(w.start * 1000),
                        "end_ms": round(w.end * 1000),
                        "text": w.word.strip(),
                        "confidence": float(getattr(w, "probability", 0.5) or 0.5),
                    }
                    for w in timed_group
                ],
            }
        )
    return pieces


def _confidence(avg_logprob: float | None) -> float:
    if avg_logprob is None:
        return 0.5
    # Around -1.0 is the point where this family's output stops being reliable.
    return max(0.0, min(1.0, 1.0 + avg_logprob))
