# Knowing whether a change is an improvement

A cut that validates is not the same as a cut that is good, and almost every real
quality bug in this repository passed every test at the time it was introduced. A
planner that filled three minutes with two-second shots of nothing produced a
valid plan. A search ranking on vectors from two different embedding spaces
returned well-formed results. A skill rule that made clips _longer_ in a skill
whose entire premise is short ones broke no schema.

So there are three layers of checking, and they answer three different questions.

## Calibrating on footage you cannot share

Most footage worth testing this on is personal, and none of it needs to move.

```bash
node scripts/scene-report.mjs ./my-footage --continuous
```

It runs where the footage already is and prints only arithmetic — durations,
boundary counts per sensitivity, and the score distribution. No frames, no
transcript, no OCR, no filenames unless you pass `--names`. Every line that
reaches stdout is in one `report()` function at the bottom of the file, so the
claim is checkable in a minute.

`--continuous` is the useful one and needs no annotation: it says these are
unedited camera takes, so every boundary found inside one is a false positive.
That measures over-segmentation directly, which is the risk the current default
carries. `--cuts-at 12.0,45.5` on a single edited clip measures the other
direction.

This exists because the scene threshold is the one number here that synthetic
material cannot settle — colour fields with grain are adversarial for a content
metric in ways a camera is not. A few hundred bytes of output from real footage
decides it; the footage itself is not needed and should not be sent.

## 1. Is it still correct?

`pnpm verify`. Formatting, types, lint, build, tests, and a check that the
exported JSON Schemas are not stale. This is what CI runs and it is the floor,
not the bar.

## 2. Is it still the same?

`tests/golden/example.json` freezes the compiled worked example and the three
cuts made from it, clip by clip. Any change to how events are segmented,
understood, judged, selected or trimmed moves this file, and the diff is the
statement of what you changed.

A moved golden file is not a failure. An _unexplained_ moved golden file is. When
the planner's duration allocation was fixed, the diff was two fields — `duration`
and `duration_error_seconds` — and no clip was added, removed or reordered, which
is precisely the claim the change was making. Regenerate with `pnpm
golden:update` and read the diff before you commit it.

## 0. What tier is this number about?

Before any of the three, check what produced the IR you are measuring.

Every IR carries `quality.tier`. `standard` means description, judgement and
search all ran real models. `offline_minimal` means at least one of them was a
stand-in — rules, a template, lexical hashing. `degraded` means a model was
configured and broke partway.

**Numbers from different tiers are not comparable, and it is not a matter of
degree.** A model-backed compile does not merely score the same events more
accurately; it selects _different_ events. A percentage over a different
selection is a different measurement wearing the same name.

This matters here because the worked example, the golden file and every quality
property asserted in `tests/` run at `offline_minimal` — CI has no models and
must not need any. So "89.5% of the selected speech survives its trim" is a true
statement about the planner sitting on top of stand-ins, and `tests/plan.test.ts`
asserts the tier next to the number so that stays visible. It is the right thing
to regression-test and the wrong thing to quote as the product's quality.

To measure the product, analyse with models configured and compare against
another `standard` run. `oea doctor` says whether this machine can.

## 3. Is it still good?

Only the output can tell you this.

```bash
pnpm oea demo ./tmp/demo
pnpm oea plan --project ./tmp/demo --skill travel-vlog --duration 180
```

Read the cut. Not the summary line — the list of clips, in order, with their
lengths and roles. Several of the bugs listed at the top of this page were found
by reading that list and nothing else.

### Turning a judgement into a measurement

"This cut is better" is not reviewable, and taste is not a regression test. When
a change to quality is worth keeping, find the property underneath it and measure
that instead.

The duration-allocation fix is the worked example of this. The observation was
"the speech beats feel rushed". The measurable property underneath it was _how
much of the speech inside the selected clips survives the trim_ — because a clip
cut shorter than the sentence inside it cuts somebody off mid-word, and no schema
notices. That went from 82.8% to 89.5%, which is a number that can be asserted,
and `tests/plan.test.ts` now asserts it with a floor deliberately set below
today's value: it is a guard against the regression, not a restatement of the
current number.

Properties worth measuring this way:

| Property              | Why it stands in for quality                                   |
| --------------------- | -------------------------------------------------------------- |
| speech survival       | clips that cut people off mid-sentence                         |
| clip length variation | a cut where everything is the same length reads as a slideshow |
| essential recall      | a moment the user marked essential that is missing             |
| duration error        | a cut that misses the length it was asked for                  |
| redundancy in the cut | the same thing shown twice                                     |

## Evaluating the representation, not the cut

The IR is worth judging on its own, separately from any cut made from it, because
every cut inherits its mistakes:

- **Event coverage** — is an important moment missing entirely?
- **Boundary accuracy** — do events start and end where the meaning does?
- **Semantic accuracy** — is the description of the event true?
- **Provenance correctness** — is anything inferred being presented as observed?
  This is the one that is checkable mechanically, and it is checked.
- **Context consistency** — does anything contradict what the user said in
  `context.yaml`? The user's word outranks every model, and a representation that
  quietly disagrees with them is worse than one that admits it does not know.
- **Retrieval quality** — can you find a moment by describing it in the words you
  would naturally use?

## The measure that actually matters

Not "what percentage of the edit was automatic". That number can be driven to one
hundred by a tool nobody would use.

The one worth optimising is **how much of the editor's time it saved** — the time
to a usable rough cut, how many of the tool's decisions survived, how many had to
be undone. A rough cut that takes twenty minutes to fix is worth more than a
finished-looking one that takes an hour to undo.
