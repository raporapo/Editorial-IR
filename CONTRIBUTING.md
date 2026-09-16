# Contributing

## Getting set up

```bash
pnpm install
pnpm verify          # format, typecheck, lint, build, test, schema freshness
pnpm oea demo ./tmp/demo
```

That last command is the fastest way to see what the project does. It needs no
ffmpeg, no GPU and no network.

For the Python side:

```bash
cd services/perception
pip install -e '.[dev]'
PYTHONPATH=src python -m pytest tests -q
```

## Before opening a pull request

Run `pnpm verify`. It is exactly what CI runs.

If you changed how events are understood, judged, selected or trimmed, also run
the worked example and read the output:

```bash
pnpm oea demo ./tmp/demo
pnpm oea plan --project ./tmp/demo --skill travel-vlog --duration 180
```

A test can tell you the plan is still valid. Only the output can tell you it is
still good. Several real bugs in this repository were found that way rather than
by a failing test — a planner that filled the cut with two-second shots of
nothing, a search that ranked confidently on vectors from two different embedding
spaces, a wordless shot of a city at night classified as filler when it was the
ending.

## Things worth knowing before you change something

The boundaries in [AGENTS.md](AGENTS.md) are not style preferences. In
particular:

- No editing application may be visible above `packages/adapters`.
- A feature that only works with a model or an API key configured is not
  finished. The rule-based path is the guaranteed one, and every test runs on it.
- User knowledge is never overwritten by model output. A contradiction is
  recorded as a conflict.
- Output is deterministic: same input, same IR, byte for byte.

## Changing a schema

1. Edit the Zod definition in `packages/contracts/src/`.
2. `pnpm schema:export`, and commit `schemas/`.
3. Bump `version.ts` if the change is not additive.

CI fails on a stale `schemas/`.

## Tests

Test behaviour that matters, and name it for why it matters. "never lets an event
straddle two recordings" is a test; "returns an array" is not.

The worked example (`examples/anniversary-trip`) is a replay fixture: recorded
perception plus stand-in media files. Use it rather than mocking — it makes the
compiler, the planner, the validator and every adapter testable end to end
without ffmpeg, a GPU or a network.

## Commit messages

Say what changed and why it is the right change. If you moved a boundary or
reversed an earlier decision, say so explicitly — a year from now the commit
message is the only place that reasoning survives.

## Good first contributions

- **A skill.** `docs/skills.md` is the guide; a skill is a YAML file and a
  README. A wedding, a cooking video, a conference talk, a sports highlight.
- **An adapter.** `docs/adapters.md`. Resolve, Final Cut and Kdenlive are all
  reachable through interchange formats.
- **A perception backend.** A better shot detector, a better audio tagger, a
  different transcriber. They are all behind interfaces.
- **The example.** More material, or a second example in a different genre.

## Reporting a problem

For a bad cut, the useful report is the plan and the analysis, not a description:

```bash
oea plan --json > plan.json
oea explain evt_0031
```

Those say what the system believed and why, which is usually enough to find the
disagreement between what it thought and what you wanted.
