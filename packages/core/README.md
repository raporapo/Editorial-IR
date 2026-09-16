# @editorial-ir/core

The compiler.

Ingestion, perception with caching, event segmentation, meaning, judgement, chapters, the event graph and the search index — into one Editorial IR.

The order is not arbitrary. Perception is keyed on media hashes so it survives everything else changing. Embeddings come before judgement because redundancy is a question about the whole set. User knowledge is applied last at every stage, so a model never gets the final word over a person.

Stages degrade rather than fail: one unreadable file out of thirty is recorded and skipped.

See [docs/architecture.md](../../docs/architecture.md).
