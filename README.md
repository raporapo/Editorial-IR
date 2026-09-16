# Editorial IR

Compile video into something an editor can reason about.

This is not an AI video editor. It is the layer underneath one: it turns raw
footage and what you know about it into a structured, searchable representation
of what happened — and then generates cuts from that representation, for whatever
editing application you use.

The distinction matters. Ask a model to "edit this video" and you get one answer,
expensively, and no way to ask a second question. Compile the footage once into
an **Editorial IR** and a three-minute travel vlog, a thirty-second short and a
wedding film are three cheap reads of the same structure.

```
footage + what you know
          ↓
    what was seen and heard          observations
          ↓
      what happened                  events
          ↓
   what it is worth to an edit       Editorial IR
          ↓  + a skill
     what goes where                 EditPlan
          ↓  + an adapter
  Premiere / AviUtl2 / OTIO
```

## Try it without installing anything

```bash
pnpm install && pnpm build
pnpm oea demo ./demo
```

That sets up a worked example — twenty-seven minutes of a trip to Osaka in three
recordings — and compiles it. No GPU, no network, no API key, no ffmpeg, no cost.

```
ok 73 events in 12 chapters

the analysis
  material: 00:27:00
  events: 73, averaging 22s
  transcribed: 26 utterances
  shots: 104
  relations: 532
  took: 0.1s
  cost: nothing

privacy
  media left this machine: no
```

Then look at what it understood, and cut it:

```bash
pnpm oea timeline --project ./demo
pnpm oea plan --project ./demo --skill travel-vlog --duration 180
pnpm oea plan --project ./demo --skill shorts --duration 40
pnpm oea review --project ./demo
pnpm oea apply --project ./demo --editor otio
```

Both plans come from the same analysis. The second one does not look at the video
again.

## On your own footage

```bash
oea init ./my-trip
oea ingest ./footage
$EDITOR .oea/context.yaml     # the step that matters
oea analyze
oea plan --skill travel-vlog --duration 180
oea apply --editor premiere
```

`context.yaml` is where you write what the footage cannot contain: that this is a
first anniversary, who the two people are, that it should end on the night view.
Nothing in the system ever overwrites it, and it changes which moments the edit
thinks are important. Delete the `occasion` line and compile again to see how
much it moves.

When you disagree with one decision rather than with the whole style, argue with
the cut directly:

```bash
oea plan --skill travel-vlog --duration 180 --require evt_0005 --drop evt_0031
```

`--require` keeps a moment even if the skill threw it out; `--drop` leaves one
out even if it scored well. The planner still owns the target length, so asking
for one more moment shortens the others rather than overrunning. Neither flag can
overrule you: an event you marked `essential` cannot be dropped, and one you
excluded does not come back. A misspelt id is an error, not a silent no-op.

Use `oea annotate` instead when the correction is about the footage rather than
about this cut — an annotation survives re-analysis, and a flag does not:

```bash
oea annotate evt_0031 mood "excitement=0.9, sadness=0"   # this is not a sad scene
oea annotate evt_0031 person "me, partner"               # this is my partner
oea annotate evt_0055 role ending                        # this is where it ends
oea analyze                                              # fold it in
```

Nothing you write there is ever overwritten, in any backend, and the model's own
answer is kept beside yours rather than replaced — remove the correction and its
opinion comes back. The full list is in
[docs/corrections.md](docs/corrections.md).

And when you want to know what is actually inside a moment rather than why it was
chosen:

```bash
oea inspect evt_0014              # the shots it is made of
oea inspect evt_0014 --sheet      # its frames, as one image
```

A thirty-eight second event described as "train window, city" turning out to be
four separate nine-second shots is the kind of thing the summary cannot tell you.

Ingesting media needs `ffprobe` on your PATH. Everything else is optional.

## What it costs to run

The default configuration costs nothing and sends nothing anywhere. It reads shot
boundaries from ffmpeg's own scene metric, finds the silences by reading the
audio directly, judges events with rules, and indexes them lexically. It is not
as good as a model, and it says so — every score carries a confidence, and the
rule-based judge reports 0.4.

