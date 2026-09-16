"""Errors the protocol can carry.

The codes are part of the contract: the TypeScript side branches on them, and a
missing dependency has to be distinguishable from a broken file or a model that
ran out of memory, because the three call for completely different responses.
"""

from __future__ import annotations


class PerceptionError(Exception):
    """An error with a code the other side understands."""

    def __init__(self, code: str, message: str, **details: object) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


class BadRequest(PerceptionError):
    def __init__(self, message: str, **details: object) -> None:
        super().__init__("bad_request", message, **details)


class UnsupportedOp(PerceptionError):
    def __init__(self, op: str) -> None:
        super().__init__("unsupported_op", f"this worker does not implement {op!r}", op=op)


class MissingDependency(PerceptionError):
    """A capability whose package is not installed.

    Deliberately distinct from a failure: the compiler treats it as "this stage
    is unavailable" and carries on with less information, rather than as
    "something went wrong".
    """

    def __init__(self, what: str, package: str) -> None:
        super().__init__(
            "missing_dependency",
            f"{what} needs {package}. Install it with: pip install 'editorial-perception[{package_extra(package)}]'",
            what=what,
            package=package,
        )


class MediaError(PerceptionError):
    def __init__(self, message: str, **details: object) -> None:
        super().__init__("media_error", message, **details)


class ModelError(PerceptionError):
    def __init__(self, message: str, **details: object) -> None:
        super().__init__("model_error", message, **details)


class OutOfMemory(PerceptionError):
    def __init__(self, message: str, **details: object) -> None:
        super().__init__("out_of_memory", message, **details)


_EXTRAS = {
    "faster-whisper": "asr",
    "torch": "visual",
    "transformers": "visual",
    "numpy": "audio",
    "pillow": "vlm",
    "rapidocr-onnxruntime": "ocr",
    "sentence-transformers": "text",
    "jsonschema": "validate",
}


def package_extra(package: str) -> str:
    return _EXTRAS.get(package, "all")
