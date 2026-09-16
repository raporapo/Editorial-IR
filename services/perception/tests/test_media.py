"""Mapping ffprobe output onto the contract, without running ffprobe."""

from __future__ import annotations

from editorial_perception.media import build_shots, _parse_showinfo, _rational, _rotation


def test_rational_keeps_ntsc_exact():
    assert _rational("30000/1001") == (30000, 1001)
    assert _rational("25/1") == (25, 1)
    assert _rational("0/0") is None
    assert _rational(None) is None


def test_rotation_is_normalised_into_range():
    assert _rotation({"side_data_list": [{"rotation": -90}]}) == 270
    assert _rotation({"tags": {"rotate": "90"}}) == 90
    assert _rotation({}) is None


def test_showinfo_times_are_parsed():
    stderr = (
        "[Parsed_showinfo_1 @ 0x55] n:0 pts:12012 pts_time:0.4004 pos:48\n"
        "[Parsed_showinfo_1 @ 0x55] n:1 pts:120120 pts_time:4.004 pos:900\n"
        "frame= 2 fps=0.0 q=-0.0\n"
    )
    assert _parse_showinfo(stderr) == [400, 4004]


def test_shots_cover_the_file_without_gaps():
    shots = build_shots([4000, 9000], 15_000, 800)
    assert len(shots) == 3
    assert shots[0]["start_ms"] == 0
    assert shots[-1]["end_ms"] == 15_000
    for previous, current in zip(shots, shots[1:], strict=False):
        assert current["start_ms"] == previous["end_ms"]


def test_flash_frames_are_dropped_rather_than_kept_as_slivers():
    shots = build_shots([1000, 1100, 1200, 5000], 8000, 800)
    assert [shot["start_ms"] for shot in shots] == [0, 1000, 5000]


def test_a_file_with_no_cuts_is_one_shot():
    shots = build_shots([], 10_000, 800)
    assert len(shots) == 1
    assert shots[0]["representative_frame_ms"] == 3333
