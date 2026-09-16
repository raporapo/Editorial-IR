# Correcting it

Nothing here is ever overwritten by analysis, and nothing here is a suggestion.
A correction outranks every rule and every model, in every backend, permanently.

That is the whole design of this layer, and it has a practical consequence worth
stating first: a correction is stored _beside_ what the model said, not on top of
it. Remove the correction and the model's opinion comes back rather than being
gone. Where the two genuinely disagree, the disagreement is recorded as a
`Conflict` in the IR, with the user's side marked as the resolution — so "the
model thought this was sad and I said it was not" is a fact the representation
carries, not a fact it hides.

## The two places a correction can live

**`context.yaml`** is what you know about the whole project: the occasion, who
the people are, what you want out of it. Write it once, by hand, before
analysing. It is the single highest-value input in the system — deleting the
`occasion` line and recompiling visibly changes which moments the edit thinks
matter.

### People and places are matched, not guessed

Everything you declare under `background.people` and `background.places` is
looked for in what was said, what is written on screen, and what is visible — by
id, by `display_name`, and by every `aliases` entry. Where it is found, the
**canonical id** lands on the event, so a skill rule asking for `partner` works
everywhere rather than on the events where a model happened to use that word.

Aliases are what make this work on real footage, and an alias does not have to be
a name:

```yaml
places:
  - id: 展望台
    display_name: 梅田スカイビル空中庭園
    aliases: [observation_deck, 空中庭園] # the label on the picture is in English
people:
  - id: partner
    aliases: [two_people] # the camera never hears a name; it sees two of us
```

Two consequences worth knowing. A one-character alias is ignored, because it
would match almost every sentence. And a place you name in Japanese becomes
findable by `oea search` even when every label on the footage is in English —
the lexical index cannot bridge languages on its own, and your vocabulary is
what bridges it.

### What `editing_goal` does, honestly

`target_duration_ms`, `tolerance_ms`, `instruction`, `tone` and `language` are
used by everything. `opening`, `middle`, `ending` and `audience` are passed to
whichever model is judging, alongside `tone` — which means they do something with
a model backend configured and nothing with the rule-based default, because that
backend does not read prose. Write them anyway: they cost nothing and they are
the first thing a stronger backend uses.

**`oea annotate`** is what you know about one moment. It survives re-analysis,
which is what makes it different from a flag on `oea plan`.

```bash
oea annotate <target> <kind> [value]
oea analyze          # fold it in
```

## Targets

| Written as           | Means                             |
| -------------------- | --------------------------------- |
| `evt_0031`           | one event                         |
| `evt_0031..evt_0032` | a pair, for `continuity`          |
| `00:18:20-00:18:42`  | a stretch of the capture timeline |
| `asset_001`          | a whole recording                 |

A time range matches an event when they overlap by more than half of the
_shorter_ of the two. Selecting one second inside an eight-second event means
that event; a loosely drawn range that clips its edge does not.

## Kinds

| Kind         | Takes            | Says                                       |
| ------------ | ---------------- | ------------------------------------------ |
| `essential`  |                  | keep this, whatever anything scores it     |
| `exclude`    |                  | never use this                             |
| `importance` | `0..1`           | how much this matters to the story         |
| `rename`     | a title          | what this moment is called                 |
| `note`       | text             | what you know that the footage cannot show |
| `label`      | `a, b`           | what is in shot, when it was missed        |
| `person`     | ids              | who appears, by id from `context.yaml`     |
| `mood`       | `name=0.8`       | how it actually felt                       |
| `role`       | a narrative role | `ending`, `payoff`, `setup`, `reaction`, … |
| `continuity` | `0..1`           | how well two events run together           |
| `split`      | a timecode       | this is really two moments                 |
| `merge`      |                  | this and the next one are one moment       |

### The four that matter most

These are the corrections the design exists to accept, because they are the ones
a model gets wrong in ways that change the edit:

```bash
oea annotate evt_0031 mood "excitement=0.9, sadness=0"   # this is not a sad scene
oea annotate evt_0031 person "me, partner"               # this is my partner
oea annotate evt_0031..evt_0032 continuity 0.95          # these two run together
oea annotate evt_0055 essential                          # this one stays
```

`mood` is a vector rather than one chosen emotion, because editing cares about
_how excited_, not about picking a label. Setting an intensity to zero is how you
say a scene is not the thing the model read it as.

`person` takes ids from `background.people` in `context.yaml`, so that "who is in
this" and "who are these people" use the same vocabulary — and so that a skill
can say "keep the moments with both of them in".

### Corrections that change the shape, not the reading

`split` and `merge` change segmentation, which means they change which events
exist at all. `role` changes what a moment is _for_, which is often the single
thing standing between a good cut and a bad one: a wordless shot of a city at
night is filler or an ending depending on nothing the footage contains.

```bash
oea annotate evt_0055 role ending
```

A role outside the vocabulary is refused rather than stored, because a stored
correction that silently does nothing is worse than no correction at all.

## Two things that are not corrections

`oea plan --require` and `--drop` argue with **one cut**. They do not survive
re-analysis and they are not about the footage — use them when you disagree with
a selection, not when the analysis is wrong.

Editing `ir.json` by hand works exactly once, until the next `oea analyze`
overwrites it. Anything you want to keep goes in an annotation or in
`context.yaml`.

## What happens to your correction

It is folded in during `oea analyze`, and you can see where it landed:

```bash
oea annotate --list
oea explain evt_0031     # provenance: user_provided
```

An overridden field reports its provenance as `user_provided` with confidence 1,
and the model's own answer is kept in the assessment's `history`. If a correction
is not visible in `oea explain` after re-analysing, it did not apply — that is a
bug, not a subtlety.
