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
not, re-running `oea analyze` does not.

The cache lives inside the project, at `.oea/cache`, so a second project
containing the same clip transcribes it again. That is deliberate: a transcript
is derived from your footage, and the promise that deleting a project directory
removes everything derived from it is worth more than the saving. Because the
keys contain no paths, copying one project's `.oea/cache` into another is enough
to share the work when you want to — 160 results recomputed becomes 161 reused.

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

## What it actually spends, measured

Every number below is from a real run — two minutes of footage, three events,
llama3.2-1b-instruct answering both the descriptions and the judgement:

| stage       | input tokens | output tokens | per event         |
| ----------- | ------------ | ------------- | ----------------- |
| description | 400          | 459           | 133 in, 153 out   |
| judgement   | 4,691        | 559           | 1,564 in, 186 out |

**The judgement stage sends twelve times the input tokens the description stage
does**, which is the opposite of what "the expensive one" above would lead you to
expect. The reason is structural rather than incidental: a description is one
question about one event, and judgement is nineteen. A hosted deployment that
budgets for the vision model and not for the judge has budgeted for the smaller
half.

That table did not exist until recently, and not because nobody ran the
pipeline — because **nothing counted**. `addCost` was called only in the
escalation branch of each stage, so a run whose descriptions and judgements all
came from the base model recorded no tokens and no cost at all, and `oea analyze`
printed "cost: nothing" after making twenty-six model calls. The base model is
the ordinary case: a model on this machine is _made_ the base model precisely so
it can look at every event.

It was not only a reporting gap. `OEA_VLM_SCOPE=base` is documented above as the
way to have a hosted model describe everything, and with the base pass uncounted
`--budget` could not see that spending — a limit that does not bind is worse than
no limit, because the documentation promises that it does.

The dollar figures are estimates and are labelled as such in the code; the token
counts are measured. A price per token belongs to whichever provider you chose,
and the token count belongs to this pipeline. Work on this machine is recorded at
zero, because it is.

## 4. Ask fewer, larger questions

A decision backend that can answer a batch is asked once for all nineteen
questions about an event rather than nineteen times. A contact sheet is one
image rather than twelve. Both are the same trick: per-call overhead is a real
cost on a hosted model, and the answer is no worse.

## 5. Do not ask about footage where nothing happens

A lens cap, a camera left running on a table, a tripod on an empty car park, a
screen recording nobody is touching: each costs as much to describe and judge as
the best moment of the day, and there is nothing in it to find. So the analysis
measures where the footage is **still and silent** and does not pay a model to
look there.

**What it never does is change a time value.** Nothing is cut, trimmed or
re-encoded. Event boundaries are decided before the mask is consulted and
without it, and every source range and every timecode in a plan is the same
number whether the mask applied or not. `tests/activity-mask.test.ts` compiles
the same project both ways and demands that every event, source range and
chapter is identical.

### How stillness is measured

A 64x36 greyscale decode of the proxy at five samples a second, compared frame
to frame, taking the largest mean difference of any cell of a 3x4 grid. Both
choices are measured, not chosen:

| footage                                    | largest cell difference (grey levels) |
| ------------------------------------------ | ------------------------------------- |
| a still frame with phone-like sensor grain | 0.14-0.19                             |
| an empty car park under a traffic camera   | about 0.3                             |
| people sitting still in conversation       | 0.5-0.75                              |
| anything actually moving                   | well above 0.5                        |

The threshold is 0.5, held for at least three seconds. Downscaling first is what
separates grain from motion — grain is independent per pixel and averages away
over a 30x30 block, a person does not — and the largest cell rather than the
frame mean keeps a person crossing one corner of a wide shot counted as motion.
It costs about 1% of real time on a 480p proxy, runs in both runtimes, and the
two agree to the last rounding digit (a test compares them).

### Both conditions, never one

Silence alone is not enough: 65-73% of every test file here is silent, and a
silent drone shot is what a travel edit is made of. Stillness alone is not
enough either: someone talking to a locked-off camera is still, and is the
content. Only the intersection is skipped, and on real footage it is rare —
none of any edited programme, none of people in conversation, the empty
stretches of a traffic camera between cars.

