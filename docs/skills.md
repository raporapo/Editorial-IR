# Writing a skill

A skill says what counts as a good edit. It never looks at video.

The decision layer says "this moment scores 0.91 on emotional intensity". A skill
says "when it scores that high, do not cut it shorter than three seconds". Change
the model and your style survives; change your style and the expensive analysis
survives.

Skills are YAML next to a README, and that is the point: copy one, change three
numbers, and it is yours.

```
my-skills/
  wedding/
    skill.yaml
    SKILL.md
```

```bash
oea plan --skills-dir ./my-skills --skill wedding --duration 300
```

A skill in your own directory shadows a built-in of the same name, which is how
you customise a shipped one without forking anything.

## The smallest useful skill

```yaml
name: wedding
version: 0.1.0
extends: [memory-film]
description: A wedding film. Long, warm, and it never rushes a face.

defaults:
  min_clip_duration_ms: 2500
  max_clip_duration_ms: 10000

rules:
  - id: never-rush-a-vow
    when:
      mentions: ['誓います', 'I do', 'vow']
    action:
      avoid_aggressive_cutting: true
      prefer: 0.4
```

Everything not mentioned is inherited. `oea skills wedding` shows the result.

## Defaults

How every clip in this style is cut, before any rule has an opinion.

| Field                    | Default | What it is                                                                                          |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------- |
| `min_clip_duration_ms`   | 1200    | the shortest a clip may be; below this a shot does not register                                     |
| `max_clip_duration_ms`   | 12000   | the longest a clip may be                                                                           |
| `pad_in_ms`              | 150     | handle taken before the first words, where the source allows it                                     |
| `pad_out_ms`             | 250     | handle taken after the last words                                                                   |
| `snap_to_silence`        | true    | move a cut point to the nearest silence rather than cutting a word                                  |
| `snap_window_ms`         | 600     | how far a cut point may move to find a silence or one of the source's own cuts                      |
| `default_transition`     | cut     | `{ type, duration_ms }` between clips that do not say otherwise                                     |
| `chapter_transition`     | —       | `{ type, duration_ms }` where the cut moves from one chapter to the next                            |
| `still_duration_ms`      | 3000    | how long a photograph is held, inside the bounds the rules put on it                                |
| `keep_whole`             | auto    | `auto`, `always` or `never`: whether a clip is used whole; see below                                |
| `snap_to_cuts`           | auto    | `auto`, `always` or `never`: whether cut points move onto the source's own cuts; see below          |
| `remove_silences`        | false   | take pauses out of speech as jump cuts; see below                                                   |
| `min_removed_silence_ms` | 700     | the shortest pause taken out                                                                        |
| `silence_handle_ms`      | 120     | left beside the words at each side of a removed pause, for the tail of one word and the next breath |

The two duration fields are the shape of the style, and most of what makes one
skill feel different from another: `shorts` caps at 3.5 seconds and `talking-head`
at 25.

### What the material changes

Every file is classified when it is analysed — `raw`, `edited`, `clip`,
`screen_recording`, `audio_only` or `still` — and three defaults decide what that
means for a cut.

- **`keep_whole`.** `auto` uses a clip the user already chose and trimmed
  (`clip`) whole when it fits `max_clip_duration_ms`: they trimmed it on their
  phone, and trimming it again cuts their first syllable. `always` uses every
  event whole, `never` switches `auto` off. A rule's `keep_whole` action, and the
  user's own `oea annotate <asset> merge`, keep an event whole whatever this says.
  Whole is whole or not at all: a clip longer than the room left is left out,
  never shortened.
- **`snap_to_cuts`.** `auto` does it for `edited` material only. An edge moves
  onto one of the programme's own shot boundaries within `snap_window_ms`, and
  never keeps less than 400 ms of a neighbouring shot — shorter than that is a
  flash, which is what a cut three frames off an edit looks like. Raw footage has
  shot boundaries too, but they are camera moves, and snapping to them would move
  cuts that are right; `always` does it anyway.
