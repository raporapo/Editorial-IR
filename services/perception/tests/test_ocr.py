"""Where on the frame the words were."""

from __future__ import annotations

import struct

from editorial_perception.backends.ocr import _normalise_box
from editorial_perception.media import image_size


def test_pixels_become_a_fraction_of_the_frame():
    # The contract says [0,1]; the reader speaks pixels. Getting this backwards
    # stored 192 in a field documented as a fraction of the frame width.
    box = [[192, 108], [384, 108], [384, 216], [192, 216]]
    assert _normalise_box(box, (1920, 1080)) == [0.1, 0.1, 0.1, 0.1]


def test_a_box_already_normalised_is_kept():
    box = [[0.1, 0.2], [0.4, 0.2], [0.4, 0.5], [0.1, 0.5]]
    left, top, width, height = _normalise_box(box, (1920, 1080))
    assert (round(left, 3), round(top, 3)) == (0.1, 0.2)
    assert (round(width, 3), round(height, 3)) == (0.3, 0.3)


def test_pixels_without_a_frame_size_are_left_out():
    # A number nobody can interpret is worse than no number.
    assert _normalise_box([[192, 108], [384, 216]], None) is None
    assert _normalise_box([[192, 108], [384, 216]], (0, 0)) is None


def test_a_box_running_off_the_frame_is_clamped():
    box = [[-40, -10], [2400, 1200]]
    assert _normalise_box(box, (1920, 1080)) == [0.0, 0.0, 1.0, 1.0]


def test_rubbish_is_refused_rather_than_guessed():
    assert _normalise_box(None, (1920, 1080)) is None
    assert _normalise_box([], (1920, 1080)) is None
    assert _normalise_box([["a", "b"]], (1920, 1080)) is None


def test_image_size_reads_a_jpeg_header(tmp_path):
    # Two bytes of marker, a length, then the frame header carrying the size.
    header = struct.pack(">HBHH", 11, 8, 1080, 1920)
    frame = b"\xff\xd8" + b"\xff\xc0" + header + b"\x03\x01\x11\x00"
    path = tmp_path / "frame.jpg"
    path.write_bytes(frame)
    assert image_size(str(path)) == (1920, 1080)


def test_image_size_reads_a_png_header(tmp_path):
    png = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", 640, 360)
    path = tmp_path / "frame.png"
    path.write_bytes(png)
    assert image_size(str(path)) == (640, 360)


def test_image_size_gives_up_on_something_that_is_not_an_image(tmp_path):
    path = tmp_path / "frame.jpg"
    path.write_bytes(b"not an image at all")
    assert image_size(str(path)) is None
    assert image_size(str(tmp_path / "missing.jpg")) is None
