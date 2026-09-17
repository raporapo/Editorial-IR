"""Laughter, music, applause, cheering and crowd noise.

The rule engine has had `has_laughter` and `has_music` for as long as it has
existed, and nothing produced them. A rule that cannot fire is worse than a rule
that is missing: it reads as implemented, it passes review, and it quietly makes
every travel and reaction edit worse than the skill says it should be.

What this adds is the AudioSet taxonomy, which is where those words come from in
the first place, mapped onto the small closed vocabulary the contract defines.
The contract's set is deliberately narrow so that a backend cannot invent tags
no skill can match; the original label travels alongside as `raw_label`.

## The model is configuration, and for a reason that is not architectural

The best model measured for this is CED-tiny: 6 MB, 120x realtime on one CPU
core, and zero false positives on laughter and applause across 28 clips. Its
weights are converted from a repository licensed **GPL-3.0**. Whether that
reaches the weights is genuinely contested, but it is not this file's call to
make, and a default that quietly encumbers a permissively-licensed project is
not a default.

So there is no default. `OEA_AUDIO_TAGGER` names a directory or the stage does
not run — which costs the stage and nothing else, exactly as a missing model
should. `docs/perception-protocol.md` lists the options and their licences.

## One window, one clip

These models answer "what is in this audio", not "what is in it at 3.2 seconds".
Timestamps come from sliding a window and merging the windows that agree, so the
resolution is the hop and no better. That is enough for the question actually
being asked — whether laughter is in this event — and it is not enough to cut
on, which is what the transcript's word timings are for.
"""

from __future__ import annotations

import os
from typing import Any

from ..errors import MissingDependency, ModelError

MODEL_DIR = os.environ.get("OEA_AUDIO_TAGGER", "")

# Seconds of audio per forward pass, and how far the window moves each time.
# A 2 s window is long enough to contain a laugh and short enough that the
# boundary it reports is useful.
WINDOW_S = 2.0
HOP_S = 1.0
SAMPLE_RATE = 16000

# Below this the model is guessing. Measured across 28 clips including seven
# real laughs, five real rounds of applause and ten hard negatives (rain, siren,
# dog bark, church bells, running water, white and pink noise, a sine tone,
# silence): 0.20 gave precision 0.88 and recall 0.88, with no false positive on
# laughter or applause at any threshold tried.
MIN_SCORE = 0.20

# AudioSet display names, onto the contract's closed set. Only labels that a
# skill could act on are mapped; everything else is left alone rather than
# forced into `other`, because an event stream full of `other` is noise that
# still costs storage and attention.
LABEL_MAP: dict[str, str] = {
    "Laughter": "laughter",
    "Baby laughter": "laughter",
    "Giggle": "laughter",
    "Snicker": "laughter",
    "Belly laugh": "laughter",
    "Chuckle, chortle": "laughter",
    "Applause": "applause",
    "Clapping": "applause",
    "Cheering": "cheering",
    "Crowd": "crowd",
    "Hubbub, speech noise, speech babble": "crowd",
    "Children playing": "crowd",
    "Music": "music",
    "Musical instrument": "music",
    "Singing": "music",
    "Song": "music",
    "Background music": "music",
    "Theme music": "music",
    "Speech": "speech",
    "Male speech, man speaking": "speech",
    "Female speech, woman speaking": "speech",
    "Child speech, kid speaking": "speech",
    "Conversation": "speech",
    "Narration, monologue": "speech",
    "Vehicle": "traffic",
    "Car": "traffic",
    "Traffic noise, roadway noise": "traffic",
    "Train": "traffic",
    "Aircraft": "traffic",
    "Motorcycle": "traffic",
    "Rain": "nature",
    "Wind": "nature",
    "Ocean": "nature",
    "Waves, surf": "nature",
    "Bird": "nature",
    "Stream": "nature",
    "Thunder": "nature",
    "Silence": "silence",
    "White noise": "noise",
    "Pink noise": "noise",
    "Static": "noise",
    "Noise": "noise",
}


def available() -> bool:
    """Whether tagging will actually happen. Never loads the model to find out."""
    if not MODEL_DIR:
        return False
    if not os.path.isdir(MODEL_DIR):
        return False
    return any(
        os.path.exists(os.path.join(MODEL_DIR, name)) for name in ("model.int8.onnx", "model.onnx")
    )


def describe() -> str:
    return os.path.basename(os.path.normpath(MODEL_DIR)) if available() else ""


