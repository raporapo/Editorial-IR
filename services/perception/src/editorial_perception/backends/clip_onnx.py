"""CLIP as three files and onnxruntime.

The visual stage had one implementation, and it needed `transformers`, `torch`
and a reachable huggingface.co. That is around 2 GB of wheels to look at a
frame, and on any machine behind a policy that blocks model hubs — which is
where this was developed, and which is normal inside companies — it is not a
path at all. `embed_frames` had never run once.

This is the same stage with none of that: two ONNX graphs and a vocabulary file,
run by the onnxruntime that is already here for text embeddings and audio
tagging. 606 MB on disk, 45 frames a second on four CPU cores, no torch, no hub.

## Both towers, which is the part that matters

A vision model's image vectors are only useful for search if a query can be put
in the same space, and only its own text tower can do that. Without one,
`embed_frames` writes 512-wide vectors into the `visual` aspect, the query
arrives 1024-wide from the sentence encoder, and the index — which refuses to
compare vectors of different widths, correctly — reports the aspect
unsearchable. Every frame would be embedded and none of it could be asked
anything. So `textual.onnx` is not optional decoration here; it is what makes
the stage worth running.

## The text tower is English, and the first users are not

Measured on this checkpoint: six frames against six English descriptions scored
6/6 top-1, and the same six concepts asked in Japanese scored 4/6 with the
margins at noise level. Nothing in this file can fix that — a text encoder that
never saw Japanese cannot be made to rank it — so `visual.py` declares the
limitation rather than hiding it, and a Japanese query falls back to the text
index, which does read Japanese.

## Exactness, and why it is checked rather than assumed

Both halves of the preprocessing are places where "close enough" produces a
model that works badly instead of failing:

- **Tokenisation** is CLIP's byte-pair encoder, reproduced here rather than
  imported. It was first written against the standard library's `re`, mapping
  `\\p{L}+` to `[^\\W\\d_]+` and `\\p{N}` to `\\d`. Twenty hand-picked cases all
  agreed. Forty thousand fuzzed ones did not: **14,304 differed**, because
  Python's `\\w` counts `½` and `Ⅷ` as word characters while `\\p{N}` makes them
  their own token, and because `[^\\s\\w]+` drops the underscore that
  `[^\\s\\p{L}\\p{N}]+` keeps. With `regex` and `ftfy`, as OpenAI's own
  tokeniser uses them, all 40,000 agree.
- **`ftfy` is a dependency for a measured reason**, not for tidiness. Dropped,
  with the pattern already correct, tokenisation still diverges on 20% of text
  containing BOM, zero-width space, non-breaking space or ideographic space, and
  on 0.07% of text without them. Subtitles and OCR output are full of exactly
  those characters.
- **Image preprocessing** is bicubic resize of the short side to 224, centre
  crop, and CLIP's channel statistics, in float32 from end to end. It is
  bit-identical to the reference array `onnx_clip` 4.0.1 ships — `max
  |difference| == 0.0`, not approximately. Worth knowing, because it was found
  the hard way: that package's *current* code normalises through float64
  intermediates and so no longer reproduces its own shipped array. float32 is
  the right side of that disagreement, because torch's `Normalize` computes in
  the tensor's dtype and the tensor is float32. The gap either way is 2.4e-07,
  two float32 ulps, which changes no vector anyone will ever look at — but a
  bit-exactness claim is either true or it is not worth making.

Neither is a detail anyone would notice going wrong. A subtly different
tokenisation does not raise; it returns slightly worse vectors forever.
"""

from __future__ import annotations

import functools
import gzip
import html
import os
from typing import Any

from ..errors import MissingDependency, ModelError

VISUAL_FILE = "visual.onnx"
TEXTUAL_FILE = "textual.onnx"
VOCAB_FILE = "bpe_simple_vocab_16e6.txt.gz"

# CLIP's fixed geometry. None of these are tunable: they are what the graph was
# exported with, and a different value is a shape error or, worse, silence.
INPUT_SIZE = 224
CONTEXT_LENGTH = 77
START_TOKEN = 49406
END_TOKEN = 49407
NORM_MEAN = (0.48145466, 0.4578275, 0.40821073)
NORM_STD = (0.26862954, 0.26130258, 0.27577711)

