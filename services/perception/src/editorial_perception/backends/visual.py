"""Frame embeddings, zero-shot labels, and queries in the same space.

Two ways in, in order of how likely they are to work:

1. **A CLIP ONNX export on disk**, run by onnxruntime. Two graphs and a
   vocabulary file, no torch, no transformers, no model hub at any point after
   the files are in place. `OEA_VISUAL_MODEL=/path/to/clip-vit-b32`.
2. **A transformers checkpoint**, for people who already have that stack and can
   reach a hub. SigLIP by default.

The second was the only one for a long time, and it is worth being plain about
what that cost: it needs ~2 GB of wheels and a reachable huggingface.co, and on
a machine without either — which is where this was developed, and which is
ordinary inside companies — `embed_frames` simply never ran. The IR went out
with no visual vectors at all and nothing said so. See `clip_onnx.py`.

What matters is not which model. It is that the vectors it produces and the
vectors a query is encoded with come from the same model, because comparing
across embedding spaces produces a confident ranking out of noise. The index
refuses to compare vectors of different widths for that reason — and that refusal
was, until this stage grew a text tower, the only thing standing between the
project and exactly that bug. Frame vectors went into the `visual` aspect 512
wide, queries arrived 1024 wide from the sentence encoder, and the aspect was
reported unsearchable on every single search. Every frame embedded, none of it
askable. `encode_text` is what closes that.

## The text tower is English, and the first users are not

Both CLIP and SigLIP-base have English-only text towers. Measured on CLIP
ViT-B/32: six frames against six English descriptions scored 6/6 top-1, and the
same six concepts asked in Japanese scored 4/6 with the margins at noise level.

That matters because natural-language footage search is a headline feature and
"夜景が映っているところ" is how the people this is being built for would ask.
Nothing here can fix it — a model whose text encoder never saw Japanese cannot
be made to rank Japanese — so `text_language` reports what the loaded tower
actually reads, the client declines to use it for a query it cannot serve, and
that query falls back to the text index, which does read Japanese. The way out
is a multilingual checkpoint (`OEA_VISUAL_MODEL` exists for exactly this: SigLIP
publishes a multilingual variant and open_clip publishes an XLM-R one), not a
silent bad answer.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

from ..errors import MissingDependency, ModelError
from . import clip_onnx

DEFAULT_MODEL = os.environ.get("OEA_VISUAL_MODEL", "google/siglip-base-patch16-224")

# Which natural language a checkpoint's text tower can be queried in. There is
# no way to ask a model this, and getting it wrong in the optimistic direction
# is worse than not knowing: a Japanese query against an English tower returns a
# confident ranking of noise rather than an error. So the default is the
# conservative one and a multilingual checkpoint has to say so by name.
MULTILINGUAL_MARKERS = ("multilingual", "xlm", "-m-", "mclip", "m-clip", "jina-clip", "bge-vl")


def text_language(model_name: str) -> str:
    """`en` or `multi`. Conservative by construction; see MULTILINGUAL_MARKERS."""
    lowered = os.path.basename(os.path.normpath(model_name)).lower()
    return "multi" if any(marker in lowered for marker in MULTILINGUAL_MARKERS) else "en"


def load(model_name: str | None = None):
    """The visual model this machine can offer. Raises rather than pretending."""
    # Resolved in the body rather than as a default argument, which would bind
    # the value at import and make the choice untestable.
    if model_name is None:
        model_name = DEFAULT_MODEL
    if not model_name:
        raise MissingDependency("visual embeddings", "a model in OEA_VISUAL_MODEL")

    if clip_onnx.is_onnx_clip(model_name):
        model = clip_onnx.ClipOnnx(model_name)
        return {
            "kind": "onnx",
            "clip": model,
            "name": model.name,
            "text_language": text_language(model.name),
        }

    try:
        import torch  # noqa: PLC0415
        from transformers import AutoModel, AutoProcessor  # noqa: PLC0415
    except ImportError as error:
        raise MissingDependency(
            "visual embeddings", "transformers, or a CLIP ONNX export"
        ) from error

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = AutoModel.from_pretrained(model_name).to(device).eval()
        processor = AutoProcessor.from_pretrained(model_name)
    except Exception as error:  # noqa: BLE001
        raise ModelError(f"could not load the visual model {model_name!r}: {error}") from error

    return {
        "kind": "transformers",
        "model": model,
        "processor": processor,
        "device": device,
        "name": model_name,
        "text_language": text_language(model_name),
    }


def available() -> bool:
    """Whether this stage will actually run, answered as cheaply as it honestly can.

    An ONNX export is a file that is either there or not, so the check is a
    `stat` and it cannot be wrong. A transformers checkpoint is a name that may
    or may not resolve to weights this machine can reach, and `_importable` is
    not the same question — a worker that says yes because `transformers` is
    installed, then fails to reach the hub, turns "this stage is unavailable"
    into "the analysis failed". So that path is asked by loading, once, and
    remembered.
    """
    if clip_onnx.is_onnx_clip(DEFAULT_MODEL):
        return True
    if not DEFAULT_MODEL:
        return False
    return resolve() is not None


_RESOLVED: list[Any] = []


def resolve():
    """The process-wide visual model, loaded at most once, or None.

    `available`, `describe` and the handler all want to know about this model,
    and loading two ONNX sessions costs about two seconds and several hundred
    megabytes resident. Doing it per caller made answering "can you embed
    frames?" more expensive than embedding.
    """
    if not _RESOLVED:
        try:
            _RESOLVED.append(load())
        except Exception:  # noqa: BLE001
            _RESOLVED.append(None)
    return _RESOLVED[0]


def forget() -> None:
    """Drops the memoised model. For tests that change the configuration."""
    _RESOLVED.clear()


def describe() -> str:
    """The name that decides this stage's output, for the cache key and the record.

    Reports the configured name even when the model will not load, because
    `capabilities.embed_frames` is what says whether the stage runs and a client
    that knows what was *asked for* can say so in `oea doctor`. What it never
    reports is a filesystem path: a locally-provisioned model is pointed at with
    an absolute directory, and that directory was going into the cache key and
    into every ModelRun record — putting somebody's home directory inside a
    document meant to be shared, and missing the cache for the same model moved
    elsewhere.
    """
    loaded = resolve()
    name = str(loaded["name"]) if loaded is not None else DEFAULT_MODEL
    if not name:
        return ""
    # A repo id like "google/siglip-base-patch16-224" is a name and keeps both
    # halves; anything that exists on disk keeps only its last component.
    if os.path.exists(name):
        return os.path.basename(os.path.normpath(name))
    return name


def has_text_tower(loaded: dict[str, Any] | None = None) -> bool:
    """Whether a query can be put in this model's space at all."""
    if loaded is None:
        loaded = resolve()
    if loaded is None:
        return False
    if loaded["kind"] == "onnx":
        return bool(loaded["clip"].has_text_tower)
    return True


