"""Text embeddings.

Three ways in, in order of preference:

1. An ONNX sentence encoder on disk, run through onnxruntime. This is the one to
   use. It needs `onnxruntime` and `tokenizers` and nothing else — no torch, no
   transformers, no network at any point after the files are in place — which
   makes it the cheapest real model in the whole pipeline to deploy.
2. A sentence-transformers model, for people who already have that stack.
3. The hashing vectoriser, which is not a model.

The third is not a stub: it is what makes search work on a machine with nothing
installed, and it is mirrored exactly in TypeScript so the two sides agree. It
is also **lexical**, and the difference is not subtle. Measured here, with the
hashing vectoriser, `cos("夜景", "night view of the city")` is exactly 0.0 —
not low, zero, because the two strings share no character n-grams. With
multilingual-e5-large the same pair scores 0.85 while `cos("夜景", "料理を
食べている")` scores 0.78, so the ordering that search depends on exists at all.

Which one is in use has to be visible from outside this module, because the
worker advertises its capabilities and the client decides the analysis tier from
them. `describe()` exists for that and must never flatter.
"""

from __future__ import annotations

import os
from typing import Any

from . import hashing

DEFAULT_MODEL = os.environ.get("OEA_TEXT_MODEL", "")

# e5 and its relatives are asymmetric: they are trained expecting the stored
# side and the searched side to announce which they are. Dropping the prefixes,
# or using the same one on both sides, measurably degrades cross-lingual
# ranking. Changing this convention invalidates an existing index — vectors
# written under one convention and searched under another are the "two
# embedding spaces in one index" bug this project has already been bitten by.
PREFIXES = {"query": "query: ", "passage": "passage: "}

HASHING_MODEL = f"hashing-{hashing.DEFAULT_DIM}"


class OnnxTextEmbedding:
    """A sentence encoder as two files and no framework.

    Mean-pools the last hidden state over the attention mask and L2-normalises,
    which is what the e5/BGE family is trained for. The vectors come back unit
    length so that cosine similarity is a dot product and the index needs no
    normalisation step of its own.
    """

    def __init__(self, model_dir: str, *, threads: int = 0, max_length: int = 512):
        import numpy as np  # noqa: PLC0415
        import onnxruntime as ort  # noqa: PLC0415
        from tokenizers import Tokenizer  # noqa: PLC0415

        self._np = np
        options = ort.SessionOptions()
        if threads > 0:
            options.intra_op_num_threads = threads
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            os.path.join(model_dir, "model.onnx"),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        # Which inputs this particular export actually takes. Some encoders want
        # token_type_ids and some reject it, and feeding one it did not declare
        # is an error rather than an ignored key.
        self.inputs = {value.name for value in self.session.get_inputs()}
        self.tokenizer = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=max_length)
        self.tokenizer.enable_padding()
        self.name = os.path.basename(os.path.normpath(model_dir))
        self.dim = 0

    def encode(self, texts: list[str], prefix: str, batch_size: int = 16) -> list[list[float]]:
        """Vectors for a list of texts, in order.

        One measured property worth knowing: at int8 the same text embedded
        alone and embedded alongside others differs by about 0.995 cosine. It is
        not the padding — equal-length texts drift by the same amount, and the
        identical call repeated is exact — it is the quantised kernels taking
        different paths at different batch shapes.

        That is far below anything that reorders a search result, and it does
        not break the project's determinism rule, because the same input
        produces the same batches. It does mean vectors are not comparable
        across differently-shaped runs, so a partial re-embed must re-embed
        everything rather than patch the events that changed.
        """
        np = self._np
        batches = []
        for start in range(0, len(texts), batch_size):
            chunk = [prefix + text for text in texts[start : start + batch_size]]
            encoded = self.tokenizer.encode_batch(chunk)
            ids = np.array([item.ids for item in encoded], dtype=np.int64)
            mask = np.array([item.attention_mask for item in encoded], dtype=np.int64)
            feed = {
                "input_ids": ids,
                "attention_mask": mask,
                "token_type_ids": np.zeros_like(ids),
            }
            hidden = self.session.run(
                None, {key: value for key, value in feed.items() if key in self.inputs}
            )[0]
            # Mean over real tokens only: padding carries no meaning and
            # averaging it in makes a short sentence drift toward the padding.
            weights = mask[..., None].astype(np.float32)
            pooled = (hidden * weights).sum(1) / np.clip(weights.sum(1), 1e-9, None)
            batches.append(pooled)

        stacked = np.concatenate(batches, 0).astype(np.float32)
        stacked = stacked / np.clip(np.linalg.norm(stacked, axis=1, keepdims=True), 1e-9, None)
        self.dim = int(stacked.shape[1])
        return [[round(float(value), 6) for value in row] for row in stacked]


