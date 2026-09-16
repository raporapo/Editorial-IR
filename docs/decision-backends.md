# Decision backends

The decision layer answers one question — what is this moment worth to an edit? —
and it answers it as three primitives with defined semantics.

```ts
interface EditorialDecisionModel {
  choice(state, request): Promise<ChoiceResult>; // pick from a closed set
  score(state, request): Promise<ScoreResult>; // place on a labelled scale
  booleanProbability(state, request): Promise<BooleanResult>; // probability a statement holds
  assessAll?(state, request): Promise<BatchAnswers>; // optional: all of it in one call
}
```

## Why not just ask a model for a number

Ask for `"importance": 0.82` and you get a number nobody can interpret, two runs
that are not comparable, and nothing to calibrate against.

Every scale here has five written levels:

```
story_importance — how much would the finished piece lose if this were cut?
  0 nothing       removing it changes nothing a viewer would notice
  1 supporting    pleasant texture, but the piece survives without it
  2 informative   carries something the viewer needs to follow what happens
  3 significant   a turning point; the piece reads differently without it
  4 essential     the piece does not work at all without it
```

A rule and a language model answering that question are answering the _same_
question, which is what makes their outputs comparable and what lets a skill rule
written against `story_importance` mean one thing. The full set is
[`questions.ts`](../packages/decision/src/questions.ts), and it is versioned with
the IR because changing the wording changes what every stored score means.

## Distributions, exactly

Every backend answers with a distribution, including the rule-based one. The
planner routinely chooses between two events whose scores differ by a hundredth,
and the shape of the belief is the only thing distinguishing "clearly a payoff"
from "could be a payoff or a reaction".

The distribution's mean is exactly the reported value. That is load-bearing: a
symmetric kernel can never average out to the end of a scale, so marking an event
essential used to produce 0.86 where the contract requires 1. The shape is drawn
from the family of distributions that _do_ have the requested mean — maximum
entropy when the backend claims nothing beyond its estimate, two-point when it is
confident, any blend of the two.

## The shipped backends

### `heuristic` (default)

No model, no key, no network, same answer every time. It reports a base
confidence of 0.4, and that number is what the escalation policy reads when
deciding which events deserve something better.

It is not as good as a model and does not pretend to be. What it has is
legibility — every score traces to an observation you can point at — and the fact
that it always works, which is what makes the whole pipeline testable and lets
someone try the product before installing anything.

### `local-system-one`

Any model speaking the OpenAI chat-completions shape with structured output.
"Local system one" describes how it is used rather than where it runs: small,
fast, structured judgements over an already-understood event, not a second pass
over the video.

```bash
export OEA_DECISION_BASE_URL=http://localhost:11434/v1
export OEA_DECISION_MODEL=qwen3:8b
oea analyze --decision local-system-one
```

It answers the entire question set in one call. Nineteen round trips per event,
each re-sending the same context, is how a project like this becomes too
expensive to run on an hour of footage.

### `jev`

An adapter for an external system-one decision service. The three primitives were
chosen to match what such services offer, and this is that seam.

It is never required. Every test, every default and the documented quick start
run without it and produce the same shape of IR. The endpoint paths are
configuration rather than constants, because that contract is not ours to pin in
code.

```bash
export OEA_JEV_BASE_URL=https://decisions.example.com
export OEA_JEV_API_KEY=…
oea analyze --decision jev
```

Expected shapes:

```
POST {base}/score    { state, question, levels }  →  { level, probabilities }
POST {base}/choice   { state, question, options } →  { selected, probabilities }
POST {base}/boolean  { state, statement }         →  { probability }
```

An option the service returns that was never offered is rejected rather than
stored.

## Hybrid, which is usually what you want

Configure a model but leave `--decision` alone, and the rules answer everything
while the model gives a second opinion on the events the rules are unsure about —
weighted by uncertainty, by how much of the piece an event occupies, and by how
close it sits to the line that decides whether it survives at all.

```bash
export OEA_DECISION_BASE_URL=… OEA_DECISION_MODEL=…
oea analyze --budget 0.50 --max-escalations 40
```

A budget that would be exceeded stops the run with an error. Discovering a limit
on an invoice is not an acceptable way to learn it.

## Failure is not the end of a compile

Wrap a fallible backend and it degrades instead of losing work that is minutes
deep:

```ts
new FallbackDecisionBackend(remote, new HeuristicDecisionBackend(), { giveUpAfter: 5 });
```

The fallback's answers carry the fallback's own confidence, so the substitution
stays visible in the IR rather than being laundered into looking like the model's
opinion.

## Writing one

Implement the interface. Implement `assessAll` if you can answer several
questions in one call. Report an honest `baseConfidence`: it is what decides
whether anything more expensive gets used.

```ts
export class MyBackend implements EditorialDecisionModel {
  readonly identity = {
    backend: 'mine',
    locality: 'local' as const,
    mediaLeavesDevice: false,
    baseConfidence: 0.75,
  };
  async score(state, request) { … }
  async choice(state, request) { … }
  async booleanProbability(state, request) { … }
}
```

`state` is a structured event: transcript, labels, on-screen text, sound tags,
neighbours and user background. No pixels, no audio, no file paths. Judging an
already-understood event is what makes this layer cheap, fast and reproducible,
and it means a hosted decision backend never receives media.