- **`remove_silences`.** Inside a clip, every pause of at least
  `min_removed_silence_ms` comes out, less `silence_handle_ms` at each side, and
  dead air at the start or end of the clip is taken out to the edge. A pause is
  silence by the same measure the analysis uses everywhere — quiet for this
  recording and quiet in absolute terms, so the gaps in a narration over a music
  bed are not pauses — or a gap between two timed words. It never reaches into a
  word, never takes a gap over music, and never touches a clip kept whole, a
  photograph, a clip nobody speaks in, or a clip whose sound is not used. The
  pieces of one take are separate clips joined by hard cuts
  (`continues_previous` in the plan), and the cut is budgeted by what is left,
  so a three-minute target is three minutes of speech.

Wordless clips of anything but raw camera footage start where their event
starts: only a handheld camera needs a moment to settle.

A photograph is held for `still_duration_ms`, with no sound. A sound file keeps
its sound, whatever a rule says about b-roll. A video with no audio track is
never asked for its sound.

## Inheritance

- `defaults`, `constraints` and `intent` merge field by field.
- `scoring.weights` merges key by key, so you can change one weight without
  restating the others.
- `arc` is replaced wholesale when you declare one, because a partial arc whose
  budgets no longer sum to one is not a useful shape.
- `rules` are concatenated, parent first. At equal priority the child's rule is
  applied later and therefore wins.
- **A rule that reuses an inherited rule's `id` replaces it, in place.** This is
  the only way to switch an inherited rule off, and you need one: `drop` is
  sticky on purpose, so a rule of your own cannot bring back material a parent
  threw away. `tech-youtube` inherits `drop-silence` from `talking-head` — cut
  anything wordless and unremarkable — which is right for one person talking to
  camera and wrong for a tech video, where a silent screen recording of the
  thing working is the part a written article cannot replace. It redeclares
  `drop-silence` with `has_text_on_screen: false` added, and its own
  `screen-without-speech-is-b-roll` becomes reachable.

Merging happens on what you wrote, before the defaults are filled in, so a field
you did not mention keeps the parent's value rather than the schema's. A child
that sets `max_operations` and nothing else used to put its parent's cap on
consecutive shots back to three.

- **An inherited rule's `minimum_duration_sec` and `maximum_duration_sec` are
  clamped to your `defaults`.** An inherited rule may make a clip shorter than
  your ceiling or longer than your floor; it may not take one outside them.

That last rule is there because a duration written in a parent skill means
something different inside yours. `base-editor` has a rule called `trim-dead-air`
that shortens a silent stretch to 4 seconds — against that skill's ceiling of 12,
that is a substantial trim. Inherited unchanged by `shorts`, whose ceiling is 3.5,
the same rule made a wordless shot of a train window the longest clip in a
37-second cut. A rule whose purpose is to shorten things was lengthening one.

Your own rules are not clamped, because there the number and the ceiling are both
yours: `talking-head` caps clips at 25 seconds and then has a rule letting a dense
explanation run to 40, which is the style saying what it is.

Cycles are rejected at load time.

## Scoring

How editorial metrics become the one number the planner ranks by. This is where
a style actually lives.

```yaml
scoring:
  weights:
    story_importance: 1.0
    emotional_intensity: 0.7
    context_relevance: 0.5
    uniqueness: 0.5
    information_density: 0.2
    visual_quality: 0.25
    audio_quality: 0.25
    redundancy: -0.8 # the only strongly negative term
  flag_weights:
    preserve: 0.5
    establishing_shot: 0.3
    redundant: -0.4
```

Scores are normalised by the positive weights, so `prefer: 0.15` means the same
thing whatever scale you chose.

Two more numbers are about the company a moment keeps, and are applied while the
cut is being chosen rather than to the score:

| Field               | Default | What it is                                                                  |
| ------------------- | ------- | --------------------------------------------------------------------------- |
| `duplicate_penalty` | 0.5     | taken off a moment once something it duplicates is already in the cut       |
| `continuity_bonus`  | 0.2     | added to a moment once something it runs on from, or into, is already in it |