def embed_frames(
    loaded: dict[str, Any],
    path: str,
    timestamps_ms: list[int],
    *,
    label_vocabulary: list[str] | None = None,
    frames_dir: str | None = None,
    progress=None,
) -> dict[str, Any]:
    """Vectors, labels and a focus estimate for each requested moment."""
    # Never beside the media. This wrote a `_frames` directory into whatever
    # folder the footage was in, which is the ingest promise — "the original is
    # never modified and never moved" — broken one directory at a time, and the
    # files outlived the run. `ocr.py` had the same bug and was fixed; this copy
    # was missed.
    if frames_dir:
        work = Path(frames_dir)
        work.mkdir(parents=True, exist_ok=True)
        return _embed(loaded, path, timestamps_ms, work, label_vocabulary or [], progress)

    with tempfile.TemporaryDirectory(prefix="oea-frames-") as scratch:
        return _embed(loaded, path, timestamps_ms, Path(scratch), label_vocabulary or [], progress)


def _embed(
    loaded: dict[str, Any],
    path: str,
    timestamps_ms: list[int],
    work: Path,
    vocabulary: list[str],
    progress,
) -> dict[str, Any]:
    from PIL import Image  # noqa: PLC0415

    from ..media import extract_frame, moment_frame_name  # noqa: PLC0415

    frames: list[dict[str, Any]] = []
    dim = 0

    # Batched, because a per-frame round trip through a vision model spends most
    # of its time on overhead rather than on inference.
    batch_size = 16
    for start in range(0, len(timestamps_ms), batch_size):
        batch = timestamps_ms[start : start + batch_size]
        images = []
        kept: list[int] = []

        for timestamp in batch:
            # Named by the moment, and never the way prepare names its frames:
            # the two shared a directory and a moment at 1000 ms was read from
            # prepare's frame 1000, which is the picture at 999 s.
            frame_path = work / moment_frame_name(timestamp)
            if not frame_path.exists():
                try:
                    extract_frame(path, timestamp, str(frame_path))
                except Exception:  # noqa: BLE001 - one unreadable frame is not fatal
                    continue
            try:
                images.append(Image.open(frame_path).convert("RGB"))
                kept.append(timestamp)
            except Exception:  # noqa: BLE001
                continue

        if not images:
            continue

        vectors = _image_vectors(loaded, images)
        labels_per_frame = (
            _zero_shot(loaded, vectors, vocabulary) if vocabulary else [[] for _ in kept]
        )

        for index, timestamp in enumerate(kept):
            vector = [round(float(value), 6) for value in vectors[index]]
            dim = len(vector)
            frames.append(
                {
                    "timestamp_ms": timestamp,
                    "vector": vector,
                    "labels": labels_per_frame[index],
                    "sharpness": _sharpness(images[index]),
                }
            )

        if progress:
            progress(min(1.0, (start + len(batch)) / max(1, len(timestamps_ms))))

    return {"model": loaded["name"], "dim": dim or 1, "frames": frames}


