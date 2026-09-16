# @editorial-ir/perception

Interfaces for every model, and the transport to Python.

Media ingestion that needs only ffmpeg, shot detection from ffmpeg's own scene metric, audio statistics read directly from the WAV, a hashing text embedding that needs no model at all — and the JSON Lines client for the Python runtime where the real machine learning lives.

The rule this package exists to enforce: **no stage above it ever names a model.**

See [docs/perception-protocol.md](../../docs/perception-protocol.md).
