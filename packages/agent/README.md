# @editorial-ir/agent

Deciding what goes in, and proving the result is possible.

The planner is a deterministic optimiser rather than a language model, because "three minutes" and "the user marked this essential" are hard constraints and a planner that satisfies them by construction beats one that usually does.

A model-driven agent sits above it through the same toolkit: it says which moments a particular request is about, and the planner turns that into a cut that is on target and valid by construction.

The validator is the last deterministic gate, and it exists because the thing upstream is allowed to be clever.

See [docs/edit-plan.md](../../docs/edit-plan.md).
