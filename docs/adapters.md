# Adapters

An adapter translates an EditPlan into something an editing application, a
player or a person can use. It never plans and never judges.

That constraint is the reason a second editor costs an adapter instead of a
rewrite — and the reason the agent is not allowed to speak to an NLE directly.
The moment it can, "what this particular application finds convenient" starts
leaking back into how events are understood.

## What ships

`oea editors` prints this from the adapters themselves; `oea apply --editor <id>`
writes one.

| id                 | writes                                   | stills | captions          | chapters             | renders |
| ------------------ | ---------------------------------------- | ------ | ----------------- | -------------------- | ------- |
| `otio`             | OpenTimelineIO `.otio`                   | yes    | no (use `srt`)    | stack markers        | no      |
| `premiere`         | Final Cut Pro 7 XML (xmeml v4) `.xml`    | yes    | no (use `srt`)    | sequence markers     | no      |
| `fcpxml`           | FCPXML 1.10 `.fcpxml`                    | yes    | SRT-role captions | chapter markers      | no      |
| `edl`              | CMX 3600 `.edl`                          | no     | no                | `LOC` comments       | no      |
| `aviutl2`          | JSON job + ExEdit `.exo`                 | yes    | in the job        | in the job           | no      |
| `srt`, `vtt`       | SubRip / WebVTT caption files            | —      | yes               | —                    | no      |
| `youtube-chapters` | `00:00 Title` lines for a description    | —      | —                 | yes, YouTube's rules | no      |
| `preview`          | a small `.preview.mp4`, rendered locally | yes    | burned in         | mp4 chapters         | yes     |

"No" is declared, not discovered: `negotiate()` removes what a target cannot
hold and every removal is listed under "changed to fit".

### Every kind of media

A clip is a `VideoOperation` whatever its file is, and the asset decides what an
adapter writes (`pictureOf`, `soundOf` in
[`timeline.ts`](../packages/adapters/src/timeline.ts)):

- **A still** is its picture held for the clip's length. Premiere writes a
  still-frame clipitem; OTIO a clip whose media range covers it; FCPXML a
  `video` element on an image asset; AviUtl a 画像ファイル. A photograph has no
  length, so each is given room either side and a dissolve into or out of one
  always has frames to use. An EDL cannot hold a still and says so.
- **A sound file** (a voice memo, a podcast, a recorder) is sound only: audio
  clips, no picture and no `<video>` media. The picture track is left empty for
  its length, and the preview draws it over black.
- **A video with no audio stream** (a drone clip, a timelapse) gets no audio
  clips. It used to get two per clip, which imported as offline media.
- **Several audio streams**: the clip's `audio_stream_index` (the stream the
  analysis found the speech on) is the one linked. Premiere counts channels
  across the streams before it; FCPXML turns on only that stream's
  `audio-channel-source`; OTIO records it in metadata; the preview maps it with
  `-map 0:a:N`; the EDL names it in a comment; the `.exo` cannot choose and says
  so.
- **Channels** come from the stream: a mono lavalier is one track, not a stereo
  pair whose second channel points at nothing.
- **An external bed** (`AudioTrackSpec` `external`: music, a separate
  recorder) is laid on a track of its own at its level, in OTIO, Premiere,
  FCPXML, AviUtl and the preview. It used to be warned about and dropped.

### Captions

Captions are planning, not formatting, so no adapter works them out. `oea plan
--captions` stores them in the plan as `TextOperation`s of kind `caption`, and
`oea apply --editor srt` or `--editor vtt` works them out first when the plan has
none (the command has the transcript; an adapter must not read it). The plan file
is not changed by an apply.

[`buildCaptions`](../packages/agent/src/captions.ts) maps each utterance from
source time through the clip that plays it to timeline time:

- Only sound the cut plays: a cutaway's own sound and a file with no audio give
  none, and a clip whose picture already shows subtitles is left alone. Nor does
  a clip that plays another stream of its file than the one the transcript was
  made from: its captions would be words that are not heard.
- A caption never crosses a cut. Across a cut the words belong to another
  moment.
- A jump cut (`continues_previous`) is one sentence with a pause taken out; its
  pieces share the words between them and the removed pause is not waited for.
- Lines are at most 42 characters for text with spaces and 13 for Japanese and
  Chinese, at most two, balanced rather than filled, never starting with a
  closing mark or a small kana. A new caption starts after a sentence, at a
  pause of a second or more, and before one would need a third line or stay up
  longer than seven seconds.