def load(model_name: str | None = None):
    """The best encoder this machine can offer, or None for the hashing path.

    Never raises. An embedding model is an improvement on search, not a
    prerequisite for analysing footage, so a missing or broken one costs the
    improvement rather than the run — and `describe()` reports what happened so
    that nothing downstream claims a model it did not get.
    """
    # Resolved here rather than as a default argument, which would bind the
    # value at import and make the choice untestable and unchangeable.
    if model_name is None:
        model_name = DEFAULT_MODEL
    if not model_name:
        return None

    # A directory is an ONNX export. A name is for sentence-transformers.
    if os.path.isdir(model_name) and os.path.exists(os.path.join(model_name, "model.onnx")):
        try:
            return OnnxTextEmbedding(model_name)
        except Exception:  # noqa: BLE001
            return None

    try:
        from sentence_transformers import SentenceTransformer  # noqa: PLC0415
    except ImportError:
        # Not an error: the hashing fallback covers it, and saying so beats
        # failing a run over an optional improvement.
        return None
    try:
        return SentenceTransformer(model_name)
    except Exception:  # noqa: BLE001
        return None


_RESOLVED: list[Any] = []


def resolve():
    """The process-wide encoder, loaded at most once.

    Loading an ONNX session costs about 1.6 seconds and a gigabyte of resident
    memory, and three separate callers want to know about this model: the
    handler that embeds, the capability report, and the stage-name report. Doing
    it per call made answering "can you embed text?" more expensive than
    embedding.
    """
    if not _RESOLVED:
        _RESOLVED.append(load())
    return _RESOLVED[0]


def forget() -> None:
    """Drops the memoised encoder. For tests that change the configuration."""
    _RESOLVED.clear()


def available() -> bool:
    """Whether a real model will actually be used.

    The worker used to advertise `embed_text: True` unconditionally while
    `load()` quietly returned None and `embed()` fell through to hashing. The
    client believed the advertisement, wired a worker-backed encoder that does
    not declare itself a stand-in, and the resulting IR was stamped as a
    full-strength analysis whose search could not match 夜景 to "night view" at
    all. Capability has to mean capability.
    """
    return resolve() is not None


def describe() -> str:
    """The name that decides this stage's output, for the cache key and the record."""
    model = resolve()
    if model is None:
        return HASHING_MODEL
    return getattr(model, "name", None) or DEFAULT_MODEL or "sentence-transformers"


def embed(model, texts: list[str], role: str = "passage") -> dict[str, Any]:
    if model is None:
        vectors = [hashing.embed(text) for text in texts]
        return {"model": HASHING_MODEL, "dim": hashing.DEFAULT_DIM, "vectors": vectors}

    prefix = PREFIXES.get(role, "")

    if isinstance(model, OnnxTextEmbedding):
        vectors = model.encode(texts, prefix)
        return {
            "model": model.name,
            "dim": model.dim or (len(vectors[0]) if vectors else 1),
            "vectors": vectors,
        }

    encoded = model.encode(
        [prefix + text for text in texts], normalize_embeddings=True, show_progress_bar=False
    )
    vectors = [[round(float(value), 6) for value in row] for row in encoded]
    return {
        "model": DEFAULT_MODEL,
        "dim": len(vectors[0]) if vectors else 1,
        "vectors": vectors,
    }