def _image_vectors(loaded: dict[str, Any], images: list[Any]):
    """Unit-length image vectors, whichever backend is behind this."""
    if loaded["kind"] == "onnx":
        return loaded["clip"].encode_images(images)

    import torch  # noqa: PLC0415

    with torch.no_grad():
        inputs = loaded["processor"](images=images, return_tensors="pt").to(loaded["device"])
        features = loaded["model"].get_image_features(**inputs)
        return (features / features.norm(dim=-1, keepdim=True)).cpu().numpy()


def encode_text(loaded: dict[str, Any], texts: list[str], *, as_label: bool = False):
    """Text in the image tower's space, so a query can be compared with a frame.

    `as_label` wraps each string in CLIP's caption template. A vocabulary term is
    a bare noun phrase and embeds better as a sentence; a user's query is already
    a sentence they wrote, and wrapping it changes what they asked.
    """
    if loaded["kind"] == "onnx":
        template = clip_onnx.PROMPT_TEMPLATE if as_label else None
        return loaded["clip"].encode_texts(texts, template=template)

    import torch  # noqa: PLC0415

    prepared = [clip_onnx.PROMPT_TEMPLATE.format(text) for text in texts] if as_label else texts
    with torch.no_grad():
        inputs = loaded["processor"](text=prepared, padding=True, return_tensors="pt").to(
            loaded["device"]
        )
        features = loaded["model"].get_text_features(**inputs)
        return (features / features.norm(dim=-1, keepdim=True)).cpu().numpy()


def _vocabulary_vectors(loaded: dict[str, Any], vocabulary: list[str]):
    """The encoded vocabulary, computed once per model per list.

    Frames are embedded sixteen at a time and the candidate list is the same for
    every batch, so encoding it inside the loop ran the text tower once per
    batch — on an hour of footage at one frame a second, that is 225 passes to
    encode the same twelve phrases. Cached on the model rather than globally,
    because a different model gives different vectors for the same words.
    """
    cache = loaded.setdefault("_vocab_cache", {})
    key = tuple(vocabulary)
    if key not in cache:
        cache[key] = encode_text(loaded, vocabulary, as_label=True)
    return cache[key]


def _zero_shot(loaded: dict[str, Any], image_vectors, vocabulary: list[str]) -> list[list[str]]:
    """Labels from a candidate list, which is the only honest way to use this.

    A zero-shot model does not know what is in a frame; it knows which of the
    options it was given fits best. Handing it a vocabulary and taking what
    stands out keeps that distinction visible.
    """
    if not has_text_tower(loaded):
        # An export with no text tower can still embed frames. Labelling is what
        # it cannot do, and returning nothing is the truthful answer.
        return [[] for _ in range(len(image_vectors))]

    text_vectors = _vocabulary_vectors(loaded, vocabulary)
    scores = image_vectors @ text_vectors.T
    return [labels_from_scores([float(value) for value in row], vocabulary) for row in scores]


