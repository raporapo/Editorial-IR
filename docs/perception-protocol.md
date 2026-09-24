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

| op              | What it does                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `health`        | what this worker can actually do, right now                                                                 |
| `probe`         | container metadata                                                                                          |
| `prepare`       | proxy, extracted audio, sampled frames                                                                      |
| `detect_shots`  | shot boundaries                                                                                             |
| `analyze_audio` | loudness, silence, speech presence, and — with a tagging model — laughter, music, applause, cheering, crowd |
| `transcribe`    | speech recognition                                                                                          |
| `embed_frames`  | frame vectors and zero-shot labels                                                                          |
| `ocr`           | on-screen text                                                                                              |
| `describe`      | the multimodal look at one event                                                                            |
| `embed_text`    | text vectors, from the sentence encoder or from the vision model's own text tower                           |
| `shutdown`      | reply and exit                                                                                              |

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

## What `probe` says and what `prepare` makes

Both runtimes implement these two, rule for rule — `packages/perception/src/ffmpeg/`
and `media.py` — because which one runs is a deployment detail and an asset must
not change with it. `scripts/check-media.mjs` runs the worker's against media it
synthesises; `packages/perception/test/media-layer.test.ts` holds the two to the
same answers.

**`probe`** describes the first _real_ video stream. Album art in an MP3 or M4A
is a one-frame stream marked `attached_pic` and is left out, so a podcast is not
600x600 video. A still reports its size and no frame rate: ffmpeg says 25/1 for
every JPEG, and that 25 once became a 30 fps project's sequence rate.

- `fps_num/fps_den` is the **nominal** rate, `r_frame_rate` — what the camera was
  set to and what an editor conforms to. `avg_fps_num/avg_fps_den` is the
  average. A declared rate above 240 is a container's clock, not a rate: the
  average stands in for it when that is plausible, and otherwise there is none.
- `variable_frame_rate` compares the frames actually in the file, counted over
  the picture's own length, with the nominal rate, at 1%. Matroska and WebM keep
  no frame count and declare the same rate twice whatever their frames do, so
  their packets are counted, without decoding, over the picture stream's
  `DURATION` tag — not the file's length, which runs on as long as the sound
  does and made a constant-rate recording "variable".
- `audio_streams` lists every audio stream; `index` is the position among audio
  streams, what `-map 0:a:<index>` means. Empty is "this file has no sound".

**`prepare`** reads the file's streams itself and makes each derivative on its
own: one that fails is reported in `failed` and the others are still made — a
video with no audio track used to lose its frames to the audio step's error.

| derivative | named                                     | made how                                                     |
| ---------- | ----------------------------------------- | ------------------------------------------------------------ |
| proxy      | `proxy-480p-cfr30.mp4`, `…cfr30000-1001…` | constant rate at the nominal rate, capped at 60; video only  |
| audio      | `audio-a1.wav`                            | one named stream, 16 kHz mono, gaps in its timestamps filled |
| frames     | `frames-1fps/00000001.jpg` …              | by 1-based index, source resolution; `00000001.jpg` is 0 ms  |

Everything is named after what makes it different and written under a temporary
name, then renamed into place, so a work directory reused by a later run — or by
the other runtime — never serves a derivative made another way, and a run killed
halfway never leaves a truncated file for the next one to trust.

With several audio streams and no `audio_stream_index`, each is extracted and
measured with the audio stage's own energy analysis, and the one with the largest
share of speech hops is kept, then the louder, then the earlier. The result says
which and why (`"most speech of 2 (0.47 vs 0.00)"`), and the measurements are
kept in `audio-streams.json` beside the WAVs. ffmpeg's own default is the stream
with the most channels — a camera's stereo room tone, not the mono lavalier on
its second track. `transcribe` and `analyze_audio` accept `audio_stream_index`
and need not read it: it is there so the stream is part of the cache key, which
leaves every path out.

A frame a model is asked about at a moment is named `at-<ms>ms.jpg`, and never
the eight bare digits prepare numbers its frames with. The two once shared a
directory, and a moment at 1000 ms was read from prepare's frame 1000 — the
picture at 999 s.

## Getting the weights

```
pnpm models list          # what there is, how big, under which licence
pnpm models get e5-large  # download, check every sha256, unpack, print the export line
pnpm models check         # re-hash what is on disk
```

Each entry carries a URL that was fetched, a digest computed from what came
back, a byte count and a licence. A mismatch deletes the download rather than
leaving something plausible on disk — a wrong file that stays is worse than no
file, because the next run finds it, skips the download and loads it.

The digests are the point rather than a formality. The model is what decides
every vector the project produces, its name goes into the cache key and into the
provenance record of a document meant to be shared, and a name like
"multilingual-e5-large" covers a dozen exports with different numerics. Only the
hash says which one ran.

