# Knowing whether a change is an improvement

A cut that validates is not the same as a cut that is good, and almost every real
quality bug in this repository passed every test at the time it was introduced. A
planner that filled three minutes with two-second shots of nothing produced a
valid plan. A search ranking on vectors from two different embedding spaces
returned well-formed results. A skill rule that made clips _longer_ in a skill
whose entire premise is short ones broke no schema.

So there are three layers of checking, and they answer three different questions.

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