# A bare word embeds as a worse query than a word in a sentence, because the
# captions CLIP was trained on are sentences. This is the template OpenAI used
# for their own zero-shot ImageNet numbers.
PROMPT_TEMPLATE = "a photo of {}."


def is_onnx_clip(model_dir: str) -> bool:
    """Whether this directory is a CLIP export. Never loads anything to decide."""
    return os.path.isdir(model_dir) and os.path.exists(os.path.join(model_dir, VISUAL_FILE))


@functools.lru_cache(maxsize=1)
def _bytes_to_unicode() -> dict[int, str]:
    """Every byte as a printable character, so BPE never meets a control code."""
    printable = (
        list(range(ord("!"), ord("~") + 1))
        + list(range(ord("¡"), ord("¬") + 1))
        + list(range(ord("®"), ord("ÿ") + 1))
    )
    mapped = printable[:]
    spare = 0
    for byte in range(2**8):
        if byte not in printable:
            printable.append(byte)
            mapped.append(2**8 + spare)
            spare += 1
    return dict(zip(printable, (chr(code) for code in mapped), strict=True))


def _pairs(word: tuple[str, ...]) -> set[tuple[str, str]]:
    return {(word[i], word[i + 1]) for i in range(len(word) - 1)}


class SimpleTokenizer:
    """CLIP's byte-pair encoder, reproduced exactly.

    "Exactly" is load-bearing and is checked: `test_clip_onnx.py` holds a corpus
    of token sequences taken from the reference implementation, and a change here
    that alters any of them fails. See the module docstring for what an
    approximation cost when one was tried.
    """

    def __init__(self, vocab_path: str):
        try:
            import ftfy  # noqa: PLC0415
            import regex  # noqa: PLC0415
        except ImportError as error:
            raise MissingDependency("CLIP text encoding", "ftfy and regex") from error

        self._fix_text = ftfy.fix_text
        self._collapse = regex.compile(r"\s+")
        # Straight from OpenAI's tokeniser. `\p{L}` and `\p{N}` are why `regex`
        # is here instead of `re`: the standard library has no Unicode property
        # classes, and the closest approximations disagree on 36% of fuzzed
        # input.
        self._pattern = regex.compile(
            r"""<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d"""
            r"""|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+""",
            regex.IGNORECASE,
        )

        self._byte_encoder = _bytes_to_unicode()
        with gzip.open(vocab_path, "rt", encoding="utf-8") as handle:
            lines = handle.read().split("\n")
        # The first line is a version banner and the tail is padding; this slice
        # is the merge table's real extent and comes from the reference.
        merges = [tuple(line.split()) for line in lines[1 : 49152 - 256 - 2 + 1]]

        alphabet = list(self._byte_encoder.values())
        vocabulary = alphabet + [token + "</w>" for token in alphabet]
        vocabulary.extend("".join(merge) for merge in merges)
        vocabulary.extend(["<|startoftext|>", "<|endoftext|>"])

        self._encoder = {token: index for index, token in enumerate(vocabulary)}
        self._ranks = {merge: index for index, merge in enumerate(merges)}
        self._cache: dict[str, str] = {}

        if self._encoder.get("<|startoftext|>") != START_TOKEN:
            raise ModelError(
                f"{vocab_path} is not CLIP's vocabulary: it puts <|startoftext|> at "
                f"{self._encoder.get('<|startoftext|>')} rather than {START_TOKEN}"
            )

    def _bpe(self, token: str) -> str:
        cached = self._cache.get(token)
        if cached is not None:
            return cached

        word = tuple(token[:-1]) + (token[-1] + "</w>",)
        pairs = _pairs(word)
        if not pairs:
            return token + "</w>"

        while True:
            bigram = min(pairs, key=lambda pair: self._ranks.get(pair, float("inf")))
            if bigram not in self._ranks:
                break
            first, second = bigram
            merged: list[str] = []
            index = 0
            while index < len(word):
                try:
                    found = word.index(first, index)
                except ValueError:
                    merged.extend(word[index:])
                    break
                merged.extend(word[index:found])
                index = found
                if word[index] == first and index < len(word) - 1 and word[index + 1] == second:
                    merged.append(first + second)
                    index += 2
                else:
                    merged.append(word[index])
                    index += 1
            word = tuple(merged)
            if len(word) == 1:
                break
            pairs = _pairs(word)

        result = " ".join(word)
        self._cache[token] = result
        return result

    def encode(self, text: str) -> list[int]:
        # Double unescape is not a typo: it is what the reference does, and
        # scraped captions really do arrive with `&amp;lt;` in them.
        cleaned = html.unescape(html.unescape(self._fix_text(text))).strip()
        cleaned = self._collapse.sub(" ", cleaned).strip().lower()
        tokens: list[int] = []
        for piece in self._pattern.findall(cleaned):
            encoded = "".join(self._byte_encoder[byte] for byte in piece.encode("utf-8"))
            tokens.extend(self._encoder[part] for part in self._bpe(encoded).split(" "))
        return tokens

    def tokenize(self, texts: list[str]):
        """A padded `(n, 77)` int64 batch, which is the only shape the graph takes."""
        import numpy as np  # noqa: PLC0415

        batch = np.zeros((len(texts), CONTEXT_LENGTH), dtype=np.int64)
        for row, text in enumerate(texts):
            # Truncated rather than refused. A query longer than 77 tokens is a
            # user pasting a paragraph, and answering on its first 75 tokens is
            # better than answering not at all.
            ids = [START_TOKEN, *self.encode(text)[: CONTEXT_LENGTH - 2], END_TOKEN]
            batch[row, : len(ids)] = ids
        return batch


