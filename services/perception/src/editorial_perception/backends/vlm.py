"""The multimodal look at one event.

Reached over the OpenAI chat-completions shape, which covers both a hosted model
and a local server imitating one. That is the whole reason this is an HTTP call
rather than an in-process model: the same code runs a 4B model on a laptop and a
hosted model behind a key, and the pipeline cannot tell the difference.

Structured output is requested through a JSON schema. A model that returns prose
where a schema was asked for is a failed call, not something to parse hopefully.
"""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from ..errors import MissingDependency, ModelError

SYSTEM_PROMPT = (
    "You describe one moment from a video so that an editor can reason about it later. "
    "Say what is happening, not what it means for the edit; another layer judges that. "
    "The user background you are given is knowledge you do not have. "
    "Use it, and never contradict it. "
    "If the frames and the background disagree, describe the frames "
    "and leave the background alone. "
    "Answer in the language of the transcript."
)

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "description": {"type": "string"},
        "event_type": {"type": "string"},
        "title": {"type": "string"},
        "entities": {
            "type": "object",
            "properties": {
                "people": {"type": "array", "items": {"type": "string"}},
                "places": {"type": "array", "items": {"type": "string"}},
                "objects": {"type": "array", "items": {"type": "string"}},
                "topics": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["people", "places", "objects", "topics"],
            "additionalProperties": False,
        },
        "affect": {"type": "object", "additionalProperties": {"type": "number"}},
        "confidence": {"type": "number"},
    },
    "required": ["description", "event_type", "title", "entities", "affect", "confidence"],
    "additionalProperties": False,
}


