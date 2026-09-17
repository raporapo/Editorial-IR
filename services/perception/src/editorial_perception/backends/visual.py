"""Frame embeddings and zero-shot labels.

SigLIP by default. What matters is not which model: it is that the vectors it
produces and the vectors a text query is encoded with come from the same model,
because comparing across embedding spaces produces a confident ranking out of
noise. The index refuses to compare vectors of different widths for that reason.
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
    clears a threshold keeps that distinction visible.
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

    out: list[list[str]] = []
    for row in scores:
        chosen = [vocabulary[index] for index, score in enumerate(row.tolist()) if score > 0.15]
        out.append(chosen[:8])
    return out


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