| id             | stage           | size   | licence                       |
| -------------- | --------------- | ------ | ----------------------------- |
| `clip-vit-b32` | `embed_frames`  | 607 MB | MIT                           |
| `e5-large`     | `embed_text`    | 1.3 GB | MIT                           |
| `minilm-l6`    | `embed_text`    | 83 MB  | Apache-2.0 — **English only** |
| `ced-tiny`     | `analyze_audio` | 29 MB  | GPL-3.0 — see below           |

`minilm-l6` is the small option and it is not a multilingual one. Measured after
provisioning it with this script and loading it through the project's own
encoder: `cos(夜景, "night view of the city")` = 0.347 while
`cos(夜景, "料理を食べている")` = 0.502. It ranks the wrong one higher, which is the
exact failure `e5-large` is there to avoid.

**Transcription is not in the table**, and that is a real gap rather than an
omission. `faster-whisper` loads CTranslate2 weights, and the only hosts that
publish them are huggingface.co and its mirrors. Where those are reachable
faster-whisper downloads them itself on first use and there is nothing to do.
Where they are not — a policy that blocks model hubs is ordinary inside
companies — copy a converted directory in by hand and point `OEA_ASR_MODEL` at
it. No PyPI package ships one, and converting needs torch and transformers,
which this project deliberately does not install.

Two stages need nothing: `ocr` ships its three PaddleOCR models inside the
`rapidocr-onnxruntime` wheel, and `describe` and the judgement backend are HTTP
endpoints rather than files.

## Audio event tagging, and the licence you have to pick

`analyze_audio` always reports loudness, silence and speech presence: that is
signal processing and needs no model. Classifying **laughter, music, applause,
cheering and crowd** needs one, and this is the one place in the project where
the model choice is a legal decision rather than a technical one.

The rule engine has exposed `has_laughter` and `has_music` since it was written.
Until a tagger exists they are unreachable, and `memory-film`'s
`laughter-is-the-point` rule never fires — a rule that reads as implemented,
passes review, and silently makes the edit worse than the skill promises.

Set `OEA_AUDIO_TAGGER` to a model directory. There is deliberately **no
default**, because the best option is encumbered:

| model                                 | size      | speed                   | quality                                                                | licence                                                   |
| ------------------------------------- | --------- | ----------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `sherpa-onnx-ced-tiny-audio-tagging`  | 6 MB int8 | 120x realtime, 1 thread | zero false positives on laughter and applause across 28 clips; F1 0.88 | **GPL-3.0** — weights converted from a GPL-3.0 repository |
| `sherpa-onnx-zipformer-audio-tagging` | 300 MB    | 19x realtime            | not measured here                                                      | Apache-2.0                                                |

Whether GPL-3.0 on the training repository reaches the weights is genuinely
contested. It is not a question this codebase should answer by picking a
default, so it does not: an unset variable means the stage does not run, which
costs the classification and nothing else. A permissively-licensed deployment
should use the Apache-2.0 model.

Two measured details worth keeping:

- **One thread, not four.** Each window is two seconds of audio, so the
  intra-op thread pool costs more to synchronise than the work it splits —
  `num_threads=4` measured 2.6x _slower_ than 1, consistently, for both models
  and both quantisations. Parallelise across files at the process level.
- **The resolution is the hop, not the frame.** These models answer "what is in
  this audio", not "what is at 3.2 seconds". Timestamps come from sliding a
  2 s window 1 s at a time and merging windows that agree. That is enough to
  ask whether laughter is in an event, and not enough to cut on — which is what
  the transcript's word timings are for.

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

Two of these deserve a note because they look like one capability and are two:

- **`embed_frames` and `embed_text_visual`.** A CLIP export with only
  `visual.onnx` embeds frames perfectly well and cannot encode a query into the
  space those vectors live in. Nothing else can either — only the model's own
  text tower puts a sentence beside a frame — so without it the `visual` aspect
  of the index holds vectors that no query can reach, and search falls back to
  matching its labels as words. That is a real state a worker can be in, so it
  is a separate capability rather than an assumption.
- **`stage_query_languages`.** CLIP's and SigLIP-base's text towers are
  English-only. Measured on CLIP ViT-B/32: six frames against six English
  descriptions scored 6/6 top-1, and the same six concepts asked in Japanese
  scored 4/6 with the margins at noise level. A Japanese query does not fail
  against that tower — it returns a confident ranking of noise — so the worker
  reports `{"embed_text_visual": "en"}` and the client declines instead of
  answering badly. A checkpoint whose name says it is multilingual reports
  `multi`.

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
