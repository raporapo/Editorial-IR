# @editorial-ir/contracts

Every schema this project has.

The Zod definitions for the Editorial IR, the EditPlan, skill manifests, the decision-layer primitives, the adapter contract and the perception protocol — exported as JSON Schema into [`schemas/`](../../schemas).

It depends on nothing but `zod`, and it must stay that way: every other package depends on this one, so it has to be cheap to depend on.

Two conventions worth knowing:

- **snake_case on the wire, camelCase in process.** These documents are read by Python, by JSON Schema tooling and by humans editing YAML.
- **Strict objects everywhere.** A typo in a hand-written skill file or project context is rejected rather than silently ignored.

See [docs/editorial-ir.md](../../docs/editorial-ir.md).
