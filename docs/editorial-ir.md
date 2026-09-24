# Editorial IR

The artefact this project exists to produce.

It is what you get when you compile raw media plus user background into something
an editor — human or otherwise — can reason about without touching the video
again. Once it exists, "make a three minute travel vlog" and "make a thirty
second short" are two cheap reads of the same structure rather than two expensive
passes over an hour of footage.

The schema is [`EditorialIR`](../schemas/EditorialIR.schema.json), generated from
[`packages/contracts/src/ir.ts`](../packages/contracts/src/ir.ts).

## What it holds

```yaml
ir_version: '0.1.0'
pipeline_version: '0.1.0'
generated_at: '2026-05-17T09:00:00.000Z'
fingerprint: 'a3f1…' # what produced this, hashed

project: { id, title, status }
context: { background, editing_goal, constraints } # yours; never overwritten

assets: [...] # registered files, unmodified and unmoved
placements: [...] # where each sits on the capture timeline
materials: [...] # what kind of material each file is, and why

chapters: [...] # coarse structure
events: [...] # what happened
editorial: [...] # what each event is worth to an edit
relations: [...] # the graph over events

annotations: [...] # your overrides, kept beside model output
conflicts: [...] # where you and the footage disagree
model_runs: [...] # what produced every value
stats: { ... }
```

## What it must never hold

Anything specific to one editing application: no Premiere object ids, no AviUtl
effect syntax, no GUI coordinates, no API payloads.

That boundary is the whole architecture. The day an NLE identifier appears in the
IR is the day a second editing application becomes a rewrite instead of an
adapter.

## The capture timeline

Events need one ordered axis, or "the previous event" means nothing across thirty
files. That axis is the capture timeline: assets laid end to end in capture
order, with a one-second gap between them.

```
IMG_1001.MOV  ├──────────────┤
IMG_1002.MOV                  ├────────────────┤
IMG_1003.MOV                                    ├──────────┤
              0            9:00              20:01       27:02
```

Event times are on this axis. `source_ranges` carry times inside the actual
files, which is the only coordinate an editing application agrees on.

Order comes from capture metadata when every asset has it and from file name when
they do not, and `placements[].ordered_by` records which. That matters: a wrong
order invents continuity that was never there, which is worse than an arbitrary
one, so `oea ingest` says out loud when it had to fall back.

A still image has no duration — its `duration_ms` is 0, because that is what the
file is — so it takes a slot of `STILL_SLOT_MS` (three seconds) on this axis
instead, and becomes one event over `0..3000` of itself. A project with no stills
is laid out exactly as it was, so no capture time a user wrote about it moves.

The axis is a coordinate system, not a clock: files are one second apart on it
whatever the real time between them. Chapters that need the real time read it
from the files' own `creation_time`.

## What kind of material

Not everything dropped into a project is a camera's raw recording, and the rules
for raw recordings are the wrong rules for the rest. `materials` records, for
every asset, what it was taken to be and why:

```yaml
materials:
  - asset_id: asset_001
    kind: edited # raw | edited | clip | screen_recording | audio_only | still
    confidence: 0.9
    provenance: inferred # or user_provided
    evidence: ['20 cuts a minute over 60 s, where camera footage cuts under one', …]
    signals: { cut_rate_per_min: 20, median_shot_ms: 3000, title_cards: 1, … }
```

The classification reads only observations — cuts, silence, black, stillness,
text — and runs on a reused analysis exactly as on a fresh one. The measured
lines it draws, and why, are in
[`packages/core/src/materials.ts`](../packages/core/src/materials.ts): an edit
cuts at least three times a minute with half its shots under eleven seconds; a
clip is fifteen seconds or less with at most one cut; a screen recording says so
in its file name, or runs at a variable rate, holds still and is full of text.

What it changes:

| Kind               | How it becomes events                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| `raw`              | as it always did: shots, merged by how much changes at each boundary          |
| `edited`           | every title card or cut to black begins an event, and belongs to what follows |
| `clip`             | one event, the whole file, whether or not a shot detector ran                 |
| `still`            | one event over its slot on the capture timeline                               |
| `screen_recording` | as `raw`; its long still stretches are divided where the picture changes      |
| `audio_only`       | as `raw`, from windows and pauses, having no picture                          |

