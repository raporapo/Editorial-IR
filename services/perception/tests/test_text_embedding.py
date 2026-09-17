"""Which encoder is in use, and whether the worker admits it.

The interesting bug here was never in the maths. It was that the worker
advertised `embed_text: True` unconditionally while the loader returned None and
the stage fell through to lexical hashing. The client believed the
advertisement, wired a worker-backed encoder that does not declare itself a
stand-in, and stamped the resulting IR as a full-strength analysis whose search
scored `cos("夜景", "night view of the city")` at exactly 0.0 — not low, zero,
because the two strings share no character n-grams.

So most of what is tested here is honesty rather than arithmetic.
"""

from __future__ import annotations

import os

import pytest

from editorial_perception.backends import text_embedding
from editorial_perception.backends.text_embedding import (
    HASHING_MODEL,
    PREFIXES,
    available,
    describe,
    embed,
    forget,
    load,
)


@pytest.fixture(autouse=True)
def _fresh_resolution():
    """The encoder is memoised process-wide; these tests change what it resolves to."""
    forget()
    yield
    forget()


def test_no_model_configured_means_no_model(monkeypatch):
    monkeypatch.setattr(text_embedding, "DEFAULT_MODEL", "")
    assert load("") is None
    assert available() is False


def test_the_fallback_says_it_is_the_fallback(monkeypatch):
    monkeypatch.setattr(text_embedding, "DEFAULT_MODEL", "")
    # The name is what the cache keys on and what the record shows. Reporting a
    # model name here while returning hashing vectors is how one stage's
    # vectors get served under another's key.
    assert describe() == HASHING_MODEL


def test_the_fallback_still_produces_usable_vectors():
    result = embed(None, ["夜景", "night view"])
    assert result["model"] == HASHING_MODEL
    assert result["dim"] == len(result["vectors"][0])
    assert len(result["vectors"]) == 2


def test_a_directory_that_is_not_an_onnx_export_is_not_loaded(tmp_path):
    # A path with no model.onnx is a configuration mistake, and answering it
    # with None costs search rather than the whole analysis.
    assert load(str(tmp_path)) is None


def test_a_model_that_cannot_be_loaded_costs_the_stage_and_not_the_run(tmp_path):
    broken = tmp_path / "model.onnx"
    broken.write_bytes(b"this is not a protobuf")
    (tmp_path / "tokenizer.json").write_text("{}")
    assert load(str(tmp_path)) is None


def test_the_asymmetric_prefixes_are_the_ones_e5_expects():
    # Not cosmetic. Indexing with one convention and searching with another is
    # the "two embedding spaces in one index" failure, and it produces a
    # confident ranking out of noise rather than an error.
    assert PREFIXES["query"] == "query: "
    assert PREFIXES["passage"] == "passage: "


def test_an_unknown_role_adds_no_prefix():
    class Recorder:
        def encode(self, texts, **_kwargs):
            self.seen = texts
            return [[0.1, 0.2]] * len(texts)

    recorder = Recorder()
    embed(recorder, ["hello"], role="something-else")
    assert recorder.seen == ["hello"]


def test_a_sentence_transformers_model_gets_the_prefix():
    class Recorder:
        def encode(self, texts, **_kwargs):
            self.seen = texts
            return [[0.1, 0.2]] * len(texts)

    recorder = Recorder()
    embed(recorder, ["hello"], role="passage")
    assert recorder.seen == ["passage: hello"]


# --------------------------------------------------------------------------
# The real thing, opt-in. The model is ~550 MB.
#
#   OEA_TEST_TEXT_MODEL=/path/to/e5-large-int8 pytest -k real_model
# --------------------------------------------------------------------------
REAL_MODEL = os.environ.get("OEA_TEST_TEXT_MODEL")
skip_unless_real = pytest.mark.skipif(
    not REAL_MODEL, reason="set OEA_TEST_TEXT_MODEL to run against a real encoder"
)


@skip_unless_real
def test_real_model_is_reported_as_available(monkeypatch):
    monkeypatch.setattr(text_embedding, "DEFAULT_MODEL", REAL_MODEL)
    assert available() is True
    assert describe() != HASHING_MODEL


@skip_unless_real
def test_real_model_ranks_across_languages():
    # The whole reason for replacing the lexical stand-in. With hashing this
    # comparison is 0.0 against 0.0 and there is no ordering to get right.
    model = load(REAL_MODEL)
    assert model is not None
    result = embed(model, ["夜景", "night view of the city", "料理を食べている"], role="query")
    night_ja, night_en, food_ja = result["vectors"]

    def cosine(a, b):
        return sum(x * y for x, y in zip(a, b, strict=True))

    assert cosine(night_ja, night_en) > cosine(night_ja, food_ja)


@skip_unless_real
def test_real_model_returns_unit_vectors():
    # The index treats cosine as a dot product and does not normalise itself.
    model = load(REAL_MODEL)
    result = embed(model, ["a train arriving at the platform"], role="passage")
    length = sum(value * value for value in result["vectors"][0]) ** 0.5
    assert abs(length - 1.0) < 1e-3


@skip_unless_real
def test_real_model_reports_the_width_it_actually_produced():
    # The index refuses to compare vectors of different widths, so a dim that
    # disagrees with the vectors is worse than no dim at all.
    model = load(REAL_MODEL)
    result = embed(model, ["one", "two"], role="passage")
    assert result["dim"] == len(result["vectors"][0])
    assert len(result["vectors"][0]) == len(result["vectors"][1])


@skip_unless_real
def test_real_model_is_exactly_repeatable():
    # The project's determinism rule: the same input compiles to the same IR,
    # byte for byte. That holds because the same input produces the same batches.
    model = load(REAL_MODEL)
    once = embed(model, ["夜景"], role="passage")["vectors"][0]
    twice = embed(model, ["夜景"], role="passage")["vectors"][0]
    assert once == twice


@skip_unless_real
def test_real_model_vectors_shift_slightly_with_batch_shape():
    # Measured rather than assumed, and asserted so the size of it is pinned.
    #
    # The obvious guess is that padding leaks into the mean. It does not:
    # equal-length texts drift by the same amount, and the identical call
    # repeated is exact. It is the int8 kernels taking different paths at
    # different batch shapes.
    #
    # ~0.995 is far below anything that reorders a search result, and it is why
    # a partial re-embed has to re-embed everything rather than patch the
    # events that changed.
    model = load(REAL_MODEL)
    alone = embed(model, ["夜景"], role="passage")["vectors"][0]
    batched = embed(
        model,
        ["夜景", "a much longer sentence that will pad the shorter one considerably"],
        role="passage",
    )["vectors"][0]
    drift = sum(x * y for x, y in zip(alone, batched, strict=True))
    assert 0.99 < drift < 1.0
