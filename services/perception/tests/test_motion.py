"""The picture envelope, on synthetic frames, and its parity with TypeScript."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from editorial_perception.backends import motion

SIZE = motion.WIDTH * motion.HEIGHT


def frame(fill) -> bytes:
    if isinstance(fill, int):
        return bytes([fill]) * SIZE
    return bytes(max(0, min(255, fill(i))) for i in range(SIZE))


def moving(k: int) -> bytes:
    return frame(lambda i: ((i + k * 7) % 64) * 3)


def test_still_picture_is_static():
    result = motion.analyse_samples(b"".join(frame(120) for _ in range(50)))
    assert result["hop_ms"] == 200
    assert [e["event_type"] for e in result["events"]] == ["static"]
    assert (result["events"][0]["start_ms"], result["events"][0]["end_ms"]) == (0, 10_000)


def test_moving_picture_is_not():
    result = motion.analyse_samples(b"".join(moving(k) for k in range(50)))
    assert [e for e in result["events"] if e["event_type"] == "static"] == []


def test_corner_motion_counts():
    before = frame(100)
    after = frame(lambda i: 140 if i % motion.WIDTH < 16 and i // motion.WIDTH < 12 else 100)
    assert motion.cell_max_difference(before, after) == 40


def test_lit_windows_are_not_black():
    black = [frame(16) for _ in range(10)]
    night = [frame(lambda i: 200 if i % 20 == 0 else 12) for _ in range(10)]
    result = motion.analyse_samples(b"".join(black + night))
    blacks = [e for e in result["events"] if e["event_type"] == "black"]
    assert blacks == [{"start_ms": 0, "end_ms": 2000, "event_type": "black", "confidence": 0.9}]


def test_nothing_for_no_picture():
    assert motion.analyse_samples(b"") == {
        "model": "cell-max-64x36",
        "hop_ms": 200,
        "motion": [],
        "luma": [],
        "events": [],
    }


def test_first_sample_is_not_a_fabricated_still():
    result = motion.analyse_samples(b"".join(moving(k) for k in range(5)))
    assert result["motion"][0] == result["motion"][1]


ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_same_numbers_as_typescript(tmp_path):
    """Which runtime measured the footage must not change the analysis."""
    dist = ROOT / "packages" / "perception" / "dist" / "ffmpeg" / "video.js"
    contracts = ROOT / "packages" / "contracts" / "dist" / "index.js"
    if not dist.exists() or not contracts.exists():
        pytest.skip("the TypeScript packages are not built")
    frames = [moving(k) for k in range(20)] + [frame(90) for _ in range(20)] + [frame(10)] * 5
    raw = tmp_path / "samples.gray"
    raw.write_bytes(b"".join(frames))
    script = (
        f"import {{ analyseSamples }} from {json.dumps(dist.as_uri())};"
        f"import {{ AnalyzeVideoParams }} from {json.dumps(contracts.as_uri())};"
        "import { readFileSync } from 'node:fs';"
        f"const r = analyseSamples(readFileSync({json.dumps(str(raw))}),"
        " AnalyzeVideoParams.parse({ path: 'x' }));"
        "process.stdout.write(JSON.stringify(r));"
    )
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True
    )
    assert json.loads(out.stdout) == motion.analyse_samples(b"".join(frames))
