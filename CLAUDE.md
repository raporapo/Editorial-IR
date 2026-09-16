# CLAUDE.md

Read [AGENTS.md](AGENTS.md). It is the whole guide, and this file exists only so
that Claude Code finds it.

Two things worth repeating because they are the ones most easily lost:

- **`pnpm verify` before claiming anything works.** It is what CI runs: format,
  typecheck, lint, build, tests, and a check that `schemas/` is not stale.
- **The worked example is how you see whether a change is an improvement.**
  `pnpm oea demo ./tmp/demo` then `pnpm oea plan --project ./tmp/demo --skill
travel-vlog --duration 180`. Several real quality bugs in this repository were
  found by reading that output rather than by a test — a planner that selected by
  value per second and filled the cut with two-second shots of nothing, a search
  that ranked confidently on vectors from two different embedding spaces, a
  wordless shot of a city at night classified as filler when it was the ending.

When you change how events are understood, judged, selected or trimmed, run the
example and read the cut. A test can tell you it is still valid. Only the output
can tell you it is still good.
