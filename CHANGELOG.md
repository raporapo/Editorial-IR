# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html) — with the caveat that
at 0.x the wire formats may still move under a minor bump. Each of the four
contract versions in `packages/contracts/src/version.ts` says separately what it
is compatible with.

## Unreleased

Nothing yet.

## 0.1.0

The first release. An editor-independent representation of what is in a pile of
footage, and a planner that turns it into a cut.

### The representation

- **Editorial IR** — observations, events, editorial judgement and the relations
  between them, as a document you can read. Every value carries where it came
  from (`observed`, `inferred`, `user_provided`, `skill_derived`, `agent_derived`,
  `nle_observed`), disagreements are recorded rather than resolved silently, and
  what the person who shot the footage says outranks every model.
- **EditPlan** — what goes where, for how long, with a written reason per clip.
- 41 JSON Schemas, generated from the Zod definitions and committed, so the
  Python worker and anything else can validate against the same contracts. CI
  fails if they go stale.

### Getting a cut

- `oea demo` compiles 27 minutes of a worked example with no models, no network
  and no API key, and `oea plan` cuts it to a length you name.
- Six skills — `base-editor`, `travel-vlog`, `memory-film`, `shorts`,
  `talking-head`, `tech-youtube` — as declarative YAML rules rather than code.
- A deterministic budgeted planner: the target duration, the moments marked
  essential, and the validator's invariants are satisfied by construction.
- `--require` and `--drop` to argue with one decision without rewriting the
  style; `oea annotate` to correct the footage itself, which survives
  re-analysis.
- An optional model-driven agent that searches and reasons, then hands its
  conclusions to the same planner and the same validator.

### Getting it out

- OpenTimelineIO, Premiere Pro (FCP7 XML) and AviUtl2, each negotiating what it
  can and cannot represent and reporting the downgrades rather than dropping
  them quietly.

### What it costs

- The default configuration costs nothing and sends nothing anywhere: shot
  boundaries from ffmpeg's scene metric, silences read from the audio directly,
  rule-based judgement, lexical search. It reports a confidence of 0.4 for its
  own judgement, because that is what it is worth.
- Every model is an interface, added one at a time. Perception is cached on the
  media hash, so re-analysing after changing a skill or a target duration costs
  nothing; understanding and judgement are cached per event on what the model is
  actually shown.
- Escalation spends a stronger model only on the events where a better answer
  would change the cut, and `--budget` refuses to exceed a figure you name.
