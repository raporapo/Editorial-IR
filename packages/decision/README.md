# @editorial-ir/decision

What is this moment worth to an edit?

Asked as three primitives with defined semantics — choose, score, is-this-true — against questions whose levels are written down in `questions.ts`. That file is why the numbers in an Editorial IR mean anything: a model asked to rate importance from 0 to 1 returns something nobody can interpret or compare.

Backends: rules (the guaranteed path, free and reproducible), any OpenAI-compatible model with structured output, and an optional external decision service. None is required.

See [docs/decision-backends.md](../../docs/decision-backends.md).
