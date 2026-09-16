# Worked example: an anniversary trip

Twenty-seven minutes of footage from one day in Osaka, in three recordings, cut
down to three minutes.

```bash
pnpm oea demo ./tmp/demo      # copies this example and compiles it
pnpm oea timeline --project ./tmp/demo
pnpm oea plan --project ./tmp/demo --skill travel-vlog --duration 180
pnpm oea apply --project ./tmp/demo --editor otio
```

## It is a replay, not real footage

The files under `footage/` are stand-ins. They contain a line of text, and their
only job is to hash to something stable.

Everything perception would have produced from real media — the transcript, the
shot boundaries, the silences, the on-screen text — is written out in
`perception.fixture.json` and replayed by the `fixture` perception backend.

That is deliberate, and it does three jobs:

1. **The whole pipeline runs anywhere.** No ffmpeg, no GPU, no network, no API
   key. Someone can see what this project does before installing anything.
2. **The compiler is regression tested.** Freeze the perception and a change to
   segmentation, scoring or planning shows up as a difference in the result,
   rather than as noise from a model that answers slightly differently each run.
3. **The example is honest about what it demonstrates.** It shows the parts this
   project actually builds — segmentation, meaning, judgement, planning,
   adapters — and does not quietly take credit for a transcriber's work.

To run the same pipeline against real footage, point `oea ingest` at a directory
of video and drop the `--perception fixture` flag.

## What is in the day

| Recording | Length | Roughly |
|---|---|---|
| `IMG_1001.MOV` | 9 min | leaving the hotel, the train, arriving at the gate |
| `IMG_1002.MOV` | 11 min | queues, a ride, lunch, souvenirs, a show |
| `IMG_1003.MOV` | 7 min | the night view, and going home |

`context.yaml` carries what the footage cannot: that this is a first anniversary,
who the two people are, and that the piece should end on the night view. Delete
the `occasion` line and compile again to see how much of the result it moves.

## Regenerating

`node scripts/make-example.mjs` rewrites the fixture. The generator is committed
so the example can be read as source rather than taken on trust.
