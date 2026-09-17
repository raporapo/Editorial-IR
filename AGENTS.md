# AGENTS.md

Instructions for coding agents working in this repository. Humans should read
[README.md](README.md) and [docs/architecture.md](docs/architecture.md) first;
this file is the short version plus the rules that are not negotiable.

## What this project is

A compiler from video plus user knowledge to **Editorial IR**: a structured,
editor-independent representation of what happened and what it is worth to an
edit. Editing applications are output adapters, not the product.

## The boundaries that must not move

1. **Editorial IR is the centre.** Nothing above the adapter layer may know that
   Premiere exists. No NLE object ids, no GUI coordinates, no API payloads in the
   IR, ever.
2. **The agent never drives an editing application.** The path is always
   `IR → EditPlan → adapter → NLE`. An agent that calls an NLE API directly is
   the failure mode this architecture exists to prevent.
3. **A model's output is not the IR.** It is input to the IR, and it is validated,
   attributed and reconciled with user knowledge before it becomes canonical.
4. **User knowledge outranks every model.** `context.yaml` and annotations are
   never overwritten. A contradiction is recorded as a conflict, not resolved by
   deleting one side.
5. **Observed, inferred and user-provided stay separate.** Provenance is
   structural, not a comment.
6. **Model names live in ModelRun records, never in schemas.** Models are
   replaceable backends.
7. **No backend is required.** The rule-based decision layer, the hashing
   embedding and the heuristic context model are the guaranteed path, and every
   test runs on it. If a change only works with a model configured, it is not
   finished.
8. **TypeScript owns the contract; Python implements it.** Do not move core logic
   into Python because a library is convenient there.
9. **Deterministic output.** The same input compiles to the same IR, byte for
   byte. Ordered ids, sorted collections, ties broken by id. Caching and golden
   tests both depend on it.
10. **No native dependencies without profiling.** There are none today and that
    is a feature: `pnpm install` works everywhere.

## Layout

```
packages/contracts   every schema; depends on nothing but zod
packages/perception  model interfaces, ffmpeg, the Python transport
packages/decision    the three judgement primitives and their backends
packages/index       multi-vector retrieval
packages/skills      the rule language and the skill library
packages/core        the compiler
packages/agent       planner, validator, toolkit, reviewer
packages/adapters    OTIO, Premiere, AviUtl2
apps/cli             oea
services/perception  the Python runtime (optional)
schemas/             generated, committed, checked in CI
examples/            the worked example, as a replay fixture
```

Dependencies point one way: `contracts` ← everything, `core` ← `agent` ← `cli`.
An import that goes the other way is a design error, not a convenience.

## Commands

```bash
pnpm install
pnpm verify          # format, typecheck, lint, build, test, schemas, docs, Python
pnpm test            # vitest
pnpm oea demo ./tmp/demo   # the whole pipeline, on the worked example

PYTHONPATH=services/perception/src python -m pytest services/perception/tests -q
```

`pnpm verify` is what CI runs. Run it before you claim something works.

## Changing a schema

1. Edit the Zod definition in `packages/contracts/src/`.
2. `pnpm schema:export` and commit `schemas/`.
3. Bump the version in `version.ts` if the change is not additive.

CI fails when `schemas/` is stale. A cross-language contract that exists in only
one language is how two runtimes quietly diverge.

## Testing

- The worked example (`examples/anniversary-trip`) is a replay fixture: recorded
  perception plus stand-in media files. Use it. It makes the compiler, the
  planner, the validator and every adapter testable with no ffmpeg, no GPU and no
  network.
- Test behaviour that matters, with a name that says why it matters. "never lets
  an event straddle two recordings" is a test; "returns an array" is not.
- Determinism is a property worth testing directly, and several tests do.
- A change to how events are understood, judged, selected or trimmed is not
  finished when the tests pass. Read the cut.
  [docs/evaluation.md](docs/evaluation.md) is how quality is judged here, and how
  to turn "this feels better" into something that can be asserted.

## Things that will be rejected

- Moving the Editorial IR or EditPlan boundary without an explicit reason
  recorded in the commit message.
- A feature that only works with a particular model or API key configured.
- Sending media anywhere without it appearing in the privacy report.
- Silently overwriting user knowledge with model output.
- A new editing application implemented anywhere but `packages/adapters`.
- `any`. Use `unknown` and narrow it.
