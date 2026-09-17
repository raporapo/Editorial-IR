"""The protocol loop.

Its job is to survive: a handler that raises, a line that is not JSON, a request
with no id. One unreadable file out of thirty must not abandon an analysis, so
none of those may take the worker down.
"""

from __future__ import annotations

import io
import json

from editorial_perception.errors import MediaError, MissingDependency
from editorial_perception.protocol import Session, serve


def run(lines: list[dict], handlers: dict) -> list[dict]:
    return _run(lines, handlers)[0]


def _run(lines: list[dict], handlers: dict) -> tuple[list[dict], str]:
    """Replies, and whatever went to the log."""
    out = io.StringIO()
    err = io.StringIO()
    session = Session(out=out, err=err)
    serve(handlers, io.StringIO("\n".join(json.dumps(line) for line in lines)), session)
    replies = [json.loads(line) for line in out.getvalue().strip().splitlines() if line.strip()]
    return replies, err.getvalue()


def echo(params, session):
    return {"echoed": params}


def test_replies_are_correlated_by_id():
    replies = run(
        [
            {"v": "0.1.0", "id": "a", "op": "echo", "params": {"x": 1}},
            {"v": "0.1.0", "id": "b", "op": "echo", "params": {"x": 2}},
        ],
        {"echo": echo},
    )
    assert [reply["id"] for reply in replies] == ["a", "b"]
    assert replies[0]["result"]["echoed"] == {"x": 1}


def test_a_handler_that_raises_does_not_stop_the_loop():
    def explode(params, session):
        raise RuntimeError("the model fell over")

    replies = run(
        [
            {"id": "1", "op": "explode", "params": {}},
            {"id": "2", "op": "echo", "params": {}},
        ],
        {"explode": explode, "echo": echo},
    )
    assert replies[0]["ok"] is False
    assert replies[0]["error"]["code"] == "internal"
    # The second request is still answered.
    assert replies[1]["ok"] is True


def test_a_traceback_goes_in_the_reply_and_one_line_goes_in_the_log():
    """A traceback is what you want when debugging and not what you want printed
    at somebody who just ran `oea analyze` on a file we could not read. Twenty
    lines of Python internals read as a crash rather than as one file skipped."""

    def explode(params, session):
        raise RuntimeError("the model fell over")

    replies, log = _run([{"id": "1", "op": "explode", "params": {}}], {"explode": explode})

    assert replies[0]["error"]["message"] == "RuntimeError: the model fell over"
    # Kept, so that whoever wants it can have it.
    assert "Traceback" in replies[0]["error"]["details"]["traceback"]
    # But not shouted.
    assert "Traceback" not in log
    assert "explode failed" in log
    assert len([line for line in log.strip().splitlines() if line.strip()]) == 1


def test_a_coded_error_keeps_its_code():
    def unreadable(params, session):
        raise MediaError("this file is not a video", path="/tmp/a.txt")

    replies = run([{"id": "1", "op": "x", "params": {}}], {"x": unreadable})
    assert replies[0]["error"]["code"] == "media_error"
    assert replies[0]["error"]["details"]["path"] == "/tmp/a.txt"


def test_a_missing_dependency_is_distinguishable_from_a_failure():
    def needs_torch(params, session):
        raise MissingDependency("visual embeddings", "torch")

    replies = run([{"id": "1", "op": "x", "params": {}}], {"x": needs_torch})
    # The compiler reads this as "this stage is unavailable" and carries on,
    # which is a different response from "something went wrong".
    assert replies[0]["error"]["code"] == "missing_dependency"
    assert "pip install" in replies[0]["error"]["message"]


def test_an_unknown_op_is_reported_rather_than_ignored():
    replies = run([{"id": "1", "op": "teleport", "params": {}}], {})
    assert replies[0]["error"]["code"] == "unsupported_op"


def test_a_line_that_is_not_json_does_not_stop_the_loop():
    out = io.StringIO()
    session = Session(out=out, err=io.StringIO())
    serve({"echo": echo}, io.StringIO('not json\n{"id":"1","op":"echo","params":{}}\n'), session)
    replies = [json.loads(line) for line in out.getvalue().strip().splitlines()]
    assert replies[0]["ok"] is False
    assert replies[1]["ok"] is True


def test_a_request_without_an_id_is_rejected():
    replies = run([{"op": "echo", "params": {}}], {"echo": echo})
    assert replies[0]["ok"] is False
    assert "id" in replies[0]["error"]["message"]


def test_shutdown_ends_the_loop():
    out = io.StringIO()
    session = Session(out=out, err=io.StringIO())
    code = serve(
        {"echo": echo},
        io.StringIO(
            json.dumps({"id": "1", "op": "shutdown", "params": {}})
            + "\n"
            + json.dumps({"id": "2", "op": "echo", "params": {}})
        ),
        session,
    )
    replies = [json.loads(line) for line in out.getvalue().strip().splitlines()]
    assert code == 0
    # Nothing after the shutdown is answered.
    assert len(replies) == 1


def test_progress_is_not_mistaken_for_a_reply():
    def slow(params, session):
        session.progress(0.5, "halfway")
        return {"done": True}

    replies = run([{"id": "1", "op": "slow", "params": {}}], {"slow": slow})
    assert replies[0]["event"] == "progress"
    assert replies[0]["progress"] == 0.5
    assert replies[1]["ok"] is True


def test_logs_go_to_stderr_where_they_cannot_corrupt_the_stream():
    out = io.StringIO()
    err = io.StringIO()
    session = Session(out=out, err=err)

    def chatty(params, session):
        session.log("downloading a model")
        return {}

    request = io.StringIO(json.dumps({"id": "1", "op": "chatty", "params": {}}))
    serve({"chatty": chatty}, request, session)
    assert "downloading a model" in err.getvalue()
    assert "downloading" not in out.getvalue()


def test_nulls_are_omitted_rather_than_sent():
    """JSON has no undefined, and a field that says null looks like a field with
    a value. Saying nothing is clearer."""

    def partial(params, session):
        return {"present": 1, "absent": None, "nested": {"here": "yes", "gone": None}}

    replies = run([{"id": "1", "op": "partial", "params": {}}], {"partial": partial})
    assert replies[0]["result"] == {"present": 1, "nested": {"here": "yes"}}
