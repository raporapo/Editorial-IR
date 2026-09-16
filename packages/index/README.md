# @editorial-ir/index

Finding a moment by describing it.

One event does not fit in one vector: what is on screen, what was said, what happened and what it meant are four different questions about the same eight seconds, so each aspect is indexed and searched separately.

Retrieval is exhaustive cosine in memory, and that is a choice rather than a placeholder — a one-hour project is a few thousand vectors, where a scan costs microseconds and an approximate index costs a native dependency. The interface is there for a project big enough to need pgvector.

Vectors of different widths are never compared: a text query cannot search vision vectors unless the two models share a space, and a confident ranking built out of noise is worse than no answer.