Compare `memory-film`, which weights `information_density` at 0.05 — as close to
"ignore it" as the scale allows, because nobody re-watches a memory film to learn
something — with `tech-youtube`, which weights it at 1.0.

## The arc

How the running time is shared out, and which roles each part wants.

```yaml
arc:
  ordering: chronological # or hook_first
  segments:
    - { name: opening, budget: 0.15, prefer_roles: [setup, context] }
    - { name: middle, budget: 0.6, prefer_roles: [payoff, reaction, climax] }
    - { name: ending, budget: 0.25, prefer_roles: [resolution, ending] }
```

Budgets must sum to 1. A segment can also say `require_roles: [setup]`: it
takes the best moment with one of those roles before anything else, because
`tech-youtube`'s opening is not an opening without one.

`ordering: chronological` keeps capture order. `hook_first` lifts one
high-intensity event to the front and leaves everything after it alone. Nothing
else reorders material, because silently rearranging someone's day is the fastest
way to lose their trust in everything else the tool did. `shorts` is the only
shipped skill that uses it.

## Rules

```yaml
rules:
  - id: let-feeling-breathe
    description: The reaction after the moment is usually the moment.
    priority: 0
    when:
      emotional_intensity: '>0.8'
    action:
      minimum_duration_sec: 3.0
      preserve_reaction: true
```

Rules are applied lowest priority first, so the highest-priority rule that
mentions a field wins. `drop`, `require`, `as_b_roll`, `preserve_reaction`,
`prefer_higher_quality_only`, `avoid_aggressive_cutting`, `keep_whole` and
`remove_silences` are sticky: once any rule sets one, a later rule that merely
mentions duration does not undo it.

`keep_whole` and `remove_silences` can also be said `false`, which turns the
skill's default off for the events the rule matches — a rule that says
`remove_silences: false` for `mentions: ['I do']` keeps the pauses in the vows
of a skill that takes them out of everything else. A `true` from any rule still
outranks a `false` from another.

### Conditions

Every field is ANDed. Nest with `all_of`, `any_of` and `not`.

| Field                                                                  | Matches                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any editorial metric                                                   | `story_importance`, `emotional_intensity`, `context_relevance`, `visual_quality`, `audio_quality`, `uniqueness`, `redundancy`, `continuity_previous`, `continuity_next`, `information_density` |
| any editorial flag                                                     | `<flag>_probability`, e.g. `establishing_shot_probability`                                                                                                                                     |
| `narrative_role`                                                       | one role or a list                                                                                                                                                                             |
| `event_type`                                                           | the open-vocabulary kind: `arrival`, `meal`, `travel`, …                                                                                                                                       |
| `affect`                                                               | `{ excitement: ">0.8" }`; an absent axis is zero                                                                                                                                               |
| `duration_ms`, `speech_ratio`, `silence_ratio`, `shot_count`, `motion` | numbers                                                                                                                                                                                        |
| `inactive_ratio`                                                       | the share of the event that was both still and silent, 0 when none was                                                                                                                         |
| `material`                                                             | `raw`, `edited`, `clip`, `screen_recording`, `audio_only` or `still`, or a list; an unclassified file matches none                                                                             |
| `new_location`, `new_person`                                           | true when this differs from the previous event                                                                                                                                                 |
| `has_speech`, `has_music`, `has_laughter`, `has_text_on_screen`        | booleans                                                                                                                                                                                       |
| `has_subtitles`                                                        | the picture carries burned-in subtitles (kept apart from `has_text_on_screen`)                                                                                                                 |
| `is_user_essential`, `is_user_excluded`                                | what the user said                                                                                                                                                                             |
| `chapter_position`, `project_position`                                 | `first`, `middle`, `last`                                                                                                                                                                      |
| `mentions`                                                             | text, matched the way the index matches, including Japanese                                                                                                                                    |
| `involves_person`, `at_place`                                          | ids from your background                                                                                                                                                                       |

Comparators: `">0.7"`, `">=0.7"`, `"<0.2"`, `"<=0.2"`, `"==0.5"`, `"!=0.5"`,
`"0.3..0.7"` for an inclusive range, a bare number for exact match, or
`{ gt: 0.7 }` for machine-generated rules.