Every kind but `raw` also breaks a tie between equally weak boundaries by joining
the smallest pair, so events stay even where nothing tells the cuts apart; raw
footage keeps the rule the worked example was tuned on.

When the guess is wrong, say so in `context.yaml`, by file name or asset id. It
always wins, and is marked `user_provided`:

```yaml
background:
  materials:
    final_v3.mp4: edited
    asset_004: raw
```

## An event

```yaml
id: evt_0031
chapter_id: chp_003
start_ms: 540000 # capture timeline
end_ms: 548000
source_ranges:
  - { asset_id: asset_001, source_in_ms: 540000, source_out_ms: 548000 }

description:
  value: '二人がUSJ入口に到着し喜んでいる'
  provenance: inferred # not observed, and the difference is recorded
  confidence: 0.91

event_type: { value: arrival, provenance: inferred, confidence: 0.89 }
entities: { value: { people: [me, partner], places: [USJ] }, provenance: inferred }
affect: { value: { excitement: 0.88, happiness: 0.83 }, provenance: inferred }

observed: # copied in, so an event reads on its own
  speech: [{ text: 'やっと着いた！', start_ms: 541000, end_ms: 542900 }]
  visual_labels: [two_people, theme_park_gate]
  ocr: ['UNIVERSAL STUDIOS JAPAN'] # text in the scene, once per line
  subtitles: [] # burned-in subtitles, when there are any
  audio: [{ type: crowd }, { type: laughter }]
  speech_ratio: 0.42
  silence_ratio: 0.08

knowledge: # yours
  occasion: '交際1周年旅行'
  essential: false
  notes: []

segmentation: { method: shot, boundary_confidence: 0.78 }
confidence: 0.91
```

`segmentation.method` says how the event's start was decided: `shot`, `speech`,
`silence`, `similarity` (the picture changed inside a long take), `fixed`,
`user`, `asset` (the whole file) or `title_card` (it opens on a title card or a
cut to black in an edited video).

### Text in the picture is three things

OCR reads everything that looks like letters, and on an edited video that is
subtitles, scene text and burned-in counters. They are kept apart:

- `subtitles` are what was said. A file whose bottom quarter holds sentence-like
  text in at least three separate reads has a subtitle track. Each line appears
  once however OCR spaced it, and it is read the way a transcript is — by the
  describer, for the event's title and mood, by the judge, and in search. Skill
  rules still count it as text on screen, which it also is.
- `ocr` is what was shown: signs, title cards, slides. Also once per line.
- Counters and timecodes (`80010:00:00`, `09:09:09.833`, `25`) are dropped. They
  once named a chapter.

A read with no bounding box is scene text, which is every read in the worked
example.

### Provenance is structural

`observed`, `inferred` and `user_provided` are three different kinds of knowledge
with three different failure modes, and collapsing them is the fastest way to
make an editing system untrustworthy. Once you cannot tell an inference from an
observation you cannot debug a bad cut, and you cannot honour the rule that user
knowledge outranks model output.

Authority runs `user_provided` > `observed` > `nle_observed` > `skill_derived` >
`agent_derived` > `inferred`. It is only ever used to choose what to _present_;
the losing value is kept, and a real disagreement becomes a `conflict` rather
than a silent overwrite.

### Model identity is not in here

Fields carry a `model_run_id`. The model name lives in the `ModelRun` record it
points at, along with where it ran, what it cost and whether media left the
machine. Models are replaceable backends, and a schema that names one is a schema
that has to change when you swap it.

## The editorial layer

Separate from the event, because "what happened" and "what is this worth" have
different lifetimes.

