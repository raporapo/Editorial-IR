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

| Field                  | Default | What it is                                                         |
| ---------------------- | ------- | ------------------------------------------------------------------ |
| `min_clip_duration_ms` | 1200    | the shortest a clip may be; below this a shot does not register    |
| `max_clip_duration_ms` | 12000   | the longest a clip may be                                          |
| `pad_in_ms`            | 150     | handle taken before the in point, where the source allows it       |
| `pad_out_ms`           | 250     | handle taken after the out point                                   |
| `snap_to_silence`      | true    | move a cut point to the nearest silence rather than cutting a word |
| `snap_window_ms`       | 600     | how far a cut point may move to find one                           |
| `default_transition`   | cut     | `{ type, duration_ms }` between clips that do not say otherwise    |

The two duration fields are the shape of the style, and most of what makes one
skill feel different from another: `shorts` caps at 3.5 seconds and `talking-head`
at 25.

## Inheritance

- `defaults`, `constraints` and `intent` merge field by field.
- `scoring.weights` merges key by key, so you can change one weight without
  restating the others.
- `arc` is replaced wholesale when you declare one, because a partial arc whose
  budgets no longer sum to one is not a useful shape.
- `rules` are concatenated, parent first. At equal priority the child's rule is
  applied later and therefore wins.
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

Budgets must sum to 1.

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
mentions a field wins. `drop`, `require`, `as_b_roll`, `preserve_reaction` and
`avoid_aggressive_cutting` are sticky: once any rule sets one, a later rule that
merely mentions duration does not undo it.

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
| `new_location`, `new_person`                                           | true when this differs from the previous event                                                                                                                                                 |
| `has_speech`, `has_music`, `has_laughter`, `has_text_on_screen`        | booleans                                                                                                                                                                                       |
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

### Actions

| Action                                          | Effect                                                 |
| ----------------------------------------------- | ------------------------------------------------------ |
| `prefer: true \| 0.3`                           | adds to the score; `true` means +0.15                  |
| `avoid: true \| 0.3`                            | subtracts                                              |
| `weight_multiplier: 1.3`                        | multiplies                                             |
| `drop: true`                                    | never select, whatever it scores                       |
| `require: true`                                 | select even when the budget is tight                   |
| `minimum_duration_sec` / `maximum_duration_sec` | bounds for this clip                                   |
| `avoid_aggressive_cutting: true`                | do not trim into it; the floor becomes the whole event |
| `preserve_reaction: true`                       | extend past the end of speech                          |
| `prefer_higher_quality_only: true`              | among duplicates, keep the best                        |
| `as_b_roll: true`                               | picture only; drop its own sound                       |
| `place_at: opening \| ending`                   | position hint, overriding chronology                   |
| `role_override`                                 | force the narrative role                               |
| `transition_in` / `transition_out`              | `{ type, duration_ms }`                                |
| `tag: [...]`                                    | free tags, carried into the plan's rationale           |

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

Each of the six is an argument, and they are worth reading as prose:

- `base-editor` — the four opinions everything else starts from
- `travel-vlog` — a day somewhere, in order
- `talking-head` — what is said carries it, so speech is never cut into
- `tech-youtube` — the demonstration is the part an article cannot replace
- `memory-film` — feeling is almost the whole ranking, and the ending is 30%
- `shorts` — no context, no establishing shots, and one hook moved to the front