- At least 833 ms on screen where the silence after the words allows it, never
  past the next caption or the end of the clip; a caption that still cannot be
  shown for 300 ms joins its neighbour. Two captions are never on screen at once.
- Without word timings (the local transcriber, the worked example) the split of
  an utterance is an estimate: a clip that plays at least half a sentence shows
  all of it, and one that plays less marks the missing side with `…`.

### Chapters

Plan markers (`EditPlan.markers`) are written as markers in every target that
has them. `youtube-chapters` applies YouTube's rules — the first at 00:00, at
least three, each at least ten seconds — and names every chapter it moved,
merged or left out; when fewer than three survive it writes nothing and says
why, since YouTube would show none.

### Timecode

SMPTE helpers live in contracts (`framesToSmpte`, `smpteToFrames`,
`supportsDropFrame`, `isNtscRate`). Drop-frame is used at 30000/1001 and
60000/1001 and nowhere else.

Source timecode starts at the file's own clock: `start_timecode` where the
ingest provides it, then the probe's `metadata.timecode` (ffprobe reports a
29.97 camera as `01:00:00;00`), else 00:00:00:00. The EDL's and the FCPXML's
artifact description says which. The record side starts at `record_start`
(`--option record_start=01:00:00:00`), read in the sequence's own counting.

### Settings

`oea apply --option key=value` (repeatable) passes settings to the adapter;
`--width` is the preview's width. Each adapter reads its own keys and ignores the
rest:

| adapter         | key             | meaning                                                              |
| --------------- | --------------- | -------------------------------------------------------------------- |
| `edl`, `fcpxml` | `record_start`  | timecode of the first frame of the cut (default `00:00:00:00`)       |
| `preview`       | `width`         | pixels wide (default 640; never larger than the sequence)            |
| `preview`       | `burn_captions` | `false` writes the captions beside the mp4 instead of on it          |
| `preview`       | `jobs`          | pieces rendered at once (default the smaller of 4 and the CPU count) |
| `preview`       | `keep_work`     | `true` keeps the rendered pieces for debugging                       |

## Each adapter, and its limits

**OpenTimelineIO** proves the architecture: a real interchange format with real
importers, so a plan written here opens in tools this project has never heard
of. Times are rational frame counts, so NTSC rates survive. Transitions are OTIO
`Transition`s — `SMPTE_Dissolve`, with the plan's type (a dip, a fade) in
metadata, because that is the only kind OTIO names. A fade at either end of a
track is a transition with nothing on its other side. Markers are written as
`Marker.1`, the version every release reads. Each video track's sound goes on
its own audio track.

**Premiere Pro** reads Final Cut Pro 7 XML. Frames at the sequence rate; a rate
is NTSC only when it is a whole rate slowed by 1000/1001, and a rate the format
cannot say is written as the nearest one it can with a warning. Each file is
declared once. Picture and sound link by `linkclipref` within their own track.
Text and captions are not written: import the `.srt` beside it.

**FCPXML 1.10** is Final Cut Pro's format and DaVinci Resolve's richest import;
it is not the FCP7 XML above (`buildFcpXml`, xmeml), and its builder is
`buildFcpxml`. Every time is a rational number of seconds on the sequence's frame
grid (`1001/30000s`); the spine is contiguous from zero with gaps where the plan
has nothing; upper tracks and beds are connected clips; transitions are cross
dissolves. Only standard rates: another is written as the nearest one with a
warning. The output validates against `FCPXMLv1_10.dtd`; children are written in
the DTD's order, because Final Cut refuses a whole file over one element out of
place. Captions carry an SRT role in their own language, which Final Cut shows
and Resolve ignores — give Resolve the `.srt`.

**CMX 3600 EDL**: one picture track with its sound as channels of the same events
(`V`, `B`, `AA/V`, `A`, `AA`). Reel names are made from file names within eight
characters, deterministic and never colliding, with the full name in a
`* FROM CLIP NAME:` comment and the path in `* SOURCE FILE:`. Dissolves are
`D nnn` with the outgoing clip's zero-length line before them; fades go through
the `BL` reel; chapters are `* LOC:` comments under the event they fall in. No
stills, no second track, no music bed, no speed changes, and a list of more than
999 events is warned about.

**AviUtl2** proves independence with an editor that shares nothing with
Premiere. The JSON job is the supported output (version 0.2.0 says what each clip
is made of, which stream and how many channels, carries beds and markers). The
`.exo` is best effort: pictures, stills (画像ファイル) and sound (音声ファイル,
grouped with its picture), but no text, transitions or markers, and it plays the
first audio stream of a file.