```yaml
event_id: evt_0031
current:
  metrics:
    story_importance: 0.91 # how much the piece loses without it
    emotional_intensity: 0.83
    context_relevance: 0.97 # how well it serves what you asked for
    uniqueness: 0.89
    redundancy: 0.08
    continuity_previous: 0.95
    continuity_next: 0.84
    visual_quality: 0.71
    audio_quality: 0.76
    information_density: 0.55
  flags:
    preserve: 0.96
    establishing_shot: 0.82
    b_roll_candidate: 0.31
    requires_previous_context: 0.12
  narrative_role:
    selected: payoff
    probabilities: { payoff: 0.72, climax: 0.15, transition: 0.07 }
  confidence: 0.87
history: [...] # earlier or alternative backends, never discarded
```

Every metric is a unit score whose meaning is fixed in
[`questions.ts`](../packages/decision/src/questions.ts), so a skill rule written
against `redundancy` means the same thing whichever backend produced it. Flags
are probabilities rather than booleans because a boolean throws away exactly the
information the planner needs when choosing between two near-equal candidates.

`history` keeps what a previous backend said. Re-running with a different model
is a comparison, not a rewrite.

### A unit score has to be a unit score for every backend

`redundancy` comes from cosine similarity, and cosine similarity has no fixed
scale: two things with nothing in common score 0.00 with the lexical vectoriser,
0.184 with CLIP and **0.722** with multilingual-e5-large. The rules turn
similarity into redundancy with a constant, and that constant was written for the
first of those.

Measured on a real 62-minute project embedded with multilingual-e5-large: the
_least_ similar pair of events in the whole project came out at 0.368 redundant
and the median pair at 0.533 — past the 0.5 line a skill rule reads as
"redundant". Every one of its eleven events was marked as repeating itself, on
material where nothing repeated. That is not a ranking nuisance; redundancy is
strongly negative in every skill's weighting, so it drops clips.

So a similarity from a model is calibrated against the corpus it came from
before the rules see it: the bulk of a project's pairwise similarities _is_ that
model's floor, observed where it matters. On the same project that turns eleven
of eleven events over the line into seven, spread across 0.13 to 0.93 instead of
compressed into 0.58 to 0.86. The lexical path keeps the constant, because its
similarity is literally shared n-grams — a known scale, with no defect to fix.

The same correction applies to search: `packages/index/src/calibrate.ts` has the
measurements and the two cases where it declines to answer.

## The event graph

The list already carries "what happened, in order". The graph carries what an
editor reasons about: that this pays off that, that these two are the same take,
that this shot only makes sense after that one.

`continuation`, `payoff_of`, `setup_for`, `reaction_to`, `answers`, `same_topic`,
`same_location`, `same_person`, `contrast`, `callback`, `duplicate_of`.

`duplicate_of` is the one with teeth: at most one member of a duplicate group
belongs in a cut, and the planner enforces it. So it asks for real shared
content: both events have to carry something — speech, subtitles, text, labels,
names — and share at least half of it. Two events with nothing in them have the
same fallback description, and were once all duplicates of each other, which
left an edited programme and a folder of clips with nothing to plan.

## Fingerprints

`fingerprint` hashes what produced this IR: media hashes, your context, your
annotations, the decision backend. A plan records the fingerprint it was built
from, so a plan made against a stale analysis is detectable rather than silently
applied.

Observations carry their own fingerprint, over the media and the perception
models only. That is what makes "the user edited their background" re-run the
cheap half and none of the expensive half.

## Reading it

```ts
import { eventById, assessmentFor, neighboursOf, eventsInOrder } from '@editorial-ir/contracts';

const event = eventById(ir, 'evt_0031');
const judgement = assessmentFor(ir, 'evt_0031');
const { previous, next } = neighboursOf(ir, 'evt_0031');
```

Or from a terminal:

```bash
oea timeline
oea explain evt_0031
oea search "夜景がきれいなところ"
```

## Versioning

`ir_version` changes when the shape or meaning changes. Below 1.0.0 the minor is
treated as the breaking segment, and a document from an incompatible version is
rejected rather than read hopefully.

`pipeline_version` changes when perception or segmentation semantics change
without a schema change — it invalidates caches without invalidating documents.
