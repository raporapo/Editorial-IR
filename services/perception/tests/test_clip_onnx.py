"""CLIP's tokeniser and image preprocessing, against goldens from the reference.

Neither of these is a place where a mistake announces itself. A tokeniser that
splits `½` differently, or a resize that uses bilinear where CLIP used bicubic,
raises nothing and fails nothing — it returns vectors that are quietly a little
wrong, forever, in a stage whose whole job is to be compared against other
vectors.

So the check is equality against output taken from the reference implementation
(openai/CLIP, via `onnx_clip` 4.0.1) and recorded in `data/clip_golden.json`.
That file is the reason CI does not need the reference installed. It holds 347
token sequences — the hand-picked cases plus fuzzed ones drawn from every
character class the pattern distinguishes — and the sha256 of the exact float32
bytes for five preprocessed images at different aspect ratios.

Those image hashes are the float32 path, which is the one torch takes and the
one `onnx_clip` 4.0.1's shipped reference array was made with; its current numpy
code normalises through float64 and no longer matches the array it ships. Two
float32 ulps separate them. The reason to care is not the number, it is that
"bit-identical to the reference" has to name *which* reference.

This is not hypothetical care. The first version of this tokeniser used the
standard library's `re`, mapping `\\p{L}+` to `[^\\W\\d_]+`. All twenty
hand-picked cases passed. 14,304 of 40,000 fuzzed ones failed.

The tokeniser needs CLIP's merge table, which is a model asset rather than
source and is not in the repository. Point `OEA_TEST_CLIP_VOCAB` at it — CI
downloads it, and `pnpm oea models` puts it beside the weights.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

from editorial_perception.backends import clip_onnx
from editorial_perception.backends.clip_onnx import (
    CONTEXT_LENGTH,
    END_TOKEN,
    START_TOKEN,
    SimpleTokenizer,
    is_onnx_clip,
    preprocess,
)

GOLDEN = json.loads((Path(__file__).parent / "data" / "clip_golden.json").read_text("utf-8"))

VOCAB = os.environ.get("OEA_TEST_CLIP_VOCAB")
needs_vocab = pytest.mark.skipif(
    not VOCAB or not os.path.exists(VOCAB),
    reason="set OEA_TEST_CLIP_VOCAB to CLIP's bpe_simple_vocab_16e6.txt.gz",
)


@pytest.fixture(scope="module")
def tokenizer():
    pytest.importorskip("regex")
    pytest.importorskip("ftfy")
    return SimpleTokenizer(VOCAB)


def synthetic(width: int, height: int, seed: int):
    """The golden images, built from arithmetic rather than decoded from a file.

    A checked-in JPEG would make a bit-exactness test depend on whichever
    libjpeg the runner happens to have, which is the opposite of what it is for.
    """
    np = pytest.importorskip("numpy")
    Image = pytest.importorskip("PIL.Image")
    y, x = np.mgrid[0:height, 0:width]
    red = (x * 255 // max(1, width - 1)).astype(np.uint8)
    green = (y * 255 // max(1, height - 1)).astype(np.uint8)
    blue = (((x + y + seed) * 7) % 256).astype(np.uint8)
    return Image.fromarray(np.stack([red, green, blue], axis=2))


# --------------------------------------------------------------------------
# Preprocessing. Needs numpy and Pillow, nothing else.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(GOLDEN["images"]))
def test_preprocessing_is_bit_identical_to_clips_own(name):
    expected = GOLDEN["images"][name]
    image = synthetic(expected["width"], expected["height"], expected["seed"])
    array = preprocess(image)
    assert list(array.shape) == expected["shape"]
    assert array.dtype.name == "float32"
    # sha256 of the exact bytes, because "close" is what this test exists to
    # rule out: a wrong resample filter lands within a few thousandths and
    # changes every vector the stage produces.
    assert hashlib.sha256(array.tobytes()).hexdigest() == expected["sha256"], (
        f"{name} preprocessed differently from CLIP: "
        f"min {array.min():.6f} max {array.max():.6f} mean {array.mean():.6f}, "
        f"expected {expected['min']} / {expected['max']} / {expected['mean']}"
    )


def test_a_frame_of_any_aspect_ratio_comes_out_the_models_shape():
    for width, height in ((1920, 200), (200, 1920), (224, 224), (7, 3000)):
        assert preprocess(synthetic(width, height, 0)).shape == (3, 224, 224)


def test_a_greyscale_frame_becomes_three_channels():
    # ffmpeg will hand this stage a monochrome frame from black-and-white
    # footage, and a (1, 224, 224) input is a shape error at the graph rather
    # than here, where it would be legible.
    Image = pytest.importorskip("PIL.Image")
    grey = Image.new("L", (400, 300), 128)
    assert preprocess(grey).shape == (3, 224, 224)


def test_an_empty_frame_says_so_rather_than_producing_a_vector():
    Image = pytest.importorskip("PIL.Image")
    from editorial_perception.errors import ModelError

    with pytest.raises(ModelError):
        preprocess(Image.new("RGB", (0, 0)))


# --------------------------------------------------------------------------
# Tokenisation.
# --------------------------------------------------------------------------


@needs_vocab
def test_every_golden_token_sequence_still_matches(tokenizer):
    wrong = []
    for text, expected in GOLDEN["tokens"].items():
        actual = tokenizer.encode(text)
        if actual != expected:
            wrong.append((text, expected, actual))
    assert not wrong, (
        f"{len(wrong)} of {len(GOLDEN['tokens'])} differ from CLIP's own tokeniser; "
        f"first: {wrong[0][0]!r} expected {wrong[0][1][:12]} got {wrong[0][2][:12]}"
    )


@needs_vocab
def test_the_vocabulary_is_the_one_the_goldens_came_from():
    # A different merge table silently produces different tokens for everything,
    # and the golden failures would look like a bug in this file.
    digest = hashlib.sha256(Path(VOCAB).read_bytes()).hexdigest()
    assert digest == GOLDEN["vocab_sha256"]


@needs_vocab
def test_a_batch_is_bracketed_by_the_start_and_end_tokens(tokenizer):
    batch = tokenizer.tokenize(["a photo of a cat"])
    assert batch.shape == (1, CONTEXT_LENGTH)
    assert batch[0][0] == START_TOKEN
    ids = [int(value) for value in batch[0] if value != 0]
    assert ids[-1] == END_TOKEN


@needs_vocab
def test_padding_is_zero_and_sits_after_the_end_token(tokenizer):
    batch = tokenizer.tokenize(["short"])
    ids = [int(value) for value in batch[0]]
    end = ids.index(END_TOKEN)
    assert set(ids[end + 1 :]) == {0}


@needs_vocab
def test_a_paragraph_is_truncated_rather_than_refused(tokenizer):
    # Somebody will paste a paragraph into the search box. Answering on its
    # first 75 tokens beats answering not at all, and the graph takes exactly 77.
    batch = tokenizer.tokenize([" ".join(["word"] * 500)])
    assert batch.shape == (1, CONTEXT_LENGTH)
    assert batch[0][0] == START_TOKEN
    assert batch[0][CONTEXT_LENGTH - 1] == END_TOKEN


@needs_vocab
def test_texts_of_different_lengths_share_one_batch(tokenizer):
    batch = tokenizer.tokenize(["a", "a much longer piece of text than the first one"])
    assert batch.shape == (2, CONTEXT_LENGTH)


@needs_vocab
def test_a_vocabulary_that_is_not_clips_is_refused(tmp_path):
    import gzip

    from editorial_perception.errors import ModelError

    fake = tmp_path / "wrong.txt.gz"
    with gzip.open(fake, "wt", encoding="utf-8") as handle:
        handle.write("#version\n" + "\n".join(f"a{i} b{i}" for i in range(10)))
    with pytest.raises(ModelError, match="not CLIP's vocabulary"):
        SimpleTokenizer(str(fake))


# --------------------------------------------------------------------------
# Recognising a model directory, which must never cost a model load.
# --------------------------------------------------------------------------


def test_a_directory_with_a_visual_graph_is_a_clip_export(tmp_path):
    (tmp_path / "visual.onnx").write_bytes(b"not really")
    assert is_onnx_clip(str(tmp_path)) is True


def test_a_directory_without_one_is_not(tmp_path):
    assert is_onnx_clip(str(tmp_path)) is False


def test_a_repo_id_is_not_a_directory():
    # `OEA_VISUAL_MODEL` takes either, and a name that happens not to exist on
    # disk must route to the transformers path rather than be probed as a path.
    assert is_onnx_clip("google/siglip-base-patch16-224") is False


# --------------------------------------------------------------------------
# The real graphs, opt-in.
#
#   OEA_TEST_CLIP_MODEL=/path/to/clip-vit-b32 pytest -k real_model
# --------------------------------------------------------------------------
REAL = os.environ.get("OEA_TEST_CLIP_MODEL")
needs_model = pytest.mark.skipif(
    not REAL, reason="set OEA_TEST_CLIP_MODEL to a directory holding visual.onnx"
)


@pytest.fixture(scope="module")
def clip():
    pytest.importorskip("onnxruntime")
    return clip_onnx.ClipOnnx(REAL)


@needs_model
def test_real_model_puts_both_towers_in_one_space(clip):
    if not clip.has_text_tower:
        pytest.skip("this export has no textual.onnx")
    image = clip.encode_images([synthetic(640, 480, 0)])
    text = clip.encode_texts(["a colourful gradient"])
    assert image.shape[1] == text.shape[1], "the towers disagree about vector width"


@needs_model
def test_real_model_returns_unit_vectors(clip):
    # The index treats cosine as a dot product and does not normalise itself.
    vectors = clip.encode_images([synthetic(640, 480, 0), synthetic(480, 640, 3)])
    for vector in vectors:
        assert abs(float((vector**2).sum()) - 1.0) < 1e-4


@needs_model
def test_real_model_matches_an_image_to_its_own_description(clip):
    if not clip.has_text_tower:
        pytest.skip("this export has no textual.onnx")
    Image = pytest.importorskip("PIL.Image")
    images = [
        Image.new("RGB", (640, 480), (220, 20, 20)),
        Image.new("RGB", (640, 480), (20, 20, 220)),
        Image.new("RGB", (640, 480), (0, 0, 0)),
    ]
    prompts = ["a solid red image", "a solid blue image", "a completely black image"]
    scores = clip.encode_images(images) @ clip.encode_texts(prompts).T
    for index in range(len(images)):
        assert int(scores[index].argmax()) == index, f"row {index}: {scores[index]}"


@needs_model
def test_real_model_encodes_the_same_text_the_same_way_twice(clip):
    if not clip.has_text_tower:
        pytest.skip("this export has no textual.onnx")
    first = clip.encode_texts(["the ending shot of a city at night"])
    second = clip.encode_texts(["the ending shot of a city at night"])
    assert first.tolist() == second.tolist()
