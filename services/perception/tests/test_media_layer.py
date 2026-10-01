"""The media layer's decisions, with ffmpeg stood in for.

Every case here is a file that broke the pipeline when it was first put through
the real CLI: a drone clip with no audio track, a podcast with album art, a camera
with a lavalier on its second track, a phone clip that dropped frames. The
TypeScript preparer is tested against the same cases in
`packages/perception/test/media-layer.test.ts`; the real-ffmpeg half is
`scripts/check-media.mjs`.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from editorial_perception import media
from editorial_perception.backends import ocr

# --- probe ---------------------------------------------------------------------


def test_album_art_is_not_the_picture():
    # Measured on an MP3 with a cover: a one-frame mjpeg stream at 90000/1
    # marked attached_pic.
    result = media.probe_result(
        {
            "format": {"duration": "61.0", "format_name": "mp3"},
            "streams": [
                {"index": 0, "codec_type": "audio", "codec_name": "mp3", "channels": 1},
                {
                    "index": 1,
                    "codec_type": "video",
                    "codec_name": "mjpeg",
                    "width": 600,
                    "height": 600,
                    "r_frame_rate": "90000/1",
                    "avg_frame_rate": "0/0",
                    "disposition": {"attached_pic": 1},
                },
            ],
        }
    )
    assert "width" not in result
    assert "video_codec" not in result
    assert "fps_num" not in result
    assert result["audio_codec"] == "mp3"


def test_a_still_has_a_size_and_no_frame_rate():
    result = media.probe_result(
        {
            "format": {"format_name": "image2", "duration": "0.040000"},
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "mjpeg",
                    "width": 4032,
                    "height": 3024,
                    "r_frame_rate": "25/1",
                    "avg_frame_rate": "25/1",
                }
            ],
        }
    )
    assert result["width"] == 4032
    assert "fps_num" not in result
    assert "variable_frame_rate" not in result
    assert result["audio_streams"] == []


def test_every_audio_stream_is_listed_by_its_place_among_audio_streams():
    result = media.probe_result(
        {
            "format": {"duration": "30.0"},
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264", "width": 1280},
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "channels": 2,
                    "sample_rate": "48000",
                    "tags": {"language": "und", "handler_name": "SoundHandler"},
                },
                {"index": 2, "codec_type": "data", "codec_name": "bin_data"},
                {
                    "index": 3,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "channels": 1,
                    "sample_rate": "48000",
                    "tags": {"language": "eng", "handler_name": "Lav"},
                },
            ],
        }
    )
    assert result["audio_streams"] == [
        {"index": 0, "codec": "aac", "channels": 2, "sample_rate": 48000},
        {
            "index": 1,
            "codec": "aac",
            "channels": 1,
            "sample_rate": 48000,
            "language": "eng",
            "title": "Lav",
        },
    ]
    assert result["audio_channels"] == 2


def test_a_phone_clip_keeps_the_rate_it_was_set_to_and_is_marked_variable():
    result = media.probe_result(
        {
            "format": {"duration": "20.000000"},
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1280,
                    "height": 720,
                    "r_frame_rate": "30/1",
                    "avg_frame_rate": "91/4",
                    "nb_frames": "455",
                    "duration": "20.000000",
                }
            ],
        }
    )
    assert (result["fps_num"], result["fps_den"]) == (30, 1)
    assert (result["avg_fps_num"], result["avg_fps_den"]) == (91, 4)
    assert result["variable_frame_rate"] is True


def test_a_webm_is_counted_because_its_declared_rates_agree_regardless():
    webm = {
        "format": {"duration": "8.000000", "format_name": "matroska,webm"},
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "vp8",
                "width": 320,
                "height": 240,
                "r_frame_rate": "30/1",
                "avg_frame_rate": "30/1",
            }
        ],
    }
    assert media.probe_result(webm)["variable_frame_rate"] is False
    assert media.probe_result(webm, 132)["variable_frame_rate"] is True


def test_a_clip_trimmed_without_re_encoding_is_not_variable_rate():
    # Measured: a 30 fps clip cut with `-c copy`. Its edit list shortens the
    # duration and not the frame list — 131 frames in 4.067 s, "32.2 fps" —
    # while the container's own average is 30/1.
    stream = {
        "index": 0,
        "codec_type": "video",
        "codec_name": "h264",
        "width": 640,
        "height": 360,
        "r_frame_rate": "30/1",
        "avg_frame_rate": "30/1",
        "nb_frames": "131",
        "duration": "4.066992",
    }
    fmt = {"duration": "4.066992", "format_name": "mov,mp4,m4a,3gp,3g2,mj2"}
    assert media.probe_result({"format": fmt, "streams": [stream]})["variable_frame_rate"] is False
    dropped = {**stream, "avg_frame_rate": "75/4", "nb_frames": "175"}
    assert media.probe_result({"format": fmt, "streams": [dropped]})["variable_frame_rate"] is True


def test_a_webm_whose_sound_outlasts_its_picture_is_not_variable_rate():
    # Measured: constant 30 fps, 90 frames in the picture's 3.000 s, audio to
    # 4.008 s. Counted over the file's length it was 22.45 fps and "variable".
    def webm(tags):
        return {
            "format": {"duration": "4.008000", "format_name": "matroska,webm"},
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "vp8",
                    "width": 640,
                    "height": 360,
                    "r_frame_rate": "30/1",
                    "avg_frame_rate": "30/1",
                    "tags": tags,
                },
                {"index": 1, "codec_type": "audio", "codec_name": "opus", "channels": 1},
            ],
        }

    assert (
        media.probe_result(webm({"DURATION": "00:00:03.000000000"}), 90)["variable_frame_rate"]
        is False
    )
    assert (
        media.probe_result(webm({"DURATION-eng": "00:00:03.000000000"}), 90)["variable_frame_rate"]
        is False
    )
    # Without the picture's own length the file's is all there is.
    assert media.probe_result(webm({}), 90)["variable_frame_rate"] is True
    # And a count that really is short of the rate is still variable.
    assert (
        media.probe_result(webm({"DURATION": "00:00:03.000000000"}), 70)["variable_frame_rate"]
        is True
    )


def test_a_high_rate_camera_keeps_every_frame_in_its_proxy():
    # Measured on a 120 fps clip: a proxy capped at 60 put each cut the shot
    # detector found one source frame late, 1008 ms as 1017.
    assert media.proxy_frame_rate({"fps_num": 120, "fps_den": 1}) == (120, 1)
    assert media.proxy_frame_rate({"fps_num": 240, "fps_den": 1}) == (240, 1)
    assert media.proxy_frame_rate({"fps_num": 60000, "fps_den": 1001}) == (60000, 1001)
    # Only a rate nobody records at, or none, falls back.
    assert media.proxy_frame_rate({"fps_num": 1000, "fps_den": 1}) == (60, 1)
    assert media.proxy_frame_rate({}) == (60, 1)


def test_a_millisecond_clock_is_not_a_frame_rate():
    result = media.probe_result(
        {
            "format": {"duration": "2.971000", "format_name": "matroska,webm"},
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 320,
                    "height": 240,
                    "r_frame_rate": "1000/1",
                    "avg_frame_rate": "1000/1",
                }
            ],
        },
        153,
    )
    assert "fps_num" not in result
    assert result["variable_frame_rate"] is True


# --- capture time and timecode ----------------------------------------------------

#: ffprobe output measured on ffmpeg 6.1, and what the probe must make of it. The
#: TypeScript probe is tested against the same file, so an asset does not change
#: with the runtime that read it.
PROBE_CASES = json.loads(
    (Path(__file__).parent / "data" / "probe_cases.json").read_text(encoding="utf-8")
)["cases"]


@pytest.mark.parametrize("case", PROBE_CASES, ids=[c["name"] for c in PROBE_CASES])
def test_a_container_is_read_as_the_typescript_probe_reads_it(case):
    result = media.probe_result(case["ffprobe"])
    got = {"duration_ms": result["duration_ms"]}
    for key in ("creation_time", "start_timecode"):
        if key in result:
            got[key] = result[key]
    assert got == case["expected"]


def test_apples_creationdate_wins_over_a_creation_time_a_trim_rewrote():
    tags = {
        "creation_time": "2026-05-18T00:00:00.000000Z",
        "com.apple.quicktime.creationdate": "2026-05-17T18:00:00+0900",
    }
    assert media.capture_tag(tags) == "2026-05-17T18:00:00+0900"
    assert media.capture_tag({"DATE": "2026"}) == "2026"


def test_only_a_timecode_is_kept_with_a_semicolon_for_drop_frame():
    assert media.smpte_timecode("01:00:00;00") == "01:00:00;00"
    assert media.smpte_timecode("1:00:00,00") == "01:00:00;00"
    assert media.smpte_timecode("A001C003") is None
    assert media.smpte_timecode("10:61:00:00") is None


def test_a_tag_is_found_whatever_its_case_the_exact_spelling_first():
    assert media.tag_value({"TIMECODE": "03:00:00:00"}, "timecode") == "03:00:00:00"
    assert media.tag_value({"Timecode": "b", "timecode": "a"}, "timecode") == "a"
    assert media.tag_value({"Timecode": "b", "TIMECODE": "c"}, "timecode") == "c"


# --- prepare -------------------------------------------------------------------


class FakeFfmpeg:
    """Writes what it is asked for, including the partial file a killed run leaves."""

    def __init__(self, audio: list[str] | None = None, frames: int = 0, fail: tuple = ()):
        self.audio = audio or []
        self.frames = frames
        self.fail = fail
        self.calls: list[list[str]] = []

    def __call__(self, command: list[str], **_: object):
        self.calls.append(command)
        output = command[-1]
        if output.endswith(".jpg"):
            kind = "frames"
            for index in range(1, self.frames + 1):
                (Path(output).parent / f"{index:08d}.jpg").write_bytes(b"jpeg")
        elif output.endswith(".wav"):
            kind = "audio"
            stream = int(command[command.index("-map") + 1].rsplit(":", 1)[-1])
            Path(output).write_bytes(Path(self.audio[stream]).read_bytes())
        else:
            kind = "proxy"
            Path(output).write_bytes(b"half a proxy")
        if kind in self.fail:
            raise media.MediaError("ffmpeg failed", stderr=f"[out#0 @ 0x1] {kind} broke\nInvalid\n")


VIDEO = {
    "duration_ms": 30000,
    "width": 1280,
    "height": 720,
    "fps_num": 30,
    "fps_den": 1,
    "video_codec": "h264",
    "container": "mov,mp4,m4a,3gp,3g2,mj2",
    "audio_streams": [],
    "metadata": {},
}


def _prepare(monkeypatch, tmp_path, probed, ffmpeg, **params):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"not really")
    monkeypatch.setattr(media, "probe", lambda _path: probed)
    monkeypatch.setattr(media, "_run", ffmpeg)
    return media.prepare(str(source), str(tmp_path / "work"), **params)


def test_a_video_with_no_audio_track_keeps_its_frames(monkeypatch, tmp_path):
    ffmpeg = FakeFfmpeg(frames=30)
    result = _prepare(monkeypatch, tmp_path, VIDEO, ffmpeg, frame_fps=1.0)
    assert result["audio_stream_count"] == 0
    assert "audio_path" not in result
    assert "failed" not in result
    assert len(result["frame_timestamps_ms"]) == 30
    assert not any(call[-1].endswith(".wav") for call in ffmpeg.calls)


def test_one_derivative_failing_takes_no_other_down(monkeypatch, tmp_path):
    speech = _wav(tmp_path / "s.wav", _speech_like())
    probed = {**VIDEO, "audio_streams": [{"index": 0, "channels": 2}]}
    ffmpeg = FakeFfmpeg(audio=[speech], frames=3, fail=("audio",))
    result = _prepare(monkeypatch, tmp_path, probed, ffmpeg, frame_fps=1.0)
    assert result["proxy_path"].endswith("proxy-480p-cfr30.mp4")
    assert result["frames_dir"].endswith("frames-1fps-768px")
    # The same one line the TypeScript preparer writes: ffmpeg's first word, not
    # the consequences after it.
    assert result["failed"] == [{"derivative": "audio", "reason": "ffmpeg failed: audio broke"}]


def test_a_half_written_derivative_is_never_kept(monkeypatch, tmp_path):
    _prepare(monkeypatch, tmp_path, VIDEO, FakeFfmpeg(fail=("proxy",)), frame_fps=0)
    assert list((tmp_path / "work").iterdir()) == []
    ffmpeg = FakeFfmpeg()
    result = _prepare(monkeypatch, tmp_path, VIDEO, ffmpeg, frame_fps=0)
    assert Path(result["proxy_path"]).read_bytes() == b"half a proxy"
    assert len(ffmpeg.calls) == 1


def test_what_an_earlier_run_finished_is_reused(monkeypatch, tmp_path):
    speech = _wav(tmp_path / "s.wav", _speech_like())
    probed = {**VIDEO, "audio_streams": [{"index": 0, "channels": 2}]}
    first = _prepare(monkeypatch, tmp_path, probed, FakeFfmpeg(audio=[speech], frames=5))
    again = FakeFfmpeg(audio=[speech], frames=5)
    second = _prepare(monkeypatch, tmp_path, probed, again)
    assert again.calls == []
    assert second == first


def test_the_lavalier_is_heard_rather_than_the_room(monkeypatch, tmp_path):
    room = _wav(tmp_path / "room.wav", _noise(0.01))
    lav = _wav(tmp_path / "lav.wav", _speech_like())
    probed = {
        **VIDEO,
        "audio_streams": [{"index": 0, "channels": 2}, {"index": 1, "channels": 1}],
    }
    result = _prepare(
        monkeypatch, tmp_path, probed, FakeFfmpeg(audio=[room, lav]), proxy_height=0, frame_fps=0
    )
    assert result["audio_stream_index"] == 1
    assert result["audio_path"].endswith("audio-a1.wav")
    assert result["audio_stream_reason"].startswith("most speech of 2 (")
    stored = json.loads((tmp_path / "work" / "audio-streams.json").read_text())
    assert [entry["index"] for entry in stored["streams"]] == [0, 1]


def test_choice_reasons_are_the_characters_typescript_writes():
    quiet = {"index": 0, "speech_hops": 0, "hops": 100, "median_db": -60}
    loud = {"index": 1, "speech_hops": 0, "hops": 100, "median_db": -30}
    assert media.choose_audio_stream([quiet, loud], 2) == {
        "index": 1,
        "reason": "as much speech as the others of 2 (0.00), and the loudest (-30.0 vs -60.0 dB)",
    }
    talking = {"index": 1, "speech_hops": 47, "hops": 100, "median_db": -99.05}
    assert media.choose_audio_stream([quiet, talking], 2)["reason"] == (
        "most speech of 2 (0.47 vs 0.00)"
    )


def test_frame_timestamps_round_half_up_as_typescript_does(tmp_path):
    # round() rounds half to even: at 16 fps the second frame is 62.5 ms, which
    # Math.round makes 63 and round() made 62.
    for index in (1, 2, 3):
        (tmp_path / f"{index:08d}.jpg").write_bytes(b"")
    assert media.frame_timestamps_in(tmp_path, 16.0) == [0, 63, 125]


def test_a_percentile_on_a_half_way_index_is_the_hop_typescript_takes():
    # Six hops: the 90th percentile sits at index 4.5. round() took 4, Math.round
    # takes 5, and the two analysers derived different silence thresholds from
    # one WAV — one recording length in twenty.
    from editorial_perception.backends.audio import percentile

    assert percentile([-60.0, -50.0, -40.0, -30.0, -20.0, -10.0], 0.9) == -10.0
    assert percentile([-60.0, -50.0, -40.0, -30.0, -20.0, -10.0], 0.1) == -50.0


def test_frame_timestamps_count_only_frames_prepare_named(tmp_path):
    for name in ("00000001.jpg", "00000002.jpg", "at-00001000ms.jpg", "notes.txt"):
        (tmp_path / name).write_bytes(b"")
    assert media.frame_timestamps_in(tmp_path, 1.0) == [0, 1000]


# --- the frame a model is asked about ---------------------------------------------


def test_a_moment_is_never_read_from_the_frame_prepare_numbered_the_same(monkeypatch, tmp_path):
    # The visual and OCR stages named a moment `{ms:08d}.jpg` inside prepare's
    # frames directory, where prepare names frames by index. A moment at 1000 ms
    # in a twenty-minute file found prepare's frame 1000 — the picture at 999 s —
    # already there, and read it.
    (tmp_path / "00001000.jpg").write_bytes(b"the picture at 999 s")
    extracted: list[str] = []

    def extract(path: str, timestamp_ms: int, out_path: str) -> str:
        extracted.append(out_path)
        Path(out_path).write_bytes(b"the picture at 1 s")
        return out_path

    monkeypatch.setattr(media, "extract_frame", extract)
    monkeypatch.setattr(media, "image_size", lambda _path: (1280, 720))
    read: list[bytes] = []

    def engine(frame_path: str):
        read.append(Path(frame_path).read_bytes())
        return [], None

    ocr.read_frames(engine, "/media/proxy.mp4", [1000], frames_dir=str(tmp_path))
    assert read == [b"the picture at 1 s"]
    assert media.moment_frame_name(1000) != "00001000.jpg"
    assert not media._INDEXED_FRAME.fullmatch(media.moment_frame_name(1000))


def test_the_first_frame_is_taken_without_a_seek_so_a_jpeg_still_is_read(monkeypatch, tmp_path):
    # Measured: `-ss 0.000 -i photo.jpg` exits 0 having written nothing, so
    # every JPEG photo was silently never embedded or read, while PNGs were.
    commands: list[list[str]] = []

    def ffmpeg(command: list[str], **_: object):
        commands.append(command)
        Path(command[-1]).write_bytes(b"jpeg")

    monkeypatch.setattr(media, "_run", ffmpeg)
    media.extract_frame("/media/IMG_2003.jpg", 0, str(tmp_path / "a.jpg"))
    media.extract_frame("/media/clip.mp4", 1500, str(tmp_path / "b.jpg"))
    assert "-ss" not in commands[0]
    assert commands[1][commands[1].index("-ss") + 1] == "1.500"


def test_a_frame_ffmpeg_did_not_write_is_an_error_not_a_missing_file(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "_run", lambda command, **_: None)
    with pytest.raises(media.MediaError):
        media.extract_frame("/media/IMG_2003.jpg", 0, str(tmp_path / "never.jpg"))


# --- helpers ---------------------------------------------------------------------

RATE = 16_000


def _speech_like() -> list[float]:
    samples: list[float] = []
    for _second in range(6):
        for i in range(RATE):
            voiced = i < RATE * 0.6
            samples.append(0.4 * math.sin(2 * math.pi * 220 * i / RATE) if voiced else 0)
    return samples


def _noise(amplitude: float) -> list[float]:
    seed = 7
    out = []
    for _ in range(RATE * 6):
        seed = (seed * 1103515245 + 12345) % 2147483648
        out.append(amplitude * ((seed / 2147483648) * 2 - 1))
    return out


def _wav(path: Path, samples: list[float]) -> str:
    import wave

    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(
            b"".join(
                max(-32768, min(32767, round(s * 32767))).to_bytes(2, "little", signed=True)
                for s in samples
            )
        )
    return str(path)


@pytest.fixture(autouse=True)
def _no_real_ffprobe(monkeypatch):
    """Nothing here may reach a real binary; the fakes above say what ffmpeg does."""
    monkeypatch.setattr(media, "_ffprobe_json", _refuse)


def _refuse(*_args, **_kwargs):
    raise AssertionError("ffprobe was called for real")
