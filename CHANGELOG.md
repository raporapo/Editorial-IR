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

- **Premiere got hard cuts where a skill asked for dissolves.** All three
  adapters advertise `basic_transition` and name the types they support, so
  negotiation passes transitions through untouched and records no downgrade —
  and the Premiere writer wrote none of them. The worked example has always
  carried eleven cross dissolves at its chapter changes and the sequence has
  always imported with none. They are written now, cut to the handles the
  footage actually has either side of the cut, because a dissolve is made of
  frames neither clip is using and inventing them is how an XML imports with
  clips in the wrong places. OTIO and AviUtl2 also read `transition_out`, which
  names the same join from the other side and was being dropped.
- **The published schemas said optional fields were required, and described them
  as anything at all.** `schemas/` is the cross-language contract and it was
  exported from the output side, where a field with a default is "required"
  because Zod will have filled it in. Worse, `jsonOptional` — which every
  optional field in the perception protocol uses — is a transform, so it was
  exported as the empty schema `{}` and listed as required: the contract said a
  probe's `width` was mandatory and could be a string. They are exported from the
  input side now, which is what a producer has to write.
- **`Iso8601` accepted "yesterday".** It documents "always UTC with a trailing Z"
  and checked only that the string was not empty, while the `Sha256` beside it
  has a regex. It matters because assets are laid on the capture timeline in the
  order these strings sort in: a camera writing `2026-05-17 09:00:00`, or a local
  offset instead of `Z`, ordered the footage wrongly and invented continuity that
  was never there. The format is validated, a container's date is normalised on
  the way in or dropped if it cannot be read, and the ordering compares instants
  rather than strings.
- **A filename with a `?` in it imported as a missing file.** `encodeURI` leaves
  the characters that delimit a URL alone, which is right for a URL and wrong for
  a path becoming one: `what? really.mp4` became a path of `/media/what` with a
  query string after it. `#` had been handled; `?`, `[` and `]` had not. A UNC
  path now puts its server in the authority (`file://server/share/…`) instead of
  producing four slashes and an empty one.
- **Reading on-screen text wrote frames into the user's footage directory.** The
  worker guessed "beside the file", which for an asset with no proxy is wherever
  the original media lives — the ingest promise that the original is never
  modified or moved, broken one `_frames` directory at a time. The caller says
  where they go, inside the project, and a caller that says nothing gets a
  scratch directory that is cleaned up.

- **One index held vectors from two different spaces.** An event a vision model
  reached got a frame vector under the `visual` aspect; an event it missed got
  an embedding of the words attached to the picture, under the same name. The
  two are points in unrelated spaces and their scores are not comparable, so the
  events a vision model happened to cover were ranked against the rest on a
  number that meant something different for each. Nothing downstream could see
  it: the vector index refuses vectors of different widths, which catches this
  only when the two models disagree about how wide a vector is. Either every
  visual vector in an index comes from the pictures or none of them does, and an
  event without one is still searchable as words through the same aspect.
- **Re-analysing a project erased its provenance.** Model runs lived only in the
  IR of the compile that made them, and observations are reused — that is the
  normal path, and the one `oea annotate` tells you to take. So a second run
  produced an IR holding two runs instead of eight, whose utterances, shots and
  frames all pointed at model runs that were not in it. "Did any of my footage
  leave this machine" was being answered without the models that had touched it.
  The runs are now stored with the observations they produced and taken back on
  reuse.
- **The report said "no model configured" for a stage that had one.** Reusing an
  analysis drops the frame vectors — visual search falls back to words and
  boundaries are found without them — and the only thing said about it was
  nothing, unless no vision model was configured at all, which is the case where
  nothing was lost. Each skipped stage now carries its own reason.

- **A slow file took the rest of the run with it.** The Python worker handles
  one request at a time and cannot be told to stop, so abandoning a request on
  timeout did not free it: everything sent afterwards waited behind work nobody
  was waiting for, and timed out in turn. A timeout now ends that worker and
  fails what it was holding, with a reason, and the next request starts a fresh
  one.
