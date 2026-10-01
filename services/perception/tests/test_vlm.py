"""Reading an answer from a model that may not have followed the schema."""

from __future__ import annotations

import json
import math

from editorial_perception.backends.vlm import _affect, _entities, _unit, build_prompt
from editorial_perception.protocol import Session


class _Sink:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def write(self, text: str) -> None:
        self.lines.append(text)

    def flush(self) -> None:
        pass


def test_a_single_name_is_read_as_a_list():
    # The request asks for lists under a strict JSON schema, and not every
    # endpoint speaking the OpenAI API enforces it. A bare string used to fail
    # validation on the far side of the protocol, costing the whole description.
    assert _entities({"people": "Alice"})["people"] == ["Alice"]


def test_entities_keep_only_names():
    out = _entities({"places": ["大阪", "大阪", "  ", 7], "topics": None})
    assert out["places"] == ["大阪"]
    assert out["topics"] == []
    assert set(out) == {"people", "places", "objects", "topics"}


def test_entities_survive_an_answer_of_the_wrong_shape():
    assert _entities("nothing like a dict")["people"] == []
    assert _entities(None)["objects"] == []


def test_a_number_that_is_not_a_number_does_not_become_certainty():
    # Python's min and max hand NaN straight back, so clamping it to [0,1]
    # quietly produced 1.0 — a model that answered with nonsense recorded as
    # sure of itself, which is the end of the scale that triggers nothing.
    assert _unit(float("nan"), 0.5) == 0.5
    assert _unit(float("inf"), 0.5) == 0.5
    assert _unit("very confident", 0.5) == 0.5
    assert _unit(None, 0.5) == 0.5
    assert _unit(2, 0.5) == 1.0
    assert _unit(0.8, 0.5) == 0.8


def test_affect_drops_what_it_cannot_read():
    assert _affect({"joy": "x", "calm": float("nan"), "warm": 2}) == {"warm": 1.0}
    assert _affect(None) == {}


def test_the_protocol_refuses_to_write_a_number_that_is_not_json():
    # Python writes a bare NaN, which the client cannot parse: it reads the line
    # as a stray log, leaves the request pending, and hangs until the timeout.
    session = Session(out=_Sink(), err=_Sink())
    try:
        session.reply_ok("req_1", "describe", {"confidence": math.nan})
        raise AssertionError("a NaN should not reach the wire")
    except ValueError:
        pass


def test_the_protocol_still_writes_ordinary_numbers():
    sink = _Sink()
    Session(out=sink, err=_Sink()).reply_ok("req_1", "describe", {"confidence": 0.5})
    assert json.loads(sink.lines[0])["result"]["confidence"] == 0.5


def test_subtitles_are_handed_over_as_what_was_said():
    # Burned-in subtitles on an edited video with a music bed are the only words
    # there are. The TypeScript prompt says the same, in the same place.
    prompt = build_prompt({"subtitles": ["Then the rain started"], "ocr": ["NOODLES"]})
    assert "Subtitles burned into the picture (what was said):\nThen the rain started" in prompt
    assert "Text on screen:\nNOODLES" in prompt
    assert prompt.index("Subtitles") < prompt.index("Text on screen")
    assert "Subtitles" not in build_prompt({"ocr": ["NOODLES"]})
