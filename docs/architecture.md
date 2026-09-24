# Architecture

The shape of this project is one decision repeated: put a representation in the
middle, and let everything else be a plug-in on one side of it or the other.

```
 media + user knowledge
          │
          ▼
 ┌──────────────────┐
 │   perception     │  ffmpeg, transcription, vision, audio
 └────────┬─────────┘  interfaces; no stage above names a model
          ▼
    observations         what was seen and heard, and nothing else
          │
          ▼
 ┌──────────────────┐
 │   segmentation   │  shots into events
 └────────┬─────────┘
          ▼
 ┌──────────────────┐
 │ context builder  │  what happened here
 └────────┬─────────┘
          ▼
 ┌──────────────────┐
 │  decision layer  │  what is it worth to an edit
 └────────┬─────────┘
          ▼
   ★ Editorial IR       the artefact everything else reads
          │
    ┌─────┴─────┐
    ▼           ▼
  index      skill runtime
    │           │
    └─────┬─────┘
          ▼
       planner            what goes where, for how long
          ▼
      EditPlan
          ▼
      validator           deterministic; the last gate
          ▼
   ┌──────┴──────┬────────────┐
   ▼             ▼            ▼
  OTIO        Premiere     AviUtl2
```

## Why each line is where it is

### Perception is behind interfaces

Nothing in this project tries to be a better speech recogniser. What it insists
on is that every model sits behind an interface, so swapping one is configuration
rather than migration. The practical consequence is the floor: a machine with
ffmpeg and nothing else still produces an Editorial IR, because shot boundaries
come from ffmpeg's own scene metric and silences from reading the audio directly.

That floor is not a demo mode. It is tested, it is the default, and keeping it
working is what stops the architecture from quietly assuming a GPU.

### Observations hold no interpretation

"Laughter at 551120ms" belongs in the observation layer. "This is the emotional
payoff of the trip" does not. The separation is what makes observations cacheable
on the media hash alone: adding a sentence to your background changes what the
footage _means_ without changing what was _heard_, so it must not re-transcribe
an hour of audio. The dependency graph is explicit for exactly this reason.

### Events are not shots

A shot is a camera unit; an event is a unit of meaning. Three shots of walking up
to a gate are one event, and a single unbroken take that changes subject is two.
Everything above reasons about events, so segmentation matters more than almost
anything else the compiler does.

It works bottom-up: start from shots, score every boundary by how much actually
changes there, merge the weak ones away. Bottom-up because every signal available
— a cut, a pause, a new face, a change of subject — is local, and a top-down
split would need a global criterion none of them support. The boundary scorer
renormalises over the signals that exist, so a machine with no transcriber gets a
meaningful answer from shot changes and silence rather than a diluted one.

A shot longer than an event may be (45 seconds) is divided before merging, where
it shows a change: first where the picture starts moving after holding still or
its text changes, then at pauses of a second and a half between utterances, then
at silences, and into the fewest equal parts that fit where nothing marks a
change. A screen recording of six slides is six events, and a ten-minute take is
no longer one ten-minute event.

Which rules apply depends on what the file is. Each asset is classified after
observation — `raw`, `edited`, `clip`, `screen_recording`, `audio_only`, `still`
— from its cut rate, its shot lengths, its stillness, its black and its text, and
the user can overrule it in `context.yaml`. Raw footage is segmented exactly as
described above. An edited video begins an event at every title card, and where
nothing tells its cuts apart the merging joins the smallest pair first, so a
sixty-second edit does not become one 34-second event and nine single shots. A
clip and a still are one event each. See [Editorial IR](editorial-ir.md#what-kind-of-material).

### Chapters follow the day, not the files

A chapter starts at a title card, at a change of place or subject, or where the
files' own capture times are half an hour or more apart. A new file alone does
not start one, because every clip in a folder is a new file and a chapter per
clip is no chapter. Without capture times, long recordings still start a chapter
each and clips and stills stay together unless something else changes.

### Understanding and judgement are separate layers

"What happened here?" and "what is this worth to an edit?" are different
questions with different costs and different lifetimes. The first is expensive
and reusable; the second is cheap and style-independent. Keeping them apart is
what lets one pass over an hour of footage serve a travel vlog, a short and a
wedding film.

The judgement layer answers three primitives — choose, score, is-this-true —
against questions whose levels are written down in
[`packages/decision/src/questions.ts`](../packages/decision/src/questions.ts). A
model asked to "rate importance from 0 to 1" returns a number nobody can
interpret or compare. A model asked to place an event on a five-level scale where
every level has a definition returns something two backends can be compared on.

### Skills are data, not code

A skill says what counts as a good edit. It never looks at video. Change the
model and your style survives; change your style and the analysis survives.

Rules are declarative because a rule file is reviewable, diffable and shareable,
and because a rule cannot reach into the planner and do something surprising.
Selection stays in one place, so a skill cannot produce a plan shape the
validator has never seen.

### The planner is deterministic

"Three minutes" is a hard constraint. "The user marked this essential" is a hard
constraint. A planner that satisfies them by construction is worth more than one
that usually does, and it is free, instant and reproducible, which is what makes
a change to a skill measurable.

A model-driven agent sits _above_ it through the same toolkit rather than
replacing it, and whatever it produces goes through the same validator.

### The validator is the last deterministic gate

It exists because the thing upstream is allowed to be clever. Out points past the
end of a file, two clips on the same frame, a must-keep moment quietly missing:
none of that should reach an editing application, and none of it should be caught
by another model.

### Adapters translate and nothing else

An adapter never plans and never judges. That is what makes a second editor an
adapter rather than a rewrite, and why the agent is not allowed to speak to an
NLE directly — the moment it can, "what Premiere finds convenient" starts
leaking into how events are understood.

Capability differences are negotiated and _reported_. A dissolve that quietly
became a cut is a change to someone's edit, and they are entitled to the list.

## TypeScript and Python

TypeScript owns the contract: the representation, the judgement interface, the
skills, the planning, the adapters, the CLI. All of it is structured data and
orchestration, which is where TypeScript is strong and where the type sharing
between layers pays for itself.

Python implements perception, because that is where the machine learning is.

The transport between them is JSON Lines over a subprocess, and that is a detail
rather than an architecture: replacing it with HTTP or a queue changes one file
on each side, because both sides only ever agreed on the schemas in `schemas/`.
Those schemas are generated from the TypeScript definitions and committed, and CI
fails if they are stale.

## Determinism

The same input compiles to the same Editorial IR, byte for byte. Ordered
identifiers (`evt_0031`), sorted collections, ties broken by id, no wall-clock in
any decision.

It is not tidiness. Caching depends on it, golden tests depend on it, and
measuring whether a change to segmentation or scoring is an improvement depends
on it — a pipeline that answers slightly differently each run cannot be improved,
only fiddled with.

## Cost

Two mechanisms, and both are about the same thing: spending a model where it
changes the answer.

**Caching.** Perception is keyed on the media hash, model identity and pipeline
version. Nothing else invalidates it.

**Escalation.** Most events are unambiguous, and the cheap layer already knows
which ones it is unsure about. Events are ranked by how much a better answer
would be worth — uncertainty first, weighted by how much of the piece they
occupy — and the expensive model runs on as many as the budget allows. A budget
that would be exceeded stops the run with an error, because discovering a limit
on an invoice is not an acceptable way to learn it.

The cache keys, what each kind of edit invalidates, and the three ways of running
it are in [cost.md](cost.md).