A misspelled field is an error, not a silent false. A rule that quietly never
fires is the most frustrating way for a skill to be wrong, because the file looks
correct and the edit ignores it.

`material` is how a rule written for camera footage stays off everything else.
`base-editor` mutes a wordless shot as b-roll, which for a camera left running is
right and for an edited programme is its music bed going silent — measured on
the probe's edited programme, the exported cut had no sound at all — so the rule
says `not: { material: [edited, audio_only] }`. A negative guard keeps the rule
for unclassified material, which is what every file was before classification
existed.

### Actions

| Action                                          | Effect                                                  |
| ----------------------------------------------- | ------------------------------------------------------- |
| `prefer: true \| 0.3`                           | adds to the score; `true` means +0.15                   |
| `avoid: true \| 0.3`                            | subtracts                                               |
| `weight_multiplier: 1.3`                        | multiplies                                              |
| `drop: true`                                    | never select, whatever it scores                        |
| `require: true`                                 | select even when the budget is tight                    |
| `minimum_duration_sec` / `maximum_duration_sec` | bounds for this clip                                    |
| `avoid_aggressive_cutting: true`                | do not trim into it; the floor becomes the whole event  |
| `preserve_reaction: true`                       | extend past the end of speech                           |
| `prefer_higher_quality_only: true`              | among duplicates, keep the best                         |
| `as_b_roll: true`                               | picture only; drop its own sound                        |
| `keep_whole: true \| false`                     | use the event whole or not at all, or trim it after all |
| `remove_silences: true \| false`                | take the pauses out of its speech as jump cuts, or not  |
| `place_at: opening \| ending`                   | position hint, overriding chronology                    |
| `role_override`                                 | force the narrative role                                |
| `transition_in` / `transition_out`              | `{ type, duration_ms }`                                 |
| `tag: [...]`                                    | free tags, carried into the plan's rationale            |

## Constraints

Limits on the whole cut rather than on one clip.

| Field                            | Default | What it is                                                                    |
| -------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `preserve_user_essential_events` | true    | an event the user marked essential survives every rule; leave it on           |
| `max_consecutive_same_role`      | 3       | no more than this many clips of one role in a row, unless the target needs it |
| `forbid_roles`                   | []      | roles this skill never selects                                                |
| `min_speech_share`               | —       | share of the running time that must carry speech; a warning when it does not  |
| `max_operations`                 | —       | the most moments the cut may hold                                             |

`max_operations` counts moments — events — not clips. A take with its pauses
taken out is several clips joined by jump cuts and one moment, and it counts
once; a cap on clips would make taking a pause out cost the cut a whole moment.

## Intent

`intent: { opening, middle, ending, tone }` is carried into the plan as words for
whoever reads it next, and a project's own `tone` replaces the skill's. It
changes nothing the planner does.

## What a skill cannot do

Select clips. Actions adjust the planner's inputs; the planner stays the single
place where "which events, for how long, in what order" is decided. That is what
stops a skill from producing a plan shape the validator has never seen.

Nor can a skill overrule the user. An event marked essential survives every rule
in your file, including one that would drop it.

## Checking it

```bash
oea skills wedding      # resolved manifest, weights, and any problems
```

`validateSkill` catches an arc whose budgets do not sum to one, a rule with an
empty action, a minimum above a maximum, and two rules sharing an id.

## Reading the shipped ones

Each of the eight is an argument, and they are worth reading as prose:

- `base-editor` — the four opinions everything else starts from
- `travel-vlog` — a day somewhere, in order
- `talking-head` — what is said carries it, so speech is never cut into and the
  pauses come out as jump cuts
- `tech-youtube` — the demonstration is the part an article cannot replace
- `memory-film` — feeling is almost the whole ranking, and the ending is 30%
- `shorts` — no context, no establishing shots, and one hook moved to the front
- `cut-down` — a shorter version of something already edited: its order, its
  cuts, its sound, and each section opening on the card that introduced it
- `clip-reel` — a folder of clips the user already trimmed, each whole or
  absent, in the order they were taken
