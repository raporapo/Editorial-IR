# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html) — with the caveat that
at 0.x the wire formats may still move under a minor bump. Each of the four
contract versions in `packages/contracts/src/version.ts` says separately what it
is compatible with.

## Unreleased

### Added

- **`context.yaml`'s people and places now reach the footage.** They are
  documented as the authority on who is in a video and where it was shot, and
  they were neither: the rule-based context model returned empty arrays
  unconditionally, so every event in the worked example had no people and no
  places while the transcript said 今日はUSJだね. Declared names, display names and
  aliases are now matched against speech, on-screen text and visual labels, and
  the canonical id is what lands on the event — so a skill rule asking for the
  moments with both people in them works, and searching 展望台 finds footage whose
  labels are all in English, which lexical search could never bridge on its own.
  `aliases`, documented since the beginning as "used to link transcript
  mentions", had been read by nothing.
- **`editing_goal.opening`, `middle`, `ending` and `audience` reach the judge.**
  The worked example's own context declares `opening: [energetic]` and
  `ending: [emotional]`, and nothing had ever read either. They now go to
  whichever model is judging, alongside `tone`. Documented honestly: that means
  they do something with a model backend and nothing with the rule-based
  default, which does not read prose.
- **Every correction the compiler understands is now reachable.** `oea annotate`
  exposed five kinds; the contract and the compiler supported eleven. "This is
  not a sad scene", "this person is my partner", "these two run together" and
  "this is the ending" were all implemented end to end and impossible to say.
  Adds `mood`, `person`, `label`, `role`, `continuity`, `split` and `merge`, and
  a pair target (`evt_0031..evt_0032`) for the one that is about two events.
- `oea explain` now shows which parts of an event were the user's rather than the
  model's. A correction that applied silently looked exactly like one that did
  not.
- **Progressive inspection below the event.** The representation is a hierarchy
  — project, asset, chapter, event, shot, frame — and until now everything
  stopped at the event. `oea inspect <event>` is the staircase down: the shots an
  event is made of, the frames behind them, and `--sheet` for one image with the
  frames laid out in order. An agent gets the same two steps as `list_shots` and
  `look_at_event`, which is the last resort and the only tool it has that costs
  money per call.

### Changed

- The planner allocates each clip the duration selection budgeted for it,
  instead of resetting every clip to its floor and redistributing by value.
  Selection and allocation were using two different notions of how long a clip
  should be, so the cut that came out was not the cut that was chosen. On the
  worked example the three-minute travel vlog now carries 89.5% of the speech it
  selected rather than 82.8% — four more seconds of people finishing their
  sentences, at the same length and with the same clips.
- `oea plan --require <id>` now recovers a moment the skill dropped, rather than
  only reweighting one it had already kept, and an event id that names nothing
  is an error instead of silently producing the default cut.
- An inherited skill rule can no longer take a clip outside the bounds the
  skill declared for itself. A duration written in a parent skill means
  something different inside a child: `base-editor`'s `trim-dead-air` shortens a
  silent stretch to 4 seconds against that skill's 12-second ceiling, and
  inherited unchanged by `shorts`, whose ceiling is 3.5, it was lengthening
  clips instead. `tech-youtube` was silently inheriting a 40-second allowance
  against its own 20-second ceiling. A skill's own rules are unaffected.
- `docs/skills.md` documents the `defaults` block, which it had only ever shown
  by example.
- Three new documents for things that were implemented but written down nowhere:
  [the hierarchy and what each step down costs](docs/inspection.md), [caching,
  incremental recompute, escalation and budgets](docs/cost.md), and [how quality
  is judged here](docs/evaluation.md).
- `pnpm docs:check` fails on a broken relative link in any markdown file, and
  runs in CI.

### Fixed

- **Re-analysing a project no longer destroys it.** The perception backend was a
  command-line flag that was never stored, so `oea analyze` on a project built
  from a recorded fixture silently fell back to local perception — turning the
  worked example's seventy-three events into three, with nothing said about why.
  `oea annotate` ends by telling you to run `oea analyze`, so following the
  tool's own advice was the way to hit it. A project now records what it was
  analysed with and re-uses it unless `--perception` says otherwise.
