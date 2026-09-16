# Privacy

What leaves the machine, when, and how you can tell.

## The default sends nothing

Out of the box there is no network call anywhere in the pipeline. Shot
boundaries come from ffmpeg, silences from reading the audio directly, judgement
from rules, search from a hashing vectoriser. It is not as good as a
model-equipped configuration, and it is a complete one.

## Every analysis reports it

```
privacy
  media left this machine: no
```

Not a claim in a README — it is computed from the `ModelRun` records in the IR,
each of which carries `media_left_device`, set by the backend that ran. When
something did leave, it says what and where:

```
privacy
  media left this machine: yes
  context to openai-compatible (gpt-4o-mini)
```

## What could send what

| Stage                         | Sends                                                           | Only when                       |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------- |
| ingest, prepare, shots, audio | nothing                                                         | always local                    |
| transcription                 | nothing                                                         | local model                     |
| frame embeddings              | nothing                                                         | local model                     |
| on-screen text                | nothing                                                         | local model                     |
| **closer look**               | **video frames, as images**                                     | you set `OEA_VLM_BASE_URL`      |
| judgement                     | the structured event: transcript, labels, tags, your background | you set `OEA_DECISION_BASE_URL` |
| embeddings                    | event text                                                      | you set `OEA_EMBED_BASE_URL`    |

Only one stage can send frames, and it is the only one that reports
`media_left_device: true`. The judgement and embedding stages send text derived
from your media — which may still be sensitive, and is recorded in the IR so you
can see exactly what was sent.

A `localhost` endpoint is recognised as local, so a model on your own machine
does not report as remote.

## Your media is never modified or moved

Ingest hashes files and records paths. It never writes to them, never moves them
and never renames them. Everything derived — proxies, extracted audio, sampled
frames — lives under `.oea/` and can be deleted at any time; it is regenerable
from the originals.

## What is in a project directory

```
.oea/
  project.json        ids and status
  context.yaml        what you wrote; never overwritten
  annotations.json    your overrides
  assets.json         paths, hashes, metadata — not the media
  observations.json   transcript, shots, silences
  ir.json             the Editorial IR
  embeddings.json     vectors
  plans/              cuts
  cache/              perception results, keyed by media hash
  work/               proxies, audio, frames — safe to delete
```

Transcripts contain whatever was said. Treat `.oea/` with the same care as the
footage, and note that it is the one directory worth excluding from a public
repository.

## Keys

Read from the environment, never from flags. A key in shell history is a key in
a backup.

Keys are never written into a project, into the IR, into a plan or into an
adapter's output.

## Deleting things

Deleting the project directory removes everything derived, and leaves your
footage untouched. There is nothing stored anywhere else — no account, no
telemetry, no phone-home. Nothing in this project sends usage data anywhere,
under any configuration.
