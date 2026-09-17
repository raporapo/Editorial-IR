"""The JSON Lines protocol.

One request and one response per line on stdout, correlated by id. Logs go to
stderr. That split is not stylistic: the first time a model downloads itself it
prints a progress bar, and a progress bar on stdout would corrupt the protocol
stream and take down a run that was otherwise fine.

TypeScript owns the contract; this file implements it. Nothing here invents a
field, and every result is shaped by `schemas/` rather than by what happened to
be convenient in Python.
"""

from __future__ import annotations

import json
import sys
import traceback
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

from .errors import PerceptionError, UnsupportedOp

PROTOCOL_VERSION = "0.1.0"
WORKER_VERSION = "0.1.0"

Handler = Callable[[dict[str, Any], "Session"], dict[str, Any]]


@dataclass
class Request:
    id: str
    op: str
    params: dict[str, Any]


class Session:
    """Everything a handler needs to talk back while it works."""

    def __init__(self, out=None, err=None) -> None:
        self._out = out if out is not None else sys.stdout
        self._err = err if err is not None else sys.stderr
        self.request_id: str = ""

    def progress(self, fraction: float, message: str = "") -> None:
        """Reports progress on the current request.

        Out of band: the reply still follows. A transcription pass over an hour
        of audio is minutes long, and a tool that shows nothing for minutes is
        indistinguishable from one that has hung.
        """
        self._emit(
            {
                "v": PROTOCOL_VERSION,
                "id": self.request_id,
                "event": "progress",
                "progress": max(0.0, min(1.0, fraction)),
                "message": message,
            }
        )

    def log(self, message: str, level: str = "info") -> None:
        """Writes to stderr, where a log cannot corrupt the protocol."""
        print(f"[{level}] {message}", file=self._err, flush=True)

    def _emit(self, payload: dict[str, Any]) -> None:
        # `allow_nan=False` because Python writes bare `NaN` and `Infinity`,
        # which are not JSON and which the client cannot parse. It would read
        # the line as a stray log, leave the request pending, and hang until the
        # timeout — a much worse failure than one model returning a number that
        # is not a number. A ValueError here is caught by the loop and reported
        # against the request that produced it.
        self._out.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n")
        self._out.flush()

    @staticmethod
    def _without_nulls(value: Any) -> Any:
        """Drops keys whose value is None, recursively.

        JSON has no undefined, so a Python dict with a None in it becomes a null
        on the wire, and a field that means "there is no value here" arrives
        looking like a field that has one. The consumer accepts both, but a
        producer that says nothing is clearer than one that says null.
        """
        if isinstance(value, dict):
            return {k: Session._without_nulls(v) for k, v in value.items() if v is not None}
        if isinstance(value, list):
            return [Session._without_nulls(item) for item in value]
        return value

    def reply_ok(self, request_id: str, op: str, result: dict[str, Any]) -> None:
        self._emit(
            {
                "v": PROTOCOL_VERSION,
                "id": request_id,
                "ok": True,
                "op": op,
                "result": self._without_nulls(result),
            }
        )

    def reply_error(
        self,
        request_id: str,
        op: str | None,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if details:
            error["details"] = details
        payload: dict[str, Any] = {
            "v": PROTOCOL_VERSION,
            "id": request_id,
            "ok": False,
            "error": error,
        }
        if op:
            payload["op"] = op
        self._emit(payload)


def read_requests(stream: Iterator[str]) -> Iterator[Request | tuple[str, str]]:
    """Parses request lines, yielding a (id, message) tuple for anything malformed."""
    for raw in stream:
        line = raw.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as error:
            yield ("", f"not JSON: {error}")
            continue

        if not isinstance(parsed, dict):
            yield ("", "a request must be an object")
            continue

        request_id = str(parsed.get("id") or "")
        op = parsed.get("op")
        if not request_id or not isinstance(op, str):
            yield (request_id, "a request needs an id and an op")
            continue

        params = parsed.get("params")
        yield Request(id=request_id, op=op, params=params if isinstance(params, dict) else {})


def serve(handlers: dict[str, Handler], stream=None, session: Session | None = None) -> int:
    """Runs the protocol loop until stdin closes or a shutdown arrives.

    A handler that raises does not take the worker down: one unreadable file out
    of thirty must not abandon an analysis, so the failure is reported against
    that request and the loop carries on.
    """
    session = session or Session()
    source = stream if stream is not None else sys.stdin

    for item in read_requests(source):
        if isinstance(item, tuple):
            request_id, message = item
            session.reply_error(request_id or "unknown", None, "bad_request", message)
            continue

        session.request_id = item.id

        if item.op == "shutdown":
            session.reply_ok(item.id, "shutdown", {})
            return 0

        handler = handlers.get(item.op)
        if handler is None:
            error = UnsupportedOp(item.op)
            session.reply_error(item.id, item.op, error.code, error.message, dict(error.details))
            continue

        try:
            result = handler(item.params, session)
            session.reply_ok(item.id, item.op, result)
        except PerceptionError as error:
            session.reply_error(item.id, item.op, error.code, error.message, dict(error.details))
        except MemoryError:
            session.reply_error(
                item.id, item.op, "out_of_memory", "the worker ran out of memory on this request"
            )
        except Exception as error:  # noqa: BLE001 - the loop must survive anything
            # One line in the log, the whole traceback in the reply. A traceback
            # is exactly what you want when you are debugging this and exactly
            # what you do not want printed at somebody who just ran `oea
            # analyze` on a file we could not read: twenty lines of Python
            # internals read as a crash rather than as one file being skipped.
            summary = f"{type(error).__name__}: {error}"
            session.log(f"{item.op} failed — {summary}", "error")
            session.reply_error(
                item.id,
                item.op,
                "internal",
                summary,
                {"traceback": traceback.format_exc()},
            )

    return 0