Adding models is incremental, and each one is an interface:

| What you add                                   | What improves                                        |
| ---------------------------------------------- | ---------------------------------------------------- |
| `pip install 'editorial-perception[asr]'`      | real transcription instead of silence detection      |
| `pip install 'editorial-perception[visual]'`   | frame embeddings, visual search, better segmentation |
| `OEA_VLM_BASE_URL` + `OEA_VLM_MODEL`           | a closer look at the events that need one            |
| `OEA_DECISION_BASE_URL` + `OEA_DECISION_MODEL` | a second opinion on judgement                        |
| `OEA_EMBED_BASE_URL` + `OEA_EMBED_MODEL`       | search by meaning rather than by words               |

Those endpoints are the OpenAI chat-completions and embeddings shapes, so a local
server (Ollama, vLLM, LM Studio, llama.cpp) and a hosted provider are the same
configuration. Nothing here is required, and nothing is privileged in the code.

**Video is never sent anywhere by default.** The only stage that can send frames
off the machine is the closer look, it only runs when you configure it, and every
analysis reports whether anything left:

```
privacy
  media left this machine: no
```

## Why the middle layer exists

Three things follow from putting a representation in the middle rather than
wiring a model to an editing application.

**Understanding is reusable.** The expensive pass happens once. Changing the
skill, the target duration or the editor re-runs none of it — the dependency
graph is explicit, and adding a sentence to your background does not
re-transcribe an hour of audio.

**Judgement is separable from taste.** The decision layer answers "how much would
this piece lose without this moment?" on a scale whose five levels are written
down. A skill answers "what do I do with a moment like that?". Change the model
and your style survives; change your style and the analysis survives.

**A second editor is an adapter.** The same EditPlan produces an OpenTimelineIO
timeline, a Premiere sequence and an AviUtl2 job. The agent never speaks to an
editing application, so nothing about Premiere can leak into how events are
understood.

## What is in here

|                       |                                                                         |
| --------------------- | ----------------------------------------------------------------------- |
| `packages/contracts`  | Every schema. Zod definitions, exported as JSON Schema into `schemas/`. |
| `packages/perception` | Model interfaces, ffmpeg ingestion, the transport to Python.            |
| `packages/decision`   | "What is this worth to an edit?", as three primitives.                  |
| `packages/index`      | Multi-vector retrieval over the IR.                                     |
| `packages/skills`     | Rules as data, and six of them.                                         |
| `packages/core`       | The compiler: ingest, observe, segment, understand, judge.              |
| `packages/agent`      | The planner, the validator and the toolkit an agent works through.      |
| `packages/adapters`   | OpenTimelineIO, Premiere Pro, AviUtl2.                                  |
| `apps/cli`            | `oea`.                                                                  |
| `services/perception` | The Python runtime. Optional.                                           |

## Documentation

- [Architecture](docs/architecture.md) — the layers, and why they are separate
- [Editorial IR](docs/editorial-ir.md) — what the representation holds, and what it must not
- [EditPlan](docs/edit-plan.md) — what goes where, for how long
- [Writing a skill](docs/skills.md) — the rule language, field by field
- [Writing an adapter](docs/adapters.md) — supporting another editing application
- [Decision backends](docs/decision-backends.md) — swapping how events are judged
- [The perception protocol](docs/perception-protocol.md) — the TypeScript/Python boundary
- [Correcting it](docs/corrections.md) — telling it what it got wrong, and why that wins
- [Looking closer](docs/inspection.md) — the hierarchy, and what each step down costs
- [What it costs](docs/cost.md) — caching, incremental recompute, escalation, budgets
- [Privacy](docs/privacy.md) — what leaves the machine, and when
- [Contributing](CONTRIBUTING.md)

## Status

Early, and honest about it. The contracts are settled enough to build on; the
quality of an automatic cut depends heavily on which models you point it at. The
worked example runs end to end, and CI runs the quick start above exactly as
written, on every commit.

What is deliberately not here: real-time collaboration, colour grading, motion
graphics, automatic music, and a fourth editing application before the first
three are good.

## Licence

Apache 2.0.
