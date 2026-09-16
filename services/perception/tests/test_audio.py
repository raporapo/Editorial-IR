"""Audio analysis, which must agree with the TypeScript implementation.

Which runtime performs it is a deployment detail, and an Editorial IR should not
change because the Python worker happened to be installed.
"""

from __future__ import annotations

from editorial_perception.backends import audio


def test_the_threshold_follows_the_recording_rather_than_a_fixed_number():
    quiet = [-70, -70, -70, -70, -52, -50, -51, -52, -70, -70, -70, -70]
    assert audio.silence_threshold(quiet, -40, 8) < -55

    noisy = [-30, -30, -10, -12, -11, -30, -30, -10, -11, -12]
    threshold = audio.silence_threshold(noisy, -40, 8)
    assert -40 < threshold < -20


def test_a_flat_recording_falls_back_and_claims_nothing():
    flat = [-25.0] * 20
    assert audio.silence_threshold(flat, -40, 8) < -25
    assert not audio.has_dynamic_range(flat)


def test_speech_probability_needs_both_level_and_zero_crossings():
    assert audio.speech_probability(-60, 0.08, -40) == 0
    voiced = audio.speech_probability(-20, 0.08, -40)
    assert voiced > audio.speech_probability(-20, 0.001, -40)
    assert voiced > audio.speech_probability(-20, 0.6, -40)


def test_percentile_survives_an_empty_series():
    assert audio.percentile([], 0.1) == -100.0
    assert audio.percentile([1, 2, 3, 4, 5], 0) == 1
