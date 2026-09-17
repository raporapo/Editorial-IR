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
a cut rather than refuse to export.

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