- **"This is the ending" did nothing.** The `narrative_role` annotation was
  parsed, stored and applied to a bag of overrides that only the event builder
  reads — and the narrative role lives on the assessment. It now overrides the
  assessment the way `importance` does, keeping the model's answer in the
  history, and a role outside the vocabulary is refused rather than stored and
  ignored.
- **The cap on consecutive shots of the same kind was declared and never
  enforced.** `max_consecutive_same_role` says in the schema what it is for —
  "to stop six establishing shots in a row" — and the flagship travel-vlog cut
  had seven consecutive `transition` clips: twenty-one seconds of platforms and
  train windows in a three-minute piece. The planner now holds the cut to the
  cap, keeping the best of each run rather than the first, and gives the time
  back to what is left. Speech survival rose from 89.5% to 93.2% as a result.
- **Search returned hash collisions as matches.** The default encoder is a
  hashing vectoriser, so a vector score with no shared word can only be a
  collision — and collisions are not small. Searching the worked example for
  ラーメン returned 最高だった second of four at 0.29, with a confidence bar beside
  it. Retrieval now drops zero-overlap hits when the encoder declares itself
  lexical; a real embedding model is unaffected, since finding "night view" for
  夜景 with nothing in common is exactly what one is for.
- **The consecutive-shot cap could eat the cut.** Material where one role
  dominates is ordinary — forty shots from one afternoon are frequently all
  `context` — and the cap, enforced blindly, saw a single run of forty, kept
  three and dropped thirty-seven: a three-clip film whatever length was asked
  for. Dropping now stops once the remaining clips could no longer cover the
  target between them. Monotony is reduced as far as the target allows and never
  past it. The worked example is unaffected, byte for byte.
- **The AviUtl2 `.exo` rounded an NTSC frame rate away.** ExEdit's `rate` and
  `scale` are the rational pair — fps is rate/scale, which is why `scale` exists
  — and the adapter wrote `rate=30, scale=1` for 30000/1001, hardcoding the
  denominator. Frame numbers computed at 29.97 in a project declaring 30 fps
  play a tenth of a percent fast, drifting audio against picture by about a
  fifth of a second every three minutes. The JSON job built from the same
  numbers in the same file already carried the pair exactly.
- **`min_speech_share` was declared and unenforced.** `talking-head` states that
  seven tenths of its runtime must carry speech, because a talking-head cut
  where nobody is talking is not that thing at all. The validator now checks it
  and warns rather than errors: on quiet material the floor may simply be
  unreachable, and refusing to produce a cut is worse than producing one and
  saying so.
- **`--perception python` died instead of degrading.** Every layer of this
  project promises that a missing model costs you that stage and not the run,
  and the Python path broke it: the CLI wired every worker model regardless of
  what the worker could actually do, so a machine without a vision model failed
  at the first event and produced no Editorial IR at all. The worker has always
  reported its capabilities and `workerHealth` has always existed; nothing
  called it. The suite is now built from the worker's own answer, and a run on a
  bare install completes and says which models would improve it.
- **A Python traceback was printed at the user.** A handler that raises is
  answered with an error reply and the loop continues, which was right — but it
  also logged the whole traceback, and the CLI printed it. Twenty lines of
  Python internals read as a crash rather than as one file being skipped. One
  line goes in the log now; the traceback goes in the reply's details, where
  whoever wants it can have it.
- **The first five minutes.** On a machine without ffmpeg — which is every
  machine before someone installs it — `oea ingest` printed `ok 0 added` above a
  list of errors, and each error read `ffprobe failed: spawn ffprobe ENOENT`.
  A headline contradicting its own body, and a Node error that reads like a
  crash rather than like something to fix. It now reports the failure as one,
  says the program is not installed, and says once how to install it. A path
  that does not exist says so instead of throwing ENOENT through `statSync`, and
  `oea skills <typo>` lists the skills that do exist, which every other command
  taking a name already did.
- `oea demo` works on an installed package. The worked example it needs lives
  outside the CLI package and was not being shipped with it.
- Piping any command into something that stops reading — `| head`, or quitting
  `less` halfway — printed a Node stack trace instead of exiting quietly.

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
