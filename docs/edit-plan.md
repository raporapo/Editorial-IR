# EditPlan

What goes where, for how long.

It sits between the Editorial IR and any editing application on purpose. The
agent writes a plan; adapters translate a plan; neither ever meets the other.
That is why a second NLE costs an adapter instead of a rewrite, and why a plan
can be validated and diffed without opening Premiere.

Schema: [`EditPlan`](../schemas/EditPlan.schema.json).

## Shape

```yaml
edit_plan_version: '0.1.0'
id: plan_2w2d3bk3rj03
project_id: prj_…
ir_fingerprint: 'a3f1…' # which analysis this came from
skill: { name: travel-vlog, version: '0.1.0' }

sequence:
  name: '大阪1周年旅行 — 180s'
  target_duration_ms: 180000
  tolerance_ms: 15000
  width: 3840
  height: 2160
  frame_rate_num: 30000 # the exact rational; 29.97 survives
  frame_rate_den: 1001

tracks:
  video:
    - operation_id: op_0001
      source_asset_id: asset_001
      event_id: evt_0001 # walk back to the reasoning
      source_in_ms: 1850 # in the source file's own time
      source_out_ms: 5450
      timeline_start_ms: 0
      track: 0
      role: setup
      speed: 1
      use_source_audio: true
      provenance: agent_derived
  audio:
    - { type: source_audio, track: 0, gain_db: 0 }
  text: []

intent: { opening: energetic, middle: fun, ending: emotional }

rationale:
  - event_id: evt_0001
    operation_id: op_0001
    decision: trimmed
    reason: 'scored 0.41; rules: keep-what-matters; trimmed to the speech in it'
    skill_rule_ids: [keep-what-matters]

stats:
  operation_count: 42
  total_duration_ms: 180400
  duration_error_ms: 400
  compression_ratio: 0.111
  mean_importance: 0.44
  mean_continuity: 0.62
```

## Two coordinate systems

`source_in_ms` and `source_out_ms` are in the **source file's own time**, never
on the capture timeline, because that is the only coordinate every editing
application agrees on. `timeline_start_ms` is position in the finished piece.

A clip's timeline length is `(out - in) / speed`. Derived, never stored twice:
two fields that can disagree eventually will.

## What a clip is made of

One kind of operation covers every kind of file, and the asset decides what an
adapter writes:

- **A video** is its picture and, with `use_source_audio`, its sound. A video
  with no audio track never has `use_source_audio: true` — the probe's drone clip
  used to come out of Premiere with two audio clips for a stream that did not
  exist. With more than one audio stream, `audio_stream_index` names the one the
  analysis listened to (`-map 0:a:N`); absent means the first.
- **A photograph** is held for the skill's `still_duration_ms`: `source_in_ms` 0,
  `source_out_ms` the hold. Any range of a still is valid, because it is the same
  at every instant, and it never uses source audio.
- **A sound file** is its sound, always, whatever a rule says about b-roll.

## Where a clip starts and stops

[`trim.ts`](../packages/agent/src/trim.ts) decides it, and the rules outrank each
other in this order:

1. Never in the middle of a word.
2. In edited material, on the programme's own cuts, never leaving less than
   400 ms of a neighbouring shot. When a word runs across a cut, the way out of
   the word that crosses no cut is preferred.
3. On a quiet moment, when one is near — silence by the same measure the rest of
   the analysis uses, so the gaps in a narration over a music bed are not quiet.
4. Keeping the reaction after the last words, when the skill asks for it.

A clip of anything but raw camera footage starts where its event starts; only a
handheld camera needs a moment to settle. A clip the user already trimmed is used
whole or not at all.

## Jump cuts

A skill with `remove_silences` takes the pauses out of a take. The take becomes
several operations with the same `event_id`, each after the first marked
`continues_previous: true`, always joined by hard cuts:

```yaml
- { operation_id: op_0002, event_id: evt_0004, source_in_ms: 0, source_out_ms: 1580 }
- {
    operation_id: op_0003,
    event_id: evt_0004,
    source_in_ms: 3160,
    source_out_ms: 7080,
    continues_previous: true,
  }
```

They are one moment. `stats.events_selected` counts events, not operations; a
skill's `max_operations` counts moments; the reviewer does not call a piece too
short or ask what context the second half of a sentence is missing; and the
validator warns (`invalid_continuation`) when a clip claims to continue one that
is not the same take, later in the same file, cut hard.

## Chapters

When a cut spans two chapters or more, `markers` holds a `chapter` marker where
each run of a chapter begins on the timeline, named as the IR names the chapter,
in timeline order. Chapters exist in capture time; this is where each one is in
the finished piece, which is the only place an editor or a viewer can use it.

Two chapters in a row with the same name are one marker — the IR keeps two
visits to one place apart, and a viewer of a three-minute cut sees one — and a
cut left with a single marker after that gets none, as a one-chapter cut does.

## Rationale is data

Every event is accounted for — `selected`, `trimmed`, `dropped`, `locked` or
`excluded` — with a reason and the skill rules that fired.

It is a first-class field rather than a log because the first thing anyone asks
about an automatic edit is "why did you cut that", and the answer has to survive
into the review loop. The Premiere adapter writes it into clip comments, so it
is there when you open the sequence.

```bash
oea explain evt_0061
```

```
in the latest plan
  dropped: another take of the same thing was kept instead (evt_0069)
    rules: suppress-duplicates, use-quiet-picture-as-b-roll
```

## Validation

Nothing reaches an editing application unvalidated.
[`validatePlan`](../packages/agent/src/validator.ts) checks that media exists,
that in is before out, that nothing reads past the end of a file, that no two
clips share a frame of a track, that every event the user marked essential is
present and every excluded one is absent, and that the duration is inside
tolerance.

Errors block. Warnings do not: an adapter is expected to downgrade a dissolve to
a cut rather than refuse to export. Two warnings are about the media rather than
the timeline: `source_audio_missing`, for a clip asking for the sound of a file
that has none, and `invalid_continuation`, for a jump cut that is not one.

`oea plan`, `oea review` and `oea apply` all validate against the skill the plan
was made with when it can be found by name and version, so what only the skill
knows — the speech share it promises, the clip limit that explains a short cut —
is checked every time rather than once.

Codes are stable and are what tests and adapters branch on; messages are for
humans and may change.

## Capability negotiation

Editing applications differ. The honest way to handle that is to declare the
differences and adjust inside them, rather than generating an ambitious plan and
discovering in the NLE that half of it was ignored.

```bash
oea editors
```

Adjustments are reported, never silent:

```
changed to fit
  ! transition_in: fade_in became a cut (op_0014)
```

## Revisions

The first plan is a rough cut. [`reviewPlan`](../packages/agent/src/reviewer.ts)
reads it back and reports what an automatic edit gets recognisably wrong: a jump
between two places with nothing in between, a reply to a question the viewer
never heard, the same thing twice, a clip too short to register.

Suggestions are returned rather than applied, because the fix for "this jumps" is
usually to add a shot the planner already rejected, and that has a cost — the
piece gets longer — that belongs to whoever is running it.