Silence has to be real silence. The silence detector is relative to each file,
so under a music bed the gaps in a narration read as silent while the music plays
on; here a silence also has to sit under -45 dBFS, where room tone is and music,
traffic and crowds are not. A muted track that the relative detector ignores by
design is caught by an absolute floor of -60 dBFS, and a file with no audio track
at all is silent by construction. Words the transcriber heard override the level
meter. Darkness alone is not stillness: a city at night is dark, and it is often
the ending.

Anything not measured is treated as active. A missing measurement costs tokens;
it never costs a moment.

### What is not asked

- An event still and silent throughout (half a second of margin at each edge,
  half a second more allowed) is described and judged by the rules instead of
  the base models, and is never sent for a closer look. Judgement is the large
  half: 1,564 input tokens per event in the table above.
- Frames for a closer look at any other event, and OCR reads, are taken once
  per still span rather than once per sample inside it.
- Frame vectors are **not** thinned. Segmentation reads one per shot, and
  thinning them would move event boundaries — the one thing this may never do.
- An event the user has annotated is always asked about, however still it is.

The IR records it in `quality.savings` — footage judged still and silent, calls
not made, closer looks not taken (or given to other events instead), frames not
sent, and tokens and dollars avoided. It is kept apart from `stand_ins` on
purpose: a model that was there and was not asked is not a model that failed,
and a project with long still stretches does not read as degraded. The rules'
descriptions and judgements carry their own model run, so the IR never claims
the model answered.

### Counted honestly

- **A call the cache would have answered for free is not a saving**, and it is
  not skipped either: when the model's own answer for a quiet event is already
  cached — an earlier analysis made without the mask — that answer is used, at
  no cost and better than the rules'.
- **Tokens avoided are an estimate** and are labelled as one: each skipped call
  is priced by the length of its own prompt, at the tokens per character the
  calls that were made measured in the same run. With nothing measured, nothing
  is estimated.
- **Closer looks** a quiet event would have taken are counted by selecting
  again without the mask; where a count or cost limit applies, the look is not
  saved but given to another event, and is counted as redirected.
- **A dead model is not hidden.** The rules' quiet-event descriptions do not
  count as the model's: the share of fallbacks that marks a run `degraded` is
  taken over the events the model was asked about. Before this, with 53 of 73
  events quiet, a model that refused every call left the IR stamped `standard`.

### Switching it off

`oea analyze --no-skip-inactive` asks the models about every second. It is part
of the observations fingerprint, because OCR reads thinned inside a still span
are stored with the observations. The analysis report says which of four things
happened: still, silent footage was **found**; the picture was measured and
**none was found**; it was **not measured** (no video had its picture analysed);
or the mask was **off**.

### Screen recordings

A screen has no sensor grain, and what changes on it is small. Measured through
the pipeline's own path on synthetic 1920x1080 captures, typing at five
characters a second read 0.14 grey levels at 32 px text and 0.016-0.031 at
14-16 px — all far under the 0.5 that separates camera grain from motion, so a
silent tutorial read as still from end to end. A screen recording is therefore
held to a stillness of 0.003 — below the smallest change the envelope can record
— recomputed from the stored motion envelope, and its on-screen text is never
thinned. An untouched capture read exactly 0 in 149 of 150 samples.

### Smaller frames for the closer look

Frames sent to a vision-language model were full-size source JPEGs. They are
now extracted with the long edge bounded at 768 px (never enlarged). By the
per-image formulas the providers publish, a 1280x720 frame is 1,105 tokens at
OpenAI's high detail, about 1,490 on 32-pixel-patch models and about 1,229 on
Anthropic's; at 768x432 it is 425, 544 and 442 — a third of the cost for every
frame of every closer look, with no time value involved. Small text on a
1920-wide screen becomes unreadable at this size; that is what OCR is for, and
its reads reach the model as text.

### The budget binds the base pass

`--budget` bounded only the closer looks, so a hosted model describing every
event (`OEA_VLM_SCOPE=base`) or judging every event spent past any limit. Both
base passes now stop asking when the limit is reached: the rest of the events
are described or judged by the rules, the compile continues, the report says
where it stopped, and the stage is marked `failed_during_run` with the remedy
"raise --budget".

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