def preprocess(image):
    """One frame as CLIP's `(3, 224, 224)` input.

    Bicubic to the short side, centre crop, scale, standardise. Checked
    bit-for-bit against a reference array in the tests rather than eyeballed,
    because every step here is one where a plausible alternative — a different
    resample filter, cropping before resizing, ImageNet's channel statistics
    instead of CLIP's — produces vectors that are wrong in no visible way.
    """
    import numpy as np  # noqa: PLC0415

    image = image.convert("RGB")
    width, height = image.size
    if width == 0 or height == 0:
        raise ModelError("a frame with no pixels cannot be embedded")

    # The short side becomes 224 and the long side follows the aspect ratio,
    # truncating rather than rounding, which is what torchvision does.
    if height < width:
        target = (int(INPUT_SIZE * width / height), INPUT_SIZE)
    else:
        target = (INPUT_SIZE, int(INPUT_SIZE * height / width))

    from PIL import Image  # noqa: PLC0415

    resized = image.resize(target, resample=Image.BICUBIC)
    left = (target[0] - INPUT_SIZE) // 2
    top = (target[1] - INPUT_SIZE) // 2

    array = np.asarray(resized, dtype=np.float32)[top : top + INPUT_SIZE, left : left + INPUT_SIZE]
    array = array / 255.0
    mean = np.array(NORM_MEAN, dtype=np.float32).reshape(1, 1, 3)
    std = np.array(NORM_STD, dtype=np.float32).reshape(1, 1, 3)
    return np.transpose((array - mean) / std, (2, 0, 1)).astype(np.float32)