# How many standard deviations above the rest of its own row a score has to sit
# to count as a label. Calibrated against real model output and against noise;
# see the note in labels_from_scores.
LABEL_Z = 1.8
MAX_LABELS = 8


def labels_from_scores(
    scores: list[float],
    vocabulary: list[str],
    *,
    z: float = LABEL_Z,
    max_labels: int = MAX_LABELS,
) -> list[str]:
    """Which candidates a row of similarities actually supports.

    This used to be ``score > 0.15``, and that constant was wrong in a way that
    only shows up when you run a model. Raw cosine similarity has no fixed
    scale — each model puts image-text pairs wherever its training left them —
    so a number written in shared code means something different for every
    backend the interface exists to allow.

    Measured on CLIP ViT-B/32 with six clearly distinct frames and a nine-term
    vocabulary: every similarity fell in [0.087, 0.274] with a mean of 0.196, so
    **0.15 admitted 89% of all image-text pairs**. Five of the six frames came
    back with the maximum eight labels, and a field in daylight was labelled
    "a city at night with lights" and "a plate of food on a table". Those labels
    then feed the visual aspect of the search index and the observations the
    description model is shown.

    The second bug was independent of any model: the cap was applied to a list
    built in vocabulary order, so it kept the first eight that passed rather
    than the best eight. On the daylight frame it discarded the third-highest
    scoring term and kept the lowest-scoring one in the whole row.

    What replaces it asks a question that has the same meaning for any model:
    how far does this candidate stand out from what the same model said about
    every other candidate for this same frame? Measured in standard deviations
    of that row, which is exactly invariant to where a model puts its scores —
    shifting a row by +10 or scaling it by 37 leaves every z unchanged, and that
    invariance is the whole reason this replaces a constant.

    On the threshold, and the part worth being honest about: it does not
    separate cleanly, because nothing can. Across the six measured frames the
    correct label sat at z = 1.61 to 2.35. Across 20,000 synthetic rows with no
    real peak at all, the top z had a median of 1.5 and reached 2.75. Those
    ranges overlap, so no cutoff tells a weak match from a lucky one.

    1.8 is chosen with that in view: it keeps every frame where the model was
    actually right (the lowest of those was 1.87), discards the one row where
    the model's own top answer was wrong, and takes the share of
    no-signal rows that still get labelled from 97% at z = 1.0 down to about
    16%. Labels are advisory — they feed the search index and the observations
    the description model is shown, not a decision on their own — which is what
    makes a residual error rate acceptable here and would not make it acceptable
    somewhere else.
    """
    if not scores or not vocabulary:
        return []
    usable = min(len(scores), len(vocabulary))
    row = [float(value) for value in scores[:usable]]
    # With one option there is no distribution to stand out from, and "the best
    # of one" is not evidence of anything.
    if usable < 2:
        return []

    mean = sum(row) / usable
    variance = sum((value - mean) ** 2 for value in row) / usable
    deviation = variance**0.5

    # Every candidate scored identically: the model is expressing no preference,
    # and a z-score would divide by zero to invent one.
    if deviation <= 0:
        return []

    ranked = sorted(range(usable), key=lambda index: -row[index])
    return [vocabulary[index] for index in ranked if (row[index] - mean) / deviation >= z][
        :max_labels
    ]


def _sharpness(image) -> float:
    """A cheap focus estimate: the variance of a Laplacian, normalised.

    Good enough to tell a usable frame from a smeared one, which is all the
    editorial layer asks of it.
    """
    try:
        from PIL import ImageFilter, ImageStat  # noqa: PLC0415
    except ImportError:
        return 0.5
    try:
        grey = image.convert("L").resize((256, 256))
        edges = grey.filter(ImageFilter.FIND_EDGES)
        variance = ImageStat.Stat(edges).stddev[0]
        return max(0.0, min(1.0, variance / 40))
    except Exception:  # noqa: BLE001
        return 0.5