- **Every on-screen text box was a number in the wrong units.** The contract
  says a normalised box in [0,1]; the test that was meant to enforce it was
  inverted, so a box already normalised was thrown away and one in pixels was
  passed through and stored as though it were a fraction of the frame. Boxes are
  now divided by the frame's own dimensions, read from the file's header, and a
  box that cannot be placed is left out rather than guessed at.
- **A model that answered with nonsense was recorded as certain.** The
  vision-language backend clamped `confidence` with `max(0, min(1, x))`, and
  Python's `min` hands `NaN` straight back — so a non-numeric answer became 1.0,
  the end of the scale that makes the pipeline stop asking. A value that is not
  a finite number now falls back to the default, `affect` drops what it cannot
  read rather than failing the call, and `entities` is coerced to the four lists
  the contract expects instead of being passed through as the model wrote it.
- **The worker could write a line the client cannot parse.** `NaN` and
  `Infinity` are Python JSON, not JSON; a reply carrying one was read as a stray
  log and the request hung until its timeout. Replies are now serialised with
  `allow_nan=False`, which turns that into an error against the request that
  caused it.
- **`pnpm verify` did not run the half of CI that was failing.** The Python
  worker's lint was red, and the command the guide tells you to run before
  claiming anything works never looked at it. `pnpm verify` now runs ruff and
  pytest over the worker, skipping out loud when Python or the tools are not
  installed rather than silently.

- **A cut chain came apart in the middle.** A clip flagged as making sense only
  after the one before it is dropped when that one is not in the cut — and the
  pass walked the selection in the order things were selected, which is by value
  within an arc segment rather than by time. So dropping an answer orphaned the
  reply to it, because the reply had already been looked at and kept. The pass
  now walks the cut in time order, where a clip's predecessor is always decided
  first, and it runs again after the cap on consecutive shots of the same kind,
  which drops clips of its own.
- **"Keep the reaction" could quadruple a clip.** The tail was measured from the
  last speech anywhere in the event rather than the last speech the clip
  actually contains, and nothing held it to the skill's ceiling. A thirty-second
  take with a few words at the start and a few more half a minute later produced
  a 29.3-second clip out of an 8-second ceiling. `memory-film` was carrying two
  clips past its own 8-second limit and finishing five seconds over target; it
  now finishes within half a second of it.

- **Inheriting a skill lost most of what the parent had tuned.** `defaults`,
  `constraints` and `intent` are documented as merging field by field, and did
  not: the schema fills in every field it has a default for before the merge
  happens, so a child that changed `max_operations` and nothing else silently
  put its parent's cap on consecutive shots back to three, its padding back to
  250ms and silence snapping back on. Composition now happens on what each file
  actually wrote, and the schema is applied once to the finished skill.
- **A child skill could not switch off a rule it inherited.** Dropping is sticky
  by design — "never use this" should not be undone by a later rule about
  duration — which left no way to disagree with a parent. `tech-youtube`
  inherits `drop-silence` from `talking-head`, and its own
  `screen-without-speech-is-b-roll` could never fire, because a silent screen
  recording of the thing working had already been thrown away: in a tech video
  that is the demonstration, the part a written article cannot replace. A rule
  that reuses an inherited rule's `id` now replaces it, in the parent's
  position, and `tech-youtube` redeclares `drop-silence` to leave anything with
  something on screen alone.
- **`duplicate_penalty` and `continuity_bonus` were declared and never applied.**
  Both are in the schema with documented meanings and defaults, and selection
  ranked every candidate once, in isolation, before anything had been chosen —
  so neither could have been read. Selection now re-ranks after each pick: a
  shot loses value when something it duplicates is already in, and gains a
  little when it continues something that is. On the worked example the
  three-minute travel cut keeps 74.3% of its speech rather than 70.7%, makes 22
  clean cuts rather than 18, and carries two fewer wordless shots at the same
  length.
