"""Frame embeddings and zero-shot labels.

SigLIP by default. What matters is not which model: it is that the vectors it
produces and the vectors a text query is encoded with come from the same model,
because comparing across embedding spaces produces a confident ranking out of
noise. The index refuses to compare vectors of different widths for that reason.

## The text tower is English, and the first users are not

Both the default here and CLIP, the obvious alternative, have English-only text
towers. Measured on CLIP ViT-B/32: six frames against six English descriptions
scored 6/6 top-1, and the same six concepts asked in Japanese scored 4/6 with
the margins at noise level.

That matters because natural-language footage search is a headline feature and
"夜景が映っているところ" is how the people this is being built for would ask.
Nothing here can fix it — a model whose text encoder never saw Japanese cannot
be made to rank Japanese — so the options are a multilingual checkpoint
(`OEA_VISUAL_MODEL` exists for exactly this: SigLIP publishes a multilingual
variant, and open_clip publishes an XLM-R one) or translating the query before
it reaches the encoder. Until one of those is done, Japanese visual queries fall
back to the text index, which does read Japanese.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..errors import MissingDependency, ModelError

DEFAULT_MODEL = os.environ.get("OEA_VISUAL_MODEL", "google/siglip-base-patch16-224")


def load(model_name: str = DEFAULT_MODEL):
    try:
        import torch  # noqa: PLC0415
        from transformers import AutoModel, AutoProcessor  # noqa: PLC0415
    except ImportError as error:
        raise MissingDependency("visual embeddings", "transformers") from error

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = AutoModel.from_pretrained(model_name).to(device).eval()
        processor = AutoProcessor.from_pretrained(model_name)
    except Exception as error:  # noqa: BLE001
        raise ModelError(f"could not load the visual model {model_name!r}: {error}") from error

    return {"model": model, "processor": processor, "device": device, "name": model_name}


def embed_frames(
    loaded: dict[str, Any],
    path: str,
    timestamps_ms: list[int],
    *,
    label_vocabulary: list[str] | None = None,
    frames_dir: str | None = None,
    progress=None,
) -> dict[str, Any]:
    import torch  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    from ..media import extract_frame  # noqa: PLC0415

    model = loaded["model"]
    processor = loaded["processor"]
    device = loaded["device"]

    frames: list[dict[str, Any]] = []
    dim = 0
    work = Path(frames_dir) if frames_dir else Path(path).parent / "_frames"
    work.mkdir(parents=True, exist_ok=True)

    # Batched, because a per-frame round trip through a vision model spends most
    # of its time on overhead rather than on inference.
    batch_size = 16
    for start in range(0, len(timestamps_ms), batch_size):
        batch = timestamps_ms[start : start + batch_size]
        images = []
        kept: list[int] = []

        for timestamp in batch:
            frame_path = work / f"{timestamp:08d}.jpg"
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

        with torch.no_grad():
            inputs = processor(images=images, return_tensors="pt").to(device)
            features = model.get_image_features(**inputs)
            features = features / features.norm(dim=-1, keepdim=True)

        labels_per_frame = (
            _zero_shot(loaded, features, label_vocabulary)
            if label_vocabulary
            else [[] for _ in kept]
        )

        for index, timestamp in enumerate(kept):
            vector = features[index].cpu().tolist()
            dim = len(vector)
            frames.append(
                {
                    "timestamp_ms": timestamp,
                    "vector": [round(value, 6) for value in vector],
                    "labels": labels_per_frame[index],
                    "sharpness": _sharpness(images[index]),
                }
            )

        if progress:
            progress(min(1.0, (start + len(batch)) / max(1, len(timestamps_ms))))

    return {"model": loaded["name"], "dim": dim or 1, "frames": frames}


def _zero_shot(loaded: dict[str, Any], image_features, vocabulary: list[str]) -> list[list[str]]:
    """Labels from a candidate list, which is the only honest way to use this.

    A zero-shot model does not know what is in a frame; it knows which of the
    options it was given fits best. Handing it a vocabulary and taking what
    stands out keeps that distinction visible.
    """
    import torch  # noqa: PLC0415

    processor = loaded["processor"]
    model = loaded["model"]
    device = loaded["device"]

    with torch.no_grad():
        inputs = processor(text=vocabulary, padding=True, return_tensors="pt").to(device)
        text_features = model.get_text_features(**inputs)
        text_features = text_features / text_features.norm(dim=-1, keepdim=True)
        scores = image_features @ text_features.T

    return [labels_from_scores(row.tolist(), vocabulary) for row in scores]


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
