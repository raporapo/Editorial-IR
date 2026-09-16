"""Text embeddings.

A real model when one is installed, and the hashing vectoriser when not. The
fallback is not a stub: it is what makes search work on a machine with nothing
installed, and it is mirrored exactly in TypeScript so the two sides agree.
"""

from __future__ import annotations

import os
from typing import Any

from . import hashing

DEFAULT_MODEL = os.environ.get("OEA_TEXT_MODEL", "")


def load(model_name: str = DEFAULT_MODEL):
    if not model_name:
        return None
    try:
        from sentence_transformers import SentenceTransformer  # noqa: PLC0415
    except ImportError:
        # Not an error: the hashing fallback covers it, and saying so beats
        # failing a run over an optional improvement.
        return None
    return SentenceTransformer(model_name)


def embed(model, texts: list[str], role: str = "passage") -> dict[str, Any]:
    if model is None:
        vectors = [hashing.embed(text) for text in texts]
        return {"model": "hashing-256", "dim": hashing.DEFAULT_DIM, "vectors": vectors}

    # Asymmetric models want to know which side they are encoding; symmetric
    # ones ignore the hint.
    prompt = {"query": "query: ", "passage": "passage: "}.get(role, "")
    encoded = model.encode(
        [prompt + text for text in texts], normalize_embeddings=True, show_progress_bar=False
    )
    vectors = [[round(float(value), 6) for value in row] for row in encoded]
    return {
        "model": getattr(model, "model_card_data", None) and DEFAULT_MODEL or DEFAULT_MODEL,
        "dim": len(vectors[0]) if vectors else 1,
        "vectors": vectors,
    }