**SRT and WebVTT** write the plan's captions and nothing else: SubRip numbered
from 1 with comma milliseconds, WebVTT with its header, dot milliseconds and the
characters it reads as markup escaped. A plan with no captions writes nothing and
says how to get some.

**YouTube chapters** writes `MM:SS Title` (or `H:MM:SS` for an hour or more)
lines to paste into a description.

**Preview** renders the cut with ffmpeg to an mp4 anyone can play: 640 pixels
wide by default, the sequence's frame rate, AAC. Each piece is rendered on its
own with a seek straight to its in point, the chosen audio stream mapped, stills
read once and looped in the filter graph, sound-only clips over black, silence
where a clip has none, and the pieces are joined without re-encoding the
picture. Hard cuts: fades from and to black are rendered, a dissolve becomes a
cut and is listed. Where tracks overlap, the upper picture is shown and the
highest clip that has sound is heard. Captions are burned in when this ffmpeg has
the `subtitles` filter (libass) and written beside the mp4 as `.srt` when it does
not; chapters become mp4 chapters. A file ffmpeg cannot open is black and named;
if none can be opened — the worked example's footage is stand-ins — nothing is
rendered. The adapter's `available()` asks for ffmpeg, and `oea apply` asks
before it writes anything. `OEA_FFMPEG` and `OEA_FFPROBE` point at other
binaries.

## Measured

Every adapter was run on plans made from the probe footage — an edited
programme, pre-trimmed clips, sound-only files, photographs, a drone clip with
no audio, a variable-frame-rate phone clip and a camera with a lavalier on its
second stream, each analysed locally and with the Python worker — with and
without chapters and fades, with a music bed, and with each of the two streams;
and on the worked example and a 2:40 cut of six sample files at 12, 24, 30 and
59.94 fps. Every output was read back by a real importer:

