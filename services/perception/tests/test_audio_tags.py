"""Laughter, music and applause — and the merging that makes them events.

The rule engine has had `has_laughter` and `has_music` since it was written and
nothing produced them, so those rules were unreachable. A rule that cannot fire
is worse than a missing one: it reads as implemented and quietly makes every
travel and reaction edit worse than the skill promises.

Most of what can go wrong here is not the model. It is the window arithmetic:
a two-second window moving one second at a time reports the same laugh three
times, and three audio events where there was one sound means any rule counting
them is counting the hop size.
"""

from __future__ import annotations

import os

import pytest

from editorial_perception.backends import audio_tags
from editorial_perception.backends.audio_tags import LABEL_MAP, available, describe, merge


def hit(start, end, kind, raw="Laughter", score=0.5):
    return (start, end, kind, raw, score)


def test_overlapping_windows_of_the_same_sound_become_one_event():
    events = merge(
        [hit(0, 2000, "laughter"), hit(1000, 3000, "laughter"), hit(2000, 4000, "laughter")]
    )
    assert len(events) == 1
    assert events[0]["start_ms"] == 0
    assert events[0]["end_ms"] == 4000


def test_the_strongest_window_speaks_for_the_run():
    # Averaging would let a long quiet stretch talk a clear detection down, and
    # the confidence is what a skill threshold reads.
    events = merge([hit(0, 2000, "laughter", score=0.3), hit(1000, 3000, "laughter", score=0.9)])
    assert events[0]["confidence"] == 0.9


def test_the_raw_label_follows_the_strongest_window():
    events = merge(
        [
            hit(0, 2000, "laughter", raw="Giggle", score=0.3),
            hit(1000, 3000, "laughter", raw="Belly laugh", score=0.9),
        ]
    )
    assert events[0]["raw_label"] == "Belly laugh"


def test_a_gap_means_two_sounds_rather_than_one_long_one():
    events = merge([hit(0, 2000, "laughter"), hit(9000, 11000, "laughter")])
    assert len(events) == 2


def test_windows_that_only_touch_are_still_one_sound():
    # A window skipped for falling under the threshold leaves the next one
    # starting exactly where the last ended. That is a continuing sound, not a
    # new one.
    events = merge([hit(0, 2000, "laughter"), hit(2000, 4000, "laughter")])
    assert len(events) == 1


def test_different_kinds_at_the_same_time_stay_separate():
    # Music under speech is two facts about the same moment.
    events = merge([hit(0, 2000, "music", raw="Music"), hit(0, 2000, "speech", raw="Speech")])
    assert {event["event_type"] for event in events} == {"music", "speech"}


def test_events_come_back_in_time_order():
    events = merge([hit(9000, 11000, "speech", raw="Speech"), hit(0, 2000, "music", raw="Music")])
    assert [event["start_ms"] for event in events] == [0, 9000]


def test_nothing_in_means_nothing_out():
    assert merge([]) == []


def test_every_mapped_label_lands_in_the_contracts_closed_set():
    # The contract's vocabulary is deliberately narrow so a backend cannot
    # invent tags no skill can match. A mapping that produces something outside
    # it fails validation at the boundary, one stage later and much less clearly.
    allowed = {
        "speech",
        "silence",
        "music",
        "laughter",
        "applause",
        "cheering",
        "crowd",
        "traffic",
        "nature",
        "noise",
        "other",
    }
    assert set(LABEL_MAP.values()) <= allowed


def test_the_labels_the_skills_actually_ask_about_are_mapped():
    # These four are what the rule engine exposes. If one stops being produced
    # the corresponding rule goes quiet without failing anything.
    assert set(LABEL_MAP.values()) >= {"laughter", "music", "applause", "cheering", "crowd"}


def test_no_model_configured_means_the_stage_does_not_run(monkeypatch):
    monkeypatch.setattr(audio_tags, "MODEL_DIR", "")
    assert available() is False
    assert describe() == ""


def test_a_directory_without_weights_is_not_a_model(monkeypatch, tmp_path):
    monkeypatch.setattr(audio_tags, "MODEL_DIR", str(tmp_path))
    assert available() is False


def test_availability_does_not_load_the_model(monkeypatch, tmp_path):
    # Answering "can you tag audio?" must not cost a model load; `health` asks
    # it on every worker startup.
    (tmp_path / "model.int8.onnx").write_bytes(b"not really a model")
    monkeypatch.setattr(audio_tags, "MODEL_DIR", str(tmp_path))
    assert available() is True


# --------------------------------------------------------------------------
# The real model, opt-in.
#
#   OEA_TEST_AUDIO_TAGGER=/path/to/model/dir pytest -k real_model
# --------------------------------------------------------------------------
REAL = os.environ.get("OEA_TEST_AUDIO_TAGGER")
skip_unless_real = pytest.mark.skipif(
    not REAL, reason="set OEA_TEST_AUDIO_TAGGER to run against real weights"
)


@skip_unless_real
def test_real_model_finds_music_in_music():
    wavs = os.path.join(REAL, "test_wavs", "2.wav")
    if not os.path.exists(wavs):
        pytest.skip("this model ships no sample audio")
    loaded = audio_tags.load(REAL)
    result = audio_tags.tag(loaded, wavs)
    assert "music" in {event["event_type"] for event in result["events"]}


@skip_unless_real
def test_real_model_gives_every_event_a_time_range_inside_the_clip():
    wavs = os.path.join(REAL, "test_wavs", "2.wav")
    if not os.path.exists(wavs):
        pytest.skip("this model ships no sample audio")
    loaded = audio_tags.load(REAL)
    result = audio_tags.tag(loaded, wavs)
    assert result["events"], "expected at least one event"
    for event in result["events"]:
        assert event["end_ms"] > event["start_ms"]
        assert 0.0 <= event["confidence"] <= 1.0


@skip_unless_real
def test_real_model_says_nothing_about_silence_it_cannot_hear(tmp_path):
    import subprocess

    quiet = tmp_path / "quiet.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=16000:cl=mono",
            "-t",
            "3",
            str(quiet),
        ],
        check=True,
    )
    loaded = audio_tags.load(REAL)
    result = audio_tags.tag(loaded, str(quiet))
    # Whatever it says about digital silence, it must not claim people.
    assert "laughter" not in {event["event_type"] for event in result["events"]}
    assert "applause" not in {event["event_type"] for event in result["events"]}
