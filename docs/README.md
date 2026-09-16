# Documentation

- [Architecture](architecture.md) — the layers, and why each line is where it is
- [Editorial IR](editorial-ir.md) — what the representation holds, and what it must not
- [EditPlan](edit-plan.md) — what goes where, for how long
- [Writing a skill](skills.md) — the rule language, field by field
- [Writing an adapter](adapters.md) — supporting another editing application
- [Decision backends](decision-backends.md) — swapping how events are judged
- [The perception protocol](perception-protocol.md) — the TypeScript/Python boundary
- [Looking closer](inspection.md) — the hierarchy, and what each step down costs
- [What it costs](cost.md) — caching, incremental recompute, escalation, budgets
- [Privacy](privacy.md) — what leaves the machine, and when
- [Knowing whether a change is an improvement](evaluation.md) — how quality is judged here
- [Releasing](releasing.md) — cutting a version across npm and PyPI

Start with the architecture. Everything else assumes you know why there is a
representation in the middle.