def describe(params: dict[str, Any]) -> dict[str, Any]:
    base_url = os.environ.get("OEA_VLM_BASE_URL")
    model = os.environ.get("OEA_VLM_MODEL")
    if not base_url or not model:
        raise MissingDependency("a closer look at an event", "OEA_VLM_BASE_URL and OEA_VLM_MODEL")

    content: list[dict[str, Any]] = [{"type": "text", "text": build_prompt(params)}]
    for frame in (params.get("frame_paths") or [])[:4]:
        data_url = _data_url(frame)
        if data_url:
            content.append({"type": "image_url", "image_url": {"url": data_url}})

    global _mode  # noqa: PLW0603 - one server per process, discovered once

    url = f"{base_url.rstrip('/')}/chat/completions"
    key = os.environ.get("OEA_VLM_API_KEY")
    while True:
        message = list(content)
        if _mode != "json_schema":
            # Nothing is constraining generation now, so the shape has to be
            # asked for in words. Under `json_schema` this would be duplication
            # that costs context and buys nothing.
            message.append({"type": "text", "text": _schema_instruction(RESPONSE_SCHEMA)})

        payload: dict[str, Any] = {
            "model": model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": message},
            ],
        }
        if _mode == "json_schema":
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "semantic_event",
                    "strict": True,
                    "schema": RESPONSE_SCHEMA,
                },
            }
        elif _mode == "json_object":
            payload["response_format"] = {"type": "json_object"}

        try:
            body = _post(url, payload, key)
            break
        except ModelError as error:
            weaker = None
            status = error.details.get("status")
            if isinstance(status, int) and _rejects_response_format(
                status, str(error.details.get("body", ""))
            ):
                weaker = _weaker(_mode)
            if weaker is None:
                raise
            _mode = weaker

    text = (((body.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
    answer = _extract_json(text)
    if answer is None:
        raise ModelError("the model did not return JSON", content=text[:300])

    # An empty description is not an answer, whatever the JSON says.
    #
    # A 1B model asked in `json_object` mode returned valid JSON with an empty
    # description for nine events out of eleven, and every layer below accepted
    # it: the parse succeeded, the stage reported success, and the IR claimed a
    # full-strength analysis with nine blank descriptions. Failing here is what
    # puts the observation summary back and puts the event in the report.
    description = str(answer.get("description", "")).strip()
    if not description:
        raise ModelError("the model returned an empty description", content=text[:300])

    usage = body.get("usage") or {}
    return {
        "model": model,
        "description": description,
        "event_type": str(answer.get("event_type", "")),
        "title": answer.get("title"),
        "entities": _entities(answer.get("entities")),
        "affect": _affect(answer.get("affect")),
        "confidence": _unit(answer.get("confidence"), 0.5),
        "input_tokens": usage.get("prompt_tokens"),
        "output_tokens": usage.get("completion_tokens"),
    }


def _unit(value: Any, default: float) -> float:
    """A number in [0,1], or the default.

    `float(value)` was called straight on whatever came back. A string raised,
    and the traceback went out as an `internal` error that cost the whole
    event; `NaN` did not raise at all — Python's `min` and `max` hand it back
    as 1.0, so a model that answered with a number that is not a number was
    recorded as certain. Confidence decides what gets asked again and what the
    IR says about its own reliability, and the wrong end of the scale is the
    worst place for it to land.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number or number in (float("inf"), float("-inf")):
        return default
    return max(0.0, min(1.0, number))


def _affect(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, float] = {}
    for key, raw in value.items():
        try:
            number = float(raw)
        except (TypeError, ValueError):
            continue
        if number != number or number in (float("inf"), float("-inf")):
            continue
        out[str(key)] = max(0.0, min(1.0, number))
    return out


def _entities(value: Any) -> dict[str, list[str]]:
    """The four lists, with anything that is not a name left out.

    The request asks for this shape under a strict JSON schema, and the answer
    was passed through as it arrived. Not every endpoint that speaks the OpenAI
    API enforces the schema, and a single `"people": "Alice"` failed validation
    on the far side of the protocol — costing the whole description rather than
    the one field the model got wrong.
    """
    source = value if isinstance(value, dict) else {}
    out: dict[str, list[str]] = {}
    for key in ("people", "places", "objects", "topics"):
        raw = source.get(key)
        items = raw if isinstance(raw, list) else [raw] if isinstance(raw, str) else []
        names = [item.strip() for item in items if isinstance(item, str) and item.strip()]
        # Order kept, because it is the model's own ordering by prominence.
        out[key] = list(dict.fromkeys(names))
    return out


def build_prompt(params: dict[str, Any]) -> str:
    sections: list[str] = []
    user_context = params.get("user_context") or {}
    if user_context:
        written = json.dumps(user_context, ensure_ascii=False, indent=2)
        sections.append(f"Background the user provided:\n{written}")
    if params.get("previous_summary"):
        sections.append(f"Previous event: {params['previous_summary']}")
    if params.get("transcript"):
        sections.append("Speech:\n" + "\n".join(params["transcript"]))
    if params.get("ocr"):
        sections.append("Text on screen:\n" + "\n".join(params["ocr"]))
    if params.get("visual_labels"):
        sections.append("Detected: " + ", ".join(params["visual_labels"]))
    if params.get("audio_tags"):
        sections.append("Sound: " + ", ".join(params["audio_tags"]))
    if params.get("next_summary"):
        sections.append(f"Next event: {params['next_summary']}")
    sections.append("Describe this event.")
    return "\n\n".join(sections)


_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def _data_url(path: str) -> str | None:
    file = Path(path)
    if not file.exists():
        return None
    mime = _MIME.get(file.suffix.lower(), "image/jpeg")
    return f"data:{mime};base64,{base64.b64encode(file.read_bytes()).decode('ascii')}"


# How this server wants to be asked for JSON.
#
# "OpenAI-compatible" describes the URL and the message shape, not structured
# output. llama.cpp's server — one of the commonest ways to run a model locally
# — answers a `json_schema` request with HTTP 500 and
# "Input should be 'text' or 'json_object'", so every description on it fell
# back to a template. There is no capability endpoint to ask, so the mode is
# discovered by trying and then remembered for the life of the process.
#
# Mirrors `packages/contracts/src/structured-output.ts`; the two sides have to
# agree, because either may be the one talking to the server.
_MODES = ("json_schema", "json_object", "none")
_mode = "json_schema"


def _weaker(mode: str) -> str | None:
    index = _MODES.index(mode)
    return _MODES[index + 1] if index + 1 < len(_MODES) else None


def _rejects_response_format(status: int, body: str) -> bool:
    """A server refusing *how* it was asked, rather than failing to answer.

    Narrow on purpose: a timeout, a refusal or a bad answer must keep failing,
    because retrying those with a weaker request only gets a worse answer.
    """
    if status not in (400, 404, 422, 500):
        return False
    text = body.lower()
    return "response_format" in text or "json_schema" in text


def _schema_instruction(schema: dict[str, Any]) -> str:
    return (
        "Answer with a single JSON object and nothing else. "
        "No markdown fence, no explanation, no text before or after it. "
        "It must match this JSON Schema exactly:\n" + json.dumps(schema)
    )


def _extract_json(text: str) -> Any:
    """JSON from a reply that may carry a fence or a sentence around it."""
    trimmed = text.strip()
    candidates = [trimmed]
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", trimmed, re.IGNORECASE)
    if fence:
        candidates.append(fence.group(1).strip())
    first, last = trimmed.find("{"), trimmed.rfind("}")
    if first >= 0 and last > first:
        candidates.append(trimmed[first : last + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _post(
    url: str, payload: dict[str, Any], api_key: str | None, timeout: int = 120
) -> dict[str, Any]:
    request = urllib.request.Request(  # noqa: S310 - the URL is operator-configured
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            **({"authorization": f"Bearer {api_key}"} if api_key else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # The status travels with the error: the caller has to tell a server
        # that rejected the *request shape* from one that could not answer.
        raise ModelError(
            f"the model returned {error.code}",
            status=error.code,
            body=error.read()[:500].decode("utf-8", "replace"),
        ) from error
    except urllib.error.URLError as error:
        raise ModelError(f"could not reach the model: {error.reason}") from error