class ClipOnnx:
    """Both towers of a CLIP export, or just the image one if that is all there is.

    A directory with only `visual.onnx` still embeds frames; it simply cannot
    encode a query into the same space, and `has_text_tower` says so instead of
    discovering it at search time.
    """

    def __init__(self, model_dir: str, *, threads: int = 0):
        try:
            import numpy as np  # noqa: PLC0415
            import onnxruntime as ort  # noqa: PLC0415
        except ImportError as error:
            raise MissingDependency("visual embeddings", "onnxruntime") from error
        try:
            from PIL import Image  # noqa: PLC0415, F401
        except ImportError as error:
            raise MissingDependency("visual embeddings", "Pillow") from error

        self._np = np
        options = ort.SessionOptions()
        if threads > 0:
            options.intra_op_num_threads = threads
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        visual_path = os.path.join(model_dir, VISUAL_FILE)
        if not os.path.exists(visual_path):
            raise ModelError(f"{model_dir} holds no {VISUAL_FILE}")
        try:
            self.visual = ort.InferenceSession(
                visual_path, sess_options=options, providers=["CPUExecutionProvider"]
            )
        except Exception as error:  # noqa: BLE001
            raise ModelError(f"could not load {visual_path}: {error}") from error

        self.name = os.path.basename(os.path.normpath(model_dir))
        self._visual_input = self.visual.get_inputs()[0].name
        width = self.visual.get_outputs()[0].shape[-1]
        # A dynamic axis comes back as a string, and a width nobody knows yet is
        # better left at zero than guessed: the first batch fills it in.
        self.dim = int(width) if isinstance(width, int) else 0

        textual_path = os.path.join(model_dir, TEXTUAL_FILE)
        vocab_path = os.path.join(model_dir, VOCAB_FILE)
        self.textual = None
        self.tokenizer = None
        if os.path.exists(textual_path) and os.path.exists(vocab_path):
            # Loaded in two steps rather than one try block, so that a failure
            # names the file that failed. Together they reported a corrupt
            # vocabulary as "could not load textual.onnx: Not a gzipped file",
            # which points at 254 MB of perfectly good graph and away from the
            # 1.3 MB text file that is actually broken.
            try:
                self.textual = ort.InferenceSession(
                    textual_path, sess_options=options, providers=["CPUExecutionProvider"]
                )
                self._textual_input = self.textual.get_inputs()[0].name
            except Exception as error:  # noqa: BLE001
                raise ModelError(f"could not load {textual_path}: {error}") from error

            try:
                self.tokenizer = SimpleTokenizer(vocab_path)
            except MissingDependency:
                # ftfy or regex absent. The image tower is still perfectly
                # usable, so this costs querying rather than the whole stage.
                self.textual = None
                self.tokenizer = None
            except Exception as error:  # noqa: BLE001
                raise ModelError(f"could not load {vocab_path}: {error}") from error

    @property
    def has_text_tower(self) -> bool:
        return self.textual is not None and self.tokenizer is not None

    def _normalise(self, matrix):
        np = self._np
        return matrix / np.clip(np.linalg.norm(matrix, axis=-1, keepdims=True), 1e-9, None)

    def encode_images(self, images: list[Any], batch_size: int = 16):
        """Unit-length image vectors, in the order given."""
        np = self._np
        if not images:
            return np.zeros((0, max(self.dim, 1)), dtype=np.float32)
        chunks = []
        for start in range(0, len(images), batch_size):
            batch = np.stack([preprocess(image) for image in images[start : start + batch_size]])
            try:
                chunks.append(self.visual.run(None, {self._visual_input: batch})[0])
            except Exception as error:  # noqa: BLE001
                raise ModelError(f"the image tower failed: {error}") from error
        stacked = np.concatenate(chunks, 0).astype(np.float32)
        self.dim = int(stacked.shape[1])
        return self._normalise(stacked)

    def encode_texts(self, texts: list[str], *, template: str | None = None, batch_size: int = 64):
        """Unit-length text vectors in the image tower's space.

        `template` wraps each string — `PROMPT_TEMPLATE` for labelling, nothing
        for a user's query, which is already a sentence they wrote.
        """
        np = self._np
        if not self.has_text_tower:
            raise ModelError(f"{self.name} has no text tower, so it cannot encode a query")
        if not texts:
            return np.zeros((0, max(self.dim, 1)), dtype=np.float32)

        prepared = [template.format(text) if template else text for text in texts]
        chunks = []
        for start in range(0, len(prepared), batch_size):
            tokens = self.tokenizer.tokenize(prepared[start : start + batch_size])
            try:
                chunks.append(self.textual.run(None, {self._textual_input: tokens})[0])
            except Exception as error:  # noqa: BLE001
                raise ModelError(f"the text tower failed: {error}") from error
        return self._normalise(np.concatenate(chunks, 0).astype(np.float32))


def rounded(matrix) -> list[list[float]]:
    """Vectors as JSON, at the same six decimal places every other encoder uses."""
    return [[round(float(value), 6) for value in row] for row in matrix]