| output         | read back with                       | result                                                                                                                                                     |
| -------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.otio`        | OpenTimelineIO 0.18                  | every file                                                                                                                                                 |
| `.xml`         | OpenTimelineIO's `fcp_xml` adapter   | every file                                                                                                                                                 |
| `.fcpxml`      | `xmllint --dtdvalid FCPXMLv1_10.dtd` | every file valid                                                                                                                                           |
| `.edl`         | OpenTimelineIO's `cmx_3600` adapter  | every file but those that fade in from black at the head: that reader refuses a transition there, including the form its own writer produces for a fade in |
| `.srt`, `.vtt` | ffprobe                              | every file                                                                                                                                                 |
| `.mp4`         | ffprobe, counting packets            | every preview exactly the plan's frame count (e.g. 4791 of 4791; 900 of 900)                                                                               |

OpenTimelineIO's `fcpx_xml` reader is not a check: it counts frames with an
integer rate (29 for 29.97) and cannot read a still in the spine.

Before and after, on the same plans: a sound-only file was a video clip
pointing at a sound file (7 of 7 clips in the sound-only case, in OTIO and
Premiere); photographs had 8 offline audio clips and a zero-length media range
under a 90-frame clip; a drone clip had 2 offline audio clips; the `.exo` was
silent in every case; a V2 clip's sound linked a V1 clip that did not exist.
All are gone. On the worked example the only spans that moved are three clips
that were a frame short of the next one (a frame of black at each of those
cuts); the total, 5385 frames, is unchanged.

The preview, on a 4-CPU machine:

| cut                              | pieces at once | render      |
| -------------------------------- | -------------- | ----------- |
| 2:40, 20 clips, six sample files | 1              | 22–24 s     |
|                                  | 2              | 19.6 s      |
|                                  | 4              | 12.2–12.5 s |
|                                  | 8              | 12.3 s      |
| probe cases (4–30 s, 1–8 clips)  | 4              | 2.2–7.0 s   |

Stills are read once and repeated in the filter graph: three seconds of a
4032x3024 JPEG took 7.8 s with `-loop 1` on the input and 0.37 s this way, and
the photographs case went from 11.1 s to 1.9 s. On the two-stream camera the
preview measured -57.1 dB (mean) playing stream 0, the room tone, and -20.5 dB
playing stream 1, the lavalier.

Captions on the worked example: 20, over the clips that carry their own sound.
Without word timings a clip that cuts a sentence short used to show the part of
it the estimate put inside the clip — four captions stopped short, two of them
mid-word ("来てよかっ"); a clip that plays at least half a sentence now shows
all of it.

## Writing an adapter

```ts
export interface EditorAdapter {
  readonly capabilities: AdapterCapabilities;
  apply(request: ApplyRequest): Promise<ApplyResult>;
  readTimeline?(request: ApplyRequest): Promise<EditPlan | undefined>;
  available?(): Promise<boolean>;
}
```

`apply` is the only required method. `available` is for an adapter that runs a
program or talks to an application; a file adapter that only writes text leaves
it out.

`readTimeline` is a hook for targets that can hand a timeline back, and **nothing
in this repository calls it yet**. It previously said the review loop used it to
see what a human changed; there is no such loop — `oea review` works from the
plan and the IR alone — no shipped adapter implements it, and all of them declare
`reads_back_timeline: false`. `Provenance.nle_observed` exists for values read
back out of an NLE and has never been produced.

### Declare what you can do

```ts
export const RESOLVE_CAPABILITIES = AdapterCapabilities.parse({
  id: 'resolve',
  name: 'DaVinci Resolve',
  mode: 'file', // or 'live'
  output_extensions: ['.drp'],
  basic_transition: true,
  transition_types: ['cross_dissolve', 'dip_to_black'],
  still_images: true,
  captions: false,
  markers: true,
  speed_change: true,
  max_video_tracks: 8,
  audio_tracks: 4,
  text: false,
  notes: ['Times are frames at the sequence rate.'],
});
```

Then let `negotiate()` adjust the plan before you write anything, with the
assets so the adjustments that depend on the media are made properly:

```ts
const { plan, downgrades } = negotiate(request.plan, this.capabilities, request.ir.assets);
```

It leaves out stills a target cannot hold, re-times a clip whose speed it cannot
change (the clip keeps its place on the timeline; the source range follows),
turns unsupported transitions into cuts, moves a clip to a track the target has
only where that track is free, and removes captions, titles, markers and beds a
target cannot carry — and returns the list. Report it. A dissolve that quietly
became a cut is a change to someone's edit, and they are entitled to see it.

### Lay the plan on the frame grid once

`layOnGrid(plan, rate)` places every clip on whole frames the same way for
every writer: a clip's two lengths agree, no clip overlaps the next on its
track, clips the plan butts together touch, and every frame a clip shows is the
source frame nearest to what the plan plays at that moment — so both of its
source edges are within a frame of the plan's. Rounding each edge separately
left a frame of black between clips on three of the worked example's 37 cuts,
three adapters rounding three ways disagreed by a frame here and there, and a
source in rounded apart from its clip's start read up to 1.3 frames past a
planned out point — on an edited programme, the first frame of the next shot.
`transitionsOf` then says which joins can really have a dissolve (handles
permitting) and where a fade sits. Use both.

### File or live

Prefer a file. The Premiere adapter writes an interchange file rather than
driving Premiere through a plugin: live needs Premiere running, a plugin
installed and versions of both to match; a file needs none of that, can be
produced on a machine with no Adobe software, and can be diffed, reviewed and
tested. A live transport belongs _beside_ a file adapter, not instead of it.

### Details that will bite

**Frame rates.** `frame_rate_num` and `frame_rate_den` are an exact rational.
29.97 is 30000/1001, and rounding it to 30 desynchronises an hour-long timeline
by nearly four seconds.

**Escaping.** File names and event descriptions are user content and routinely
contain ampersands and Japanese punctuation. One unescaped `&` makes an XML file
unopenable; `escapeXml` is in [`xml.ts`](../packages/adapters/src/xml.ts).

**Paths.** `resolveAssetPath()` turns an asset id into an absolute path and
`toFileUrl()` into the `file://` URL every interchange format wants, Windows and
UNC paths included.

**Metadata.** Put what you carry in your own namespace. The OTIO adapter uses
`metadata['editorial-ir']`, so no other tool mistakes it for its own.

### Registering it

Add it to `ADAPTERS` in
[`packages/adapters/src/registry.ts`](../packages/adapters/src/registry.ts).
`oea editors` picks it up, and so does `oea apply --editor <id>`.

### Testing it

Export a pure builder — `buildOtioTimeline`, `buildFcpXml`, `buildFcpxml`,
`buildEdl`, `buildAviUtlJob` — so the document can be checked without touching
the filesystem, and test `apply()` separately for the parts that are about
files. [`tests/support/plan.ts`](../tests/support/plan.ts) builds the plans the
worked example cannot: a still, a voice memo, a drone clip with no sound and a
camera with a lavalier on its second stream, in one cut. An adapter that runs a
program takes an injectable runner (the preview's `CommandRunner`), so its
decisions are tested with the program scripted and its output where the program
is installed.
