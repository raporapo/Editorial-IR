"""Loudness, silence and speech presence, from the prepared WAV.

The same algorithm as the TypeScript implementation, deliberately: which one
runs is a deployment detail, and an Editorial IR should not change because the
Python runtime happened to be installed.

It stops short of classifying laughter, applause or music, which need a trained
audio tagger. What it does cover is where the quiet is, which is what lets a cut
land between words instead of through one.
"""

from __future__ import annotations

import math
import wave
from typing import Any

MIN_DYNAMIC_RANGE_DB = 10.0
ZCR_LOW = 0.01
ZCR_HIGH = 0.3


def analyze(
    audio_path: str,
    hop_ms: int = 100,
    silence_threshold_db: float = -40.0,
    *,
    silence_margin_db: float = 8.0,
    min_silence_ms: int = 300,
    min_speech_ms: int = 400,
) -> dict[str, Any]:
    rms_db, zcr = _hop_statistics(audio_path, hop_ms)
    threshold = silence_threshold(rms_db, silence_threshold_db, silence_margin_db)
    measurable = has_dynamic_range(rms_db)

    # With no dynamic range there is nothing to measure: a constant tone, a
    # constant hiss and a muted track look identical to an energy detector, and
    # none of them is speech. Reporting zero is the honest answer.
    speech_prob = (
        [speech_probability(db, z, threshold) for db, z in zip(rms_db, zcr, strict=False)]
        if measurable
        else [0.0] * len(rms_db)
    )

    events: list[dict[str, Any]] = []
    for start, end in _runs([db < threshold for db in rms_db]):
        if (end - start) * hop_ms >= min_silence_ms:
            events.append(
                {
                    "start_ms": start * hop_ms,
                    "end_ms": end * hop_ms,
                    "event_type": "silence",
                    "confidence": 0.8,
                }
            )
    for start, end in _runs([p >= 0.5 for p in speech_prob]):
        if (end - start) * hop_ms >= min_speech_ms:
            events.append(
                # Energy and zero crossings are a weak speech detector, and the
                # confidence says so: a transcriber will overwrite this.
                {
                    "start_ms": start * hop_ms,
                    "end_ms": end * hop_ms,
                    "event_type": "speech",
                    "confidence": 0.5,
                }
            )
    events.sort(key=lambda event: (event["start_ms"], event["event_type"]))

    return {
        "model": "rms-zcr",
        "hop_ms": hop_ms,
        "rms_db": [round(db, 2) for db in rms_db],
        "speech_prob": [round(p, 3) for p in speech_prob],
        "events": events,
    }


def silence_threshold(rms_db: list[float], configured_db: float, margin_db: float) -> float:
    """Where silence begins, for this recording.

    A fixed threshold is wrong in both directions: a quiet indoor recording never
    reaches it and reads as silent throughout, and a windy street never drops
    below it and reads as continuous sound.
    """
    floor = percentile(rms_db, 0.1)
    ceiling = percentile(rms_db, 0.9)
    if ceiling - floor < MIN_DYNAMIC_RANGE_DB:
        return min(configured_db, floor - 1)
    return floor + min(margin_db, (ceiling - floor) * 0.3)


def has_dynamic_range(rms_db: list[float]) -> bool:
    return percentile(rms_db, 0.9) - percentile(rms_db, 0.1) >= MIN_DYNAMIC_RANGE_DB


def speech_probability(rms_db: float, zcr: float, threshold_db: float) -> float:
    if rms_db < threshold_db:
        return 0.0
    loudness = max(0.0, min(1.0, (rms_db - threshold_db) / 18))
    band = 1.0 if ZCR_LOW <= zcr <= ZCR_HIGH else (0.3 if zcr < ZCR_LOW else 0.4)
    return round(max(0.0, min(1.0, loudness * band)), 3)


def percentile(values: list[float], q: float) -> float:
    if not values:
        return -100.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * q)))
    return ordered[index]


def _runs(flags: list[bool]) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, flag in enumerate(flags):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(flags)))
    return runs


def _hop_statistics(path: str, hop_ms: int) -> tuple[list[float], list[float]]:
    """Per-hop loudness and zero-crossing rate, in one pass.

    Read in blocks so an hour of audio costs a megabyte of memory rather than a
    hundred.
    """
    with wave.open(path, "rb") as source:
        if source.getsampwidth() != 2:
            raise ValueError(f"expected 16-bit PCM, got {source.getsampwidth() * 8}-bit")
        channels = source.getnchannels()
        rate = source.getframerate()
        frames_per_hop = max(1, round(rate * hop_ms / 1000))

        rms_db: list[float] = []
        zcr: list[float] = []
        sum_squares = 0.0
        crossings = 0
        in_hop = 0
        previous = 0.0
        have_previous = False

        while True:
            block = source.readframes(frames_per_hop * 16)
            if not block:
                break
            for offset in range(0, len(block) - channels * 2 + 1, channels * 2):
                total = 0
                for channel in range(channels):
                    start = offset + channel * 2
                    total += int.from_bytes(block[start : start + 2], "little", signed=True)
                sample = total / channels / 32768

                sum_squares += sample * sample
                if have_previous and (previous >= 0) != (sample >= 0):
                    crossings += 1
                previous = sample
                have_previous = True
                in_hop += 1

                if in_hop == frames_per_hop:
                    rms_db.append(_to_db(math.sqrt(sum_squares / in_hop)))
                    zcr.append(crossings / in_hop)
                    sum_squares = 0.0
                    crossings = 0
                    in_hop = 0

        if in_hop > 0:
            rms_db.append(_to_db(math.sqrt(sum_squares / in_hop)))
            zcr.append(crossings / in_hop)

    return rms_db, zcr


def _to_db(amplitude: float) -> float:
    if amplitude <= 1e-10:
        return -100.0
    return max(-100.0, 20 * math.log10(amplitude))
