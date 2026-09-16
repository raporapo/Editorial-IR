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
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from ..errors import MissingDependency, ModelError

SYSTEM_PROMPT = (
    "You describe one moment from a video so that an editor can reason about it later. "
    "Say what is happening, not what it means for the edit; another layer judges that. "
    "The user background you are given is knowledge you do not have. Use it, and never contradict it. "
    "If the frames and the background disagree, describe the frames and leave the background alone. "
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

    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "semantic_event", "strict": True, "schema": RESPONSE_SCHEMA},
        },
    }

    body = _post(f"{base_url.rstrip('/')}/chat/completions", payload, os.environ.get("OEA_VLM_API_KEY"))
    text = (((body.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
    try:
        answer = json.loads(text)
    except json.JSONDecodeError as error:
        raise ModelError("the model did not return JSON", content=text[:300]) from error

    usage = body.get("usage") or {}
    return {
        "model": model,
        "description": str(answer.get("description", "")),
        "event_type": str(answer.get("event_type", "")),
        "title": answer.get("title"),
        "entities": answer.get("entities") or {},
        "affect": {k: max(0.0, min(1.0, float(v))) for k, v in (answer.get("affect") or {}).items()},
        "confidence": max(0.0, min(1.0, float(answer.get("confidence", 0.5)))),
        "input_tokens": usage.get("prompt_tokens"),
        "output_tokens": usage.get("completion_tokens"),
    }


def build_prompt(params: dict[str, Any]) -> str:
    sections: list[str] = []
    user_context = params.get("user_context") or {}
    if user_context:
        sections.append(f"Background the user provided:\n{json.dumps(user_context, ensure_ascii=False, indent=2)}")
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


def _post(url: str, payload: dict[str, Any], api_key: str | None, timeout: int = 120) -> dict[str, Any]:
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
        raise ModelError(f"the model returned {error.code}", body=error.read()[:500].decode("utf-8", "replace")) from error
    except urllib.error.URLError as error:
        raise ModelError(f"could not reach the model: {error.reason}") from error
