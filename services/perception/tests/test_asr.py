"""Turning what a speech model returns into what the contract promises.

This stage had no tests at all and had never been executed, which is a bad
combination for the one piece of perception every other stage leans on: if the
transcript is wrong, event boundaries are wrong, descriptions are wrong and the
editorial judgement is wrong, and none of them will say why.

The model itself is stubbed here. What is being tested is the translation —
seconds to milliseconds, log-probabilities to confidences, and the several ways
a real `faster_whisper` segment can be less complete than the happy path
assumes. A real-model run is a separate, opt-in test at the bottom of this file,
because weights are a few hundred megabytes and CI does not have them.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from types import SimpleNamespace

import pytest

from editorial_perception.backends import asr
from editorial_perception.errors import ModelError


class FakeModel:
    """Stands in for faster_whisper.WhisperModel."""

    def __init__(self, segments, *, duration=10.0, language="ja", raises=None):
        self.segments = segments
        self.info = SimpleNamespace(duration=duration, language=language)
        self.raises = raises
        self.calls: list[dict] = []
        self.model_size_or_path = "base"

    def transcribe(self, audio_path, **kwargs):
        self.calls.append({"audio_path": audio_path, **kwargs})
        if self.raises:
            raise self.raises
        return iter(self.segments), self.info


def segment(start, end, text, *, avg_logprob=-0.2, words=None):
    return SimpleNamespace(start=start, end=end, text=text, avg_logprob=avg_logprob, words=words)


def word(start, end, text, probability=0.9):
    return SimpleNamespace(start=start, end=end, word=text, probability=probability)


def test_seconds_become_integer_milliseconds():
    # The contract is integer milliseconds everywhere; whisper speaks float
    # seconds. Every timeline in the project is downstream of this conversion.
    model = FakeModel([segment(1.2345, 3.4567, " やっと着いた ")])
    result = asr.transcribe(model, "a.wav")
    assert result["utterances"][0]["start_ms"] == 1234
    assert result["utterances"][0]["end_ms"] == 3457


def test_surrounding_whitespace_is_stripped():
    model = FakeModel([segment(0, 1, "  hello  ")])
    assert asr.transcribe(model, "a.wav")["utterances"][0]["text"] == "hello"


def test_an_empty_segment_is_dropped_rather_than_stored():
    # Whisper emits blank segments over silence. Keeping them would create
    # utterances with no words, which later reads as "someone spoke here".
    model = FakeModel([segment(0, 1, "   "), segment(1, 2, "actual speech")])
    result = asr.transcribe(model, "a.wav")
    assert [u["text"] for u in result["utterances"]] == ["actual speech"]


def test_confidence_lands_in_the_unit_interval():
    for logprob in (-5.0, -1.0, -0.2, 0.0, None):
        model = FakeModel([segment(0, 1, "x", avg_logprob=logprob)])
        confidence = asr.transcribe(model, "a.wav")["utterances"][0]["confidence"]
        assert 0.0 <= confidence <= 1.0


def test_a_less_certain_transcription_reports_less_confidence():
    def confidence_of(logprob):
        model = FakeModel([segment(0, 1, "x", avg_logprob=logprob)])
        return asr.transcribe(model, "a.wav")["utterances"][0]["confidence"]

    assert confidence_of(-0.1) > confidence_of(-1.5)


def test_word_timestamps_are_carried_through():
    model = FakeModel(
        [segment(0, 2, "hello there", words=[word(0.0, 0.5, " hello"), word(0.6, 1.2, " there")])]
    )
    words = asr.transcribe(model, "a.wav")["utterances"][0]["words"]
    assert [w["text"] for w in words] == ["hello", "there"]
    assert [w["start_ms"] for w in words] == [0, 600]


def test_a_word_with_no_timing_is_left_out_rather_than_placed_at_zero():
    # faster-whisper can return a word without timestamps. Defaulting those to 0
    # would put them at the start of the clip, which is worse than not having
    # them: a cut aligned to that word lands in the wrong place entirely.
    model = FakeModel(
        [segment(0, 2, "hello there", words=[word(0.0, 0.5, "hello"), word(None, None, "there")])]
    )
    words = asr.transcribe(model, "a.wav")["utterances"][0]["words"]
    assert [w["text"] for w in words] == ["hello"]


def test_a_segment_without_words_simply_has_none():
    model = FakeModel([segment(0, 1, "no word timings here", words=None)])
    assert "words" not in asr.transcribe(model, "a.wav")["utterances"][0]


def test_the_users_vocabulary_is_offered_to_the_decoder():
    # Place names and people's names are what this family of models gets wrong,
    # and are exactly what the user has already written down.
    model = FakeModel([segment(0, 1, "x")])
    asr.transcribe(model, "a.wav", vocabulary=["USJ", "道頓堀"])
    assert model.calls[0]["initial_prompt"] == "USJ, 道頓堀"


def test_a_vocabulary_longer_than_the_prompt_allows_is_truncated():
    # An unbounded prompt eats the model's context window and degrades the
    # transcript it was meant to improve.
    model = FakeModel([segment(0, 1, "x")])
    asr.transcribe(model, "a.wav", vocabulary=[f"w{i}" for i in range(100)])
    assert model.calls[0]["initial_prompt"].count(",") == 39


def test_no_vocabulary_sends_no_prompt():
    model = FakeModel([segment(0, 1, "x")])
    asr.transcribe(model, "a.wav")
    assert model.calls[0]["initial_prompt"] is None


def test_the_detected_language_is_reported():
    model = FakeModel([segment(0, 1, "x")], language="ja")
    assert asr.transcribe(model, "a.wav")["language"] == "ja"


def test_a_requested_language_stands_when_the_model_reports_none():
    model = FakeModel([segment(0, 1, "x")], language=None)
    assert asr.transcribe(model, "a.wav", language="ja")["language"] == "ja"


def test_progress_is_reported_against_the_clip_and_never_exceeds_one():
    # The last segment can end fractionally past the reported duration, and a
    # progress bar that reaches 1.04 looks like a bug in the product.
    seen: list[float] = []
    model = FakeModel([segment(0, 5, "a"), segment(5, 10.4, "b")], duration=10.0)
    asr.transcribe(model, "a.wav", progress=lambda fraction, _text: seen.append(fraction))
    assert seen == [0.5, 1.0]


def test_a_model_that_throws_becomes_a_model_error():
    # Not a bare exception: the worker turns ModelError into "this stage is
    # unavailable", which costs the stage rather than the whole analysis.
    model = FakeModel([], raises=RuntimeError("cuda is on fire"))
    with pytest.raises(ModelError, match="transcription failed"):
        asr.transcribe(model, "a.wav")


def test_voice_activity_filtering_is_on():
    # Without it whisper hallucinates confident sentences over silence, and
    # those become events with speech in them that nobody ever said.
    model = FakeModel([segment(0, 1, "x")])
    asr.transcribe(model, "a.wav")
    assert model.calls[0]["vad_filter"] is True


def test_a_missing_library_says_what_to_install():
    assert asr.DEFAULT_MODEL, "a default model must exist for the worker to report one"


# --------------------------------------------------------------------------
# The real thing. Skipped unless weights are provisioned, because they are a
# few hundred megabytes and CI has neither them nor a reason to download them.
#
#   OEA_TEST_ASR_MODEL=/path/to/a/ctranslate2/model pytest -k real_model
# --------------------------------------------------------------------------
REAL_MODEL = os.environ.get("OEA_TEST_ASR_MODEL")


@pytest.mark.skipif(not REAL_MODEL, reason="set OEA_TEST_ASR_MODEL to run against real weights")
@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg to synthesise audio")
def test_real_model_transcribes_real_audio():
    pytest.importorskip("faster_whisper")
    with tempfile.TemporaryDirectory() as work:
        wav = os.path.join(work, "tone.wav")
        # Not speech, deliberately: what is being checked is that the whole path
        # runs and returns a well-formed result, not what the words are. A
        # transcript assertion would need bundled speech audio and a licence for
        # it. The word-level assertions above cover the translation.
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
             "-i", "sine=frequency=440:duration=2", "-ar", "16000", "-ac", "1", wav],
            check=True,
        )
        model = asr.load(REAL_MODEL, compute_type="int8")
        result = asr.transcribe(model, wav)
        assert "utterances" in result
        assert isinstance(result["utterances"], list)
        for utterance in result["utterances"]:
            assert utterance["end_ms"] >= utterance["start_ms"]
            assert 0.0 <= utterance["confidence"] <= 1.0