def load(model_dir: str | None = None):
    if model_dir is None:
        model_dir = MODEL_DIR
    if not model_dir:
        raise MissingDependency("audio tagging", "a model directory in OEA_AUDIO_TAGGER")
    try:
        import sherpa_onnx  # noqa: PLC0415
    except ImportError as error:
        raise MissingDependency("audio tagging", "sherpa-onnx") from error

    weights = os.path.join(model_dir, "model.int8.onnx")
    if not os.path.exists(weights):
        weights = os.path.join(model_dir, "model.onnx")
    labels = os.path.join(model_dir, "class_labels_indices.csv")
    if not os.path.exists(weights) or not os.path.exists(labels):
        raise ModelError(f"{model_dir} does not look like an audio tagging model")

    try:
        config = sherpa_onnx.AudioTaggingConfig(
            model=sherpa_onnx.AudioTaggingModelConfig(
                ced=weights,
                # One thread on purpose. Each window is two seconds of audio, so
                # the thread pool costs more to synchronise than the work it
                # splits: four threads measured 2.6x *slower* than one, for both
                # models and both quantisations. Parallelise across files at the
                # process level instead.
                num_threads=1,
            ),
            labels=labels,
            top_k=8,
        )
        return {"tagger": sherpa_onnx.AudioTagging(config=config), "name": describe()}
    except Exception as error:  # noqa: BLE001
        raise ModelError(f"could not load the audio tagger in {model_dir!r}: {error}") from error


def tag(
    loaded: dict[str, Any],
    audio_path: str,
    *,
    min_score: float = MIN_SCORE,
    window_s: float = WINDOW_S,
    hop_s: float = HOP_S,
    progress=None,
) -> dict[str, Any]:
    """Timestamped audio events, merged across windows that agree."""

    from ..media import decode_pcm  # noqa: PLC0415

    samples = decode_pcm(audio_path, SAMPLE_RATE)
    if samples.size == 0:
        return {"model": loaded["name"], "events": []}

    tagger = loaded["tagger"]
    window = int(window_s * SAMPLE_RATE)
    hop = int(hop_s * SAMPLE_RATE)
    hits: list[tuple[int, int, str, str, float]] = []

    starts = range(0, max(1, samples.size - window + hop), hop)
    for index, start in enumerate(starts):
        chunk = samples[start : start + window]
        if chunk.size < window // 4:
            break
        stream = tagger.create_stream()
        stream.accept_waveform(SAMPLE_RATE, chunk)
        try:
            results = tagger.compute(stream, 8)
        except Exception as error:  # noqa: BLE001
            raise ModelError(f"audio tagging failed: {error}") from error

        start_ms = round(start * 1000 / SAMPLE_RATE)
        end_ms = round(min(start + window, samples.size) * 1000 / SAMPLE_RATE)
        for event in results:
            mapped = LABEL_MAP.get(event.name)
            if mapped is None or event.prob < min_score:
                continue
            hits.append((start_ms, end_ms, mapped, event.name, float(event.prob)))

        if progress and len(starts) > 0:
            progress(min(1.0, (index + 1) / len(starts)))

    return {"model": loaded["name"], "events": merge(hits)}


def merge(hits: list[tuple[int, int, str, str, float]]) -> list[dict[str, Any]]:
    """Overlapping windows of the same kind become one event.

    A two-second window moving one second at a time reports the same laugh two
    or three times. Left unmerged, that is three audio events where there was
    one sound, and any rule counting them is counting the hop size.
    """
    ordered = sorted(hits, key=lambda hit: (hit[2], hit[0]))
    merged: list[dict[str, Any]] = []
    for start_ms, end_ms, kind, raw, score in ordered:
        last = merged[-1] if merged else None
        if last is not None and last["event_type"] == kind and start_ms <= last["end_ms"]:
            last["end_ms"] = max(last["end_ms"], end_ms)
            # The strongest window speaks for the run. Averaging would let a
            # long quiet stretch talk a clear detection down.
            if score > last["confidence"]:
                last["confidence"] = round(score, 3)
                last["raw_label"] = raw
            continue
        merged.append(
            {
                "start_ms": start_ms,
                "end_ms": end_ms,
                "event_type": kind,
                "raw_label": raw,
                "confidence": round(score, 3),
            }
        )
    merged.sort(key=lambda event: (event["start_ms"], event["event_type"]))
    return merged
