# The perception protocol

The boundary between TypeScript and Python.

TypeScript owns the contract; Python implements it. The schemas in
[`schemas/`](../schemas) are generated from the TypeScript definitions, committed,
and checked in CI — a cross-language contract that exists in only one language is
how two runtimes quietly diverge.

They describe what a producer has to write, not what a reader ends up with: a
field with a default is optional there, because leaving it out is allowed and
the default fills it in. An optional field is `T | null`, because a producer may
send either a missing key or an explicit null.

## The transport is not the architecture

Today it is JSON Lines over a subprocess. One request per line on stdin, one
reply per line on stdout, correlated by id. Replacing it with HTTP or a queue
changes one file on each side, because both sides only ever agreed on the
schemas.

**Logs go to stderr.** Not stylistic: the first time a model downloads itself it
prints a progress bar, and a progress bar on stdout would corrupt the stream and
take down a run that was otherwise fine.

## Requests

```json
{
  "v": "0.1.0",
  "id": "req_1",
  "op": "transcribe",
  "params": { "audio_path": "/tmp/audio.wav", "language": "ja" }
}
```

| op              | What it does                                |
| --------------- | ------------------------------------------- |
| `health`        | what this worker can actually do, right now |
| `probe`         | container metadata                          |
| `prepare`       | proxy, extracted audio, sampled frames      |
| `detect_shots`  | shot boundaries                             |
| `analyze_audio` | loudness, silence, speech presence          |
| `transcribe`    | speech recognition                          |
| `embed_frames`  | frame vectors and zero-shot labels          |
| `ocr`           | on-screen text                              |
| `describe`      | the multimodal look at one event            |
| `embed_text`    | text vectors                                |
| `shutdown`      | reply and exit                              |

## Replies

```json
{"v":"0.1.0","id":"req_1","ok":true,"op":"transcribe","result":{"utterances":[…]}}
{"v":"0.1.0","id":"req_1","ok":false,"op":"transcribe","error":{"code":"missing_dependency","message":"…"}}
```

Every result is validated against its schema on arrival. A malformed result is a
failed call, not something to pass downstream and discover later.

Two rules exist so that a version mismatch is an error rather than a hang:

- **`op` on a reply is informational, and a plain string.** A peer on a different
  version may name an operation this one has never heard of, and a reply that
  cannot be parsed is a request that waits forever.
- **An unreadable reply still settles its request.** If a line carries an id that
  is pending, that request is rejected with what arrived, rather than left open.

**Optional fields accept `null` as well as absence.** JSON has no `undefined`,
so a producer in another language writes `null` for a field it has no value for.
Both are accepted and normalised to absence. The shipped worker omits them
anyway, because saying nothing is clearer than saying null — but the consumer
does not depend on that politeness.

## Progress

```json
{ "v": "0.1.0", "id": "req_1", "event": "progress", "progress": 0.42, "message": "やっと着いた" }
```

Out of band; the reply still follows. A transcription pass over an hour of audio
is minutes long, and a tool that shows nothing for minutes is indistinguishable
from one that has hung.

## An error is a reply, not a crash

A handler that raises is answered with an error reply and the loop continues. One
unreadable file out of thirty must not abandon an analysis.

The traceback goes in the reply's `details`, and one line goes in the log. Both
halves of that matter: a traceback is exactly what you want when you are
debugging the worker, and exactly what you do not want printed at somebody who
just ran `oea analyze` on a file it could not read — twenty lines of Python
internals read as a crash rather than as one file being skipped.

## Error codes

| Code                 | What it means                                    | What the caller does                                   |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `missing_dependency` | the package for this capability is not installed | treats the stage as unavailable and carries on         |
| `media_error`        | the file could not be read                       | records it against that asset, continues with the rest |
| `model_error`        | the model failed                                 | as above                                               |
| `out_of_memory`      | it did not fit                                   | as above; a smaller model or fewer slots would help    |
| `bad_request`        | the request was wrong                            | a bug in the caller                                    |
| `unsupported_op`     | this worker does not implement it                | a version mismatch                                     |
| `internal`           | anything else                                    | reported with a stack trace on stderr                  |

`missing_dependency` is deliberately distinct from a failure. An analysis with no
transcript is worse than one with a transcript, and far better than no analysis,
so "unavailable" and "broken" call for different responses.

## Health

```bash
echo '{"v":"0.1.0","id":"1","op":"health","params":{}}' | python -m editorial_perception
```

```json
{
  "ok": true,
  "result": {
    "protocol_version": "0.1.0",
    "capabilities": { "probe": true, "transcribe": true, "embed_frames": false, "describe": false },
    "device": "cuda",
    "vram_total_mb": 16384,
    "ffmpeg_available": true
  }
}
```

Answered by importing rather than by claiming. A capability that says yes and
then fails on first use is worse than one that admits it is missing, because the
compiler is built to degrade around a missing stage and can only do that if it is
told the truth.

## The caller wires only what the worker has

`health` is not diagnostics. It is the contract that lets the compiler degrade
rather than fail: the worker reports which operations it can actually run, and
the caller builds a suite from that answer.

```json
{ "capabilities": { "transcribe": false, "analyze_audio": true, "describe": false } }
```

Wiring a model the worker has just said it cannot run turns "this stage is
unavailable" into "the whole analysis failed" — and that is exactly what used to
happen: `oea analyze --perception python` on a machine with no vision model died
at the first event instead of producing an Editorial IR.

A worker that will not answer `health` is not a reason to fail either. Assume
nothing rather than assume everything.

## The worker survives everything

A handler that raises, a line that is not JSON, a request with no id: none of
them may take the worker down. One unreadable file out of thirty must not abandon
an analysis that is minutes deep, so failures are reported against their request
and the loop carries on.
[`tests/test_protocol.py`](../services/perception/tests/test_protocol.py) exists
for that one property.

## One model at a time

Sixteen gigabytes will not hold a transcriber, a vision encoder and a
vision-language model together, and the pipeline is staged so they never need to
be: everything is transcribed, then everything is embedded, then the events that
earned it are described. `ModelScheduler` enforces it and caches loaders, so
thirty files cost one model load rather than thirty — which is where nearly all
of the wall-clock time goes. `OEA_MODEL_SLOTS=2` raises the limit on a card that
can take it.

## Implementing a different worker

Nothing requires the worker to be the shipped Python one. Anything that speaks
this protocol works: another language, a remote service, a stub for testing.

The TypeScript side of the transport is
[`PythonWorkerClient`](../packages/perception/src/worker/client.ts), and
[`fake-worker.mjs`](../packages/perception/test/fixtures/fake-worker.mjs) is a
sixty-line worker used by its tests — a reasonable place to start.
