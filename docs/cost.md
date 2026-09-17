# What it costs

The default configuration costs nothing and sends nothing anywhere. Everything
below is about what happens once you add a model, because that is the point at
which an hour of footage can quietly cost more than the edit is worth.

Four mechanisms, and they are all the same idea from different angles: spend a
model where it changes the answer, and never spend it twice on the same
question.

## 1. Never run the same model on the same material twice

Perception results are content-addressed. The key is:

```text
media_sha256
model identity (backend, model, version)
parameters
pipeline version
```

Nothing else invalidates it. Renaming the file does not, moving the project does
not, re-running `oea analyze` does not. Two different projects containing the
same clip share the transcription of it.

Understanding and judgement are cached the same way, one step further up:

| Stage       | Keyed on                                                        |
| ----------- | --------------------------------------------------------------- |
| Perception  | the media hash, the model, its parameters, the pipeline version |
| Description | everything the model is shown, plus which model is asked        |
| Judgement   | the event's state, plus which model is asked                    |

"Everything the model is shown" is exact and it matters: the transcript, the
on-screen text, the visual labels, the user's own context, whether frames were
attached. Not the event id — segmentation renumbers events, and a description of
unchanged material should survive that. Not the frame file paths — the same
event analysed from a different working directory is the same question.

## 2. Recompute only what actually changed

Every stage depends on the one above it, and most edits to a project do not
reach very far up:

| What you changed                | What is recomputed                 |
| ------------------------------- | ---------------------------------- |
| the media                       | everything                         |
| a model, or its version         | that stage and everything below it |
| `context.yaml`                  | descriptions, judgement, the IR    |
| an annotation on one event      | the judgement of that one event    |
| the skill                       | the plan only                      |
| the target duration             | the plan only                      |
| the editor you are exporting to | the export only                    |

Changing the occasion in `context.yaml` genuinely does change what the footage
means, so it re-describes everything — that is correct, not wasteful. Changing
the skill does not change what the footage _is_, so it does not touch the
analysis at all. The difference between those two is worth several dollars per
run on a hosted model, and `tests/incremental.test.ts` asserts it by counting
model calls rather than by timing anything.

## 3. Spend the good model only where it changes the answer

Running the expensive model over every event is the obvious design and the one
that makes an hour of footage cost more than the edit is worth. Running it
nowhere produces a timeline nobody trusts.

So events are ranked by how much a better answer would be worth:

- how unsure the cheap layer already is,
- how much of the piece the event occupies,
- how close the decision is to the line that decides whether it survives at all.

The expensive model runs on as many as the budget allows, in that order. The
cheap layer's answer is kept for the rest, along with its confidence — the
rule-based judge reports 0.4, and says so, rather than pretending.

`--budget 2.00` refuses to exceed two dollars and stops with an error. Finding
out a limit from an invoice is not an acceptable way to learn it.

## 4. Ask fewer, larger questions

A decision backend that can answer a batch is asked once for all nineteen
questions about an event rather than nineteen times. A contact sheet is one
image rather than twelve. Both are the same trick: per-call overhead is a real
cost on a hosted model, and the answer is no worse.

## Three ways to run it

```text
LOCAL    everything on your machine. No API cost, nothing leaves.
HYBRID   cheap perception locally, the uncertain events to a model.
CLOUD    everything remote.
```

Hybrid is usually the right answer, and it is what the escalation policy above
exists to make possible: transcription, shot detection and audio analysis are
cheap and local, and only the handful of events where a better answer changes
the cut are sent anywhere. The privacy consequences of each are in
[privacy.md](privacy.md), and every analysis reports which one you were actually
in.

## Running locally on one card

Sixteen gigabytes is the declared target, and a transcriber, a vision encoder
and a vision-language model will not co-exist in it.

The fix is not smaller models but never holding two at once. The pipeline is
already staged that way — transcribe everything, then embed everything, then
describe the events that need it — and a model scheduler makes it a rule rather
than a convention: work that needs accelerator memory takes a lease, and a lease
for a different model waits for the previous one to be released. Work in the same
slot runs back to back without reloading, which is where nearly all of the
wall-clock time goes.

```text
CPU:  ffmpeg, shot detection, orchestration, the index
GPU:  one of { transcription, visual embeddings, description, judgement }
```

## Size, and why the graph is bounded

An hour of footage is roughly six hundred events, and the relations between them
are pairwise: same topic, same place, same person, callback, duplicate. Left
unbounded that grows with the square of the events, and the numbers are not
academic — 600 events produced 220,000 relations and 28 MB of JSON inside
`ir.json`, and 1,200 produced 716,000 and 101 MB.

Each event keeps its strongest few links of each kind, which makes the graph
linear: about 23 relations per event whatever the length of the recording. Every
consumer already worked this way — the agent toolkit returns the six strongest,
`oea explain` prints six — so nothing is lost that anything was using.

`continuation` is never thinned. It is one link per adjacent pair, already
linear, and dropping one would invent a discontinuity that is not there.

## Speed

The stated target for an hour of video is 0.25–0.5× its duration once optimised,
and roughly real time before that.

The thing to watch is anything inside a pairwise loop, because it runs a number
of times that grows with the square of the events. Splitting a description into
its matchable features was being done four times per pair; hoisting it to once
per event took an hour of footage from 3.9 seconds to 0.28, and three hours from
36 seconds to 2.5.

Speed is deliberately second to quality of the IR. A fast pipeline that
misunderstands the footage produces a cut you have to redo, which is not faster.