- **An arc segment's `require_roles` did nothing.** `tech-youtube` declares
  `require_roles: [setup]` on its opening because a piece that never says what
  it is about loses the viewer in the first seconds; the planner read only
  `prefer_roles`. A segment that insists on a role now takes the best material
  carrying one before the ordinary ranking spends its budget.
- **`transition_out` was dropped between the skill and the plan.** The rule
  runtime set it, the plan contract carries it, the validator checks it and both
  adapters write it — and the planner never copied it onto the operation, so a
  skill asking for a fade out of the last shot had no effect anywhere.

- **"Cut here" landed in the wrong asset, or nowhere at all.** A `split` or
  `merge` boundary annotation carries a position on the capture timeline, and the
  segmenter compared it against asset-local offsets — so a cut asked for once was
  applied at that same offset inside every asset, and the asset the user meant got
  a boundary only by coincidence. Worse, a boundary that did land was honoured
  only where it fell on an atom edge the detectors had already found, which is
  exactly where the user has no reason to ask. Boundaries now resolve to the asset
  that contains that moment, and an atom is split at the point requested.
- **`excluded_assets` excluded nothing.** `context.yaml` documents it as the way
  to say "do not use this footage", the contract carries it and the compiler
  passes it through; the planner read `knowledge.excluded` on the event and never
  the project-level list. A whole camera the user had ruled out could be selected,
  and the plan's rationale would not mention it. Excluded footage is now dropped
  at selection with a rationale that names the exclusion.
- **An escalated judgement was attributed to the cheap model.** Every assessment
  recorded the base run's id, including the ones a hosted model was paid to
  answer — so the IR told a reader, and the next run's escalation policy, that a
  rule-based judge at confidence 0.4 had said what the expensive model said. The
  run that produced an answer is now the run recorded against it.
- **The expensive half of the run was never cached.** The cheap pass went through
  the assessment cache and the escalation loop called the model directly, so
  re-analysing an unchanged project asked the hosted backend the same questions
  about the same events and was charged for them again. Escalated assessments are
  cached on the same key as the base ones, and a cached answer keeps the
  attribution of the model that originally gave it.

- **Every export was silent.** The EditPlan names which clips carry their own
  sound and declares the tracks to lay it on; both adapters read neither. A
  Premiere sequence arrived with no audio track and an OpenTimelineIO timeline
  with one video track, while the capabilities advertised two audio tracks. Both
  now write the source audio — Premiere links each audio clipitem to its picture
  with `linkclipref`, OTIO leaves gaps where a clip declined its own sound so the
  two tracks stay aligned — and an external bed, which neither can write, is
  reported rather than dropped.
- **Premiere clipitems carried two lengths that disagreed.** `end - start` and
  `out - in` were rounded from milliseconds independently and differed by a frame
  on 14 of the 39 clips in the worked example. Every clip is now laid out once on
  the frame grid, and where rounding would push one clip's end past the next
  clip's start, the length gives way — an overlap is a thing a sequence cannot
  represent, so the importer resolves it by guessing.

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
- **The event graph grew with the square of the events.** An hour of footage is
  roughly six hundred events, and the relations between them are pairwise: 600
  events produced 220,000 relations and 28 MB of JSON inside `ir.json`, and 1,200
  produced 716,000 and 101 MB, taking fifteen seconds to build. One long
  recording is the commonest input there is. Each event now keeps its strongest
  few links of each associative kind, which makes the graph linear — about 23 per
  event at any length — and nothing is lost that anything was using, since every
  consumer already took a handful. `continuation` is never thinned.
- **Building that graph was fifteen times slower than it needed to be.**
  Splitting a description into its matchable features was being done four times
  per pair, inside a loop that runs a number of times that grows with the square
  of the events. Hoisting it to once per event took an hour of footage from 3.9
  seconds to 0.28, and three hours from 36 seconds to 2.5, with identical output.
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
