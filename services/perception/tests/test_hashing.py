"""The hashing embedding must be identical in both runtimes.

An index built by TypeScript and queried by Python has to land in the same
space. If it does not, search does not fail — it silently returns noise, which
is far harder to notice. The golden file is generated from the TypeScript
implementation by `scripts/make-hashing-golden.ts`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from editorial_perception.backends import hashing

GOLDEN = json.loads((Path(__file__).parent / "hashing_golden.json").read_text(encoding="utf-8"))


def test_dimension_matches():
    assert GOLDEN["dim"] == hashing.DEFAULT_DIM


@pytest.mark.parametrize("text", list(GOLDEN["normalize"].keys()))
def test_normalisation_matches(text: str):
    assert hashing.normalize_text(text) == GOLDEN["normalize"][text]


@pytest.mark.parametrize("text", list(GOLDEN["fnv1a"].keys()))
def test_hash_matches(text: str):
    assert hashing.fnv1a(text) == GOLDEN["fnv1a"][text]


@pytest.mark.parametrize("text", list(GOLDEN["vectors"].keys()))
def test_vectors_match(text: str):
    produced = hashing.embed(text)
    expected = GOLDEN["vectors"][text]
    assert len(produced) == len(expected)
    for index, (a, b) in enumerate(zip(produced, expected, strict=True)):
        assert a == pytest.approx(b, abs=1e-9), f"dimension {index} of {text!r}"


def test_similar_text_scores_above_unrelated():
    def cosine(a: list[float], b: list[float]) -> float:
        return sum(x * y for x, y in zip(a, b, strict=True))

    query = hashing.embed("夜景がきれい")
    related = hashing.embed("夜景を見ている")
    unrelated = hashing.embed("ラーメンを食べている")
    assert cosine(query, related) > cosine(query, unrelated)


def test_empty_text_is_a_zero_vector():
    assert all(value == 0 for value in hashing.embed(""))
