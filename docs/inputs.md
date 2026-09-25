# What it reads

`oea ingest <path>` takes a file or a folder. This page is what it accepts, what
it learns from each file before anything is analysed, and how it decides where
each file sits on the capture timeline — the one ordered axis that "the previous
event" and chapters are measured on. Every claim here was measured on ffmpeg 6.1
with files it synthesised; the probe itself is described in
[the perception protocol](perception-protocol.md).

## Files

| kind  | extensions                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| video | `.mp4` `.mov` `.m4v` `.mkv` `.avi` `.webm` `.mts` `.m2ts` `.ts` `.mxf` `.mpg` `.mpeg` `.3gp` `.3g2` `.ogv` |
| audio | `.wav` `.mp3` `.m4a` `.aac` `.flac` `.ogg` `.oga` `.opus` `.aif` `.aiff` `.caf`                            |
| still | `.jpg` `.jpeg` `.png` `.webp` `.heic` `.heif` `.avif` `.tif` `.tiff`                                       |

The extension only decides which files are looked at. What a file _is_ is decided
by its streams: an `.mp4` or `.mov` holding nothing but sound is audio, album art
in an MP3 is not a picture, and a video with no sound is a video with no sound.

Each of the containers below was written by ffmpeg and read back by both probes
(the TypeScript one and the Python worker's), which agreed on every field:

| container                             | what was in it             | notes                                     |
| ------------------------------------- | -------------------------- | ----------------------------------------- |
| MXF (OP1a)                            | MPEG-2 video, PCM          | start timecode on the container           |
| MPEG program stream (`.mpg`, `.mpeg`) | MPEG-2 video, MP2          |                                           |
| MPEG transport stream (`.ts`)         | H.264, AAC                 | 188-byte packets                          |
| AVCHD (`.mts`, `.m2ts`)               | H.264, AC-3                | 192-byte packets                          |
| 3GP, 3G2                              | H.263 / MPEG-4, AAC        |                                           |
| Ogg (`.ogv`, `.ogg`, `.oga`, `.opus`) | Theora, Vorbis, FLAC, Opus |                                           |
| AIFF (`.aif`, `.aiff`), CAF, FLAC     | PCM, FLAC                  |                                           |
| WebP, AVIF, PNG, TIFF, JPEG           | one picture                | a still: a size, no frame rate            |
| MOV, MP4, MKV, DV                     | H.264, DV                  | start timecode read from each (see below) |

Two did not go through, and ingest says so rather than failing obscurely:

- **HEIF/HEIC.** ffmpeg reads HEIF through its MP4 reader, and before HEIF
  support was added that reader looks for a movie: ffmpeg 6.1 reports
  `moov atom not found`, which reads as a corrupt file. A file whose first bytes
  say HEIF is reported as "a HEIF/HEIC photo, and the installed ffmpeg cannot
  read HEIF", with the remedy: FFmpeg 7.1 or newer, or export the photos as JPEG,
  which keeps their EXIF capture time.
- **`.ts` that is TypeScript.** The extension is shared. A transport stream is
  188-byte packets each starting `0x47` (192 bytes with an AVCHD clock in front),
  so two sync bytes in the right places decide it; a script is skipped, where it
  used to be listed under "could not read" with every other source file in the
  folder.

A file ffmpeg reads with the same content as one already registered — a
bit-for-bit copy under another name — is "already here", not a second asset.

## Folders

A folder is walked in name order, recursively.

- **Links are followed**, to files and to folders. A footage folder assembled
  from links to a card or an archive drive registered nothing, because a
  directory entry that is a link is not a file. A folder is walked once however
  many links lead to it, so a link back to a parent cannot loop, and a link that
  points nowhere is reported as unreadable rather than silently skipped.
- **Dot-files are skipped**: the project's own `.oea` directory, and macOS's `._`
  shadow files, which carry a media extension and no media.

## When it was recorded

A capture time is kept as precisely as the file stated it, and no more. Three
different things arrive in the field a container calls a date:

| precision | example                                                   | used to order    |
| --------- | --------------------------------------------------------- | ---------------- |
| `instant` | `2026-05-17T18:00:00+0900`, `2026-05-17T09:00:00.000000Z` | yes              |
| `local`   | `2026:05:17 18:00:00` (EXIF with no offset), an AVI       | on its own clock |
| `date`    | `2026` (an MP3's `date` tag), `2026-05-17`                | never            |

An **instant** becomes `MediaAsset.creation_time`. A **local** time — the wall
clock where it was shot, with no zone — is kept in `capture_time.local` and is
_not_ given an offset: read as UTC it was nine hours out for a camera set to
Tokyo time, and it was then sorted against phone clips that did carry their
zone. A **date** alone is not a capture time: `2026` read as midnight on New
Year's Day put a podcast before a year of footage. `capture_time` records which
of the three it was, where it came from and the value as written.

Where it comes from, first found first:

1. **A photo's own metadata.** ffprobe gives a JPEG no tags at all, so every
   photo used to have no date. It is read from the file in TypeScript, a few
   small reads near the start: EXIF `DateTimeOriginal` (then
   `DateTimeDigitized`), with `SubSecTimeOriginal` and `OffsetTimeOriginal` when
   the camera wrote them — from a JPEG's APP1, a PNG's `eXIf`, a WebP's `EXIF`, a
   TIFF, and the `Exif` item of a HEIF or AVIF; then XMP; then a PNG's
   `Creation Time`. EXIF's plain `DateTime` is never used: it is when the file
   was last written, and an edit moves it.
2. **`com.apple.quicktime.creationdate`**, which an iPhone or a Mac writes with
   its offset. A clip trimmed on the phone the next morning has `creation_time`
   rewritten to the moment of the trim; this one keeps the moment it was shot.
3. **The container's `creation_time`**, then its `date`.

A clock that was never set writes an epoch — 1904 is QuickTime's zero, 1970
Unix's — and a year before 1971 is not taken as a capture time.

Re-ingesting a file already in the project never changes its capture time or its
place, even when the probe now reads more; see `ingest.ts`.

## The order of the capture timeline

Assets are laid end to end, one second apart, in capture order where it is
known. Two rules decide the rest.

**One clock.** Instants are compared as instants. Wall-clock times are compared
with each other — and with the wall clock of a phone clip that wrote its offset
— but never with a UTC instant. The project is ordered on the clock that covers
more of it: the instant, unless more files have a wall clock (a camera's photos
beside a phone's clips), and never the wall clock when the files that wrote an
offset wrote more than one, because 18:00 in Tokyo and 11:30 in Paris are not in
the order their wall clocks say. `AssetPlacement.clock` records which.

**An undated file is placed beside its neighbour, not the whole project by
name.** It was all or nothing: one file without a time put every file in
file-name order, and a photo with no date turned B.MOV at 10:00:00 and A.MOV at
10:00:10 into A, B. Now the dated files keep their order and each undated one is
set right after the dated file its name sorts after — for a camera's own
numbering (IMG_0041.MOV, IMG_0042.JPG), the file shot just before it — or right
before the first dated file its name sorts before when none sorts ahead of it.
`AssetPlacement.ordered_by` is per asset (`creation_time` or `file_name`), and
`beside` names the neighbour. A project where every file is dated, or none is,
is laid out exactly as it was.

`oea ingest` says which rule placed what:

```text
the capture timeline
  length: 00:00:06
  ordered by: capture time for 2 of 3; file name places the rest
  asset_003 photo.jpg: no capture time in the file; placed after asset_002 B.MOV, the dated file its name sorts after
```

Chapters measure the real time between two recordings the same way: on a clock
both share, and not at all when they share none.

## Where the source timecode starts

`MediaAsset.start_timecode` is the timecode of the first frame, as SMPTE
`HH:MM:SS:FF` with `;` before the frames for drop-frame (`01:00:00;00`). A
professional camera starts its clips at the time of day or wherever the operator
set it, and an EDL or FCPXML that places a clip at `00:00:00:00` against a source
that starts at `01:00:00;00` relinks an hour away from the picture.

It is read from the picture stream's own tag, then a timecode track (`tmcd`,
which ffprobe lists as a data stream), then the container — measured: a MOV and
an MP4 carry it on the picture stream and the `tmcd` track, an MXF and a DV on
the container, an MKV on the container as `TIMECODE` in capitals. Tags are
matched whatever their case. A value that is not a time of day with a frame
count — a camera that writes its reel name there, an hour past 23 — is left out:
a wrong start is worse in an EDL than none. `oea ingest` mentions any start that
is not zero.

## Text on screen

On-screen text is read at one frame per shot, and more where one frame is not
enough:

- **At the end of every still stretch**, half a second before the picture
  changes. A screen recording is still between slides; the 60 s probe recording
  of six slides was one shot, read once at 20 s, and five slides were never read.
  Now each is read in the state it settled into — seven reads, all six slides.
  Text read there ends when the picture changes, rather than a second later on
  the next slide.
- **Every five seconds through a shot longer than ten**, where the picture moves:
  subtitles under a long take. Measured on a 40 s take with ten 4 s subtitle
  lines: one read found one line; seven found seven.
- **Every ten seconds through a long still stretch**, and no more often: the
  motion analysis ends a still stretch at any change of on-screen text (a
  replaced subtitle moved it by 3.2-4.7 against a threshold of 0.5), so the read
  at its end sees what the whole of it showed. A still, silent span was one read
  however long; it is now one per ten seconds.

A read costs about a second on the worker (RapidOCR on four CPU cores, measured
0.54-0.68 s on a 1080p slide of text and 0.21-0.39 s on a 720p subtitle frame,
plus 0.09-0.20 s to seek), is cached, and is capped at 120 beyond one per shot
per file. Repeats cost nothing downstream: the on-screen text stage collapses a
line read twice, and where slide text changes between two reads the event
boundary is put where the picture changed, not halfway between the reads.

## Sound from a separate recorder

A camera's microphone is a metre or more from the speaker; a lavalier or a
field recorder is at their collar. When a project holds both, the analysis lines
them up by what both heard and uses the recorder as the camera's sound. Nothing
about time changes: the picture, every event boundary and every source range are
where they were. The recorder is only read at the right place.

**How they are lined up.** Each recording's loudness is taken every 10 ms, turned
into an onset envelope (how much louder each hop is than the one before), and the
two envelopes are cross-correlated over every lag at which they could overlap.
A door, a laugh, the first word of a sentence arrive at both microphones within
milliseconds, whatever each device thought the time was — so the clocks are never
consulted. A peak counts only if it stands at least 1.5 times above the next best
peak half a second or more away: a correlation always has a maximum, and on
unrelated recordings it is a coincidence. Measured: true pairs 2.4-6.9 times,
unrelated pairs 1.04-1.13, offsets within 6 ms. The synthetic camera in
`tests/recorder-sync.test.ts`, started 3.2 s after its recorder, is found at
exactly -3200 ms (5.8 times the runner-up) and the unrelated recording beside it
is not paired.

**What is compared.** Every sound-only file with every video that has sound, and
two videos only when their capture times overlap (with a minute of slack). A
video with no audio track cannot be measured; pair it by hand (below). At most
400 pairs per project; what a larger project leaves out is reported, not dropped
silently. Each result is cached per pair of files, so a re-analysis costs nothing.

**What a pairing changes.** A recorder that covers at least half of a video
becomes that video's companion (`EditorialIR.audio_companions`):

- The video's events hear the recorder. Its utterances, moved into the video's
  time with their words, replace the camera's own over the stretch the recorder
  covers; the stored observations are not changed.
- A recorder that is mostly some video's sound gets no events of its own: what it
  heard is already in the videos' events. One that ran long after the camera
  stopped keeps its own events.
- The plan takes a clip's sound from the recorder (`VideoOperation.audio_source`)
  when the recorder holds the whole clip, and from the camera otherwise. A clip
  that changed microphone halfway through would sound like a fault.

`oea analyze` lists each pairing under "separate sound", with where the recorder
starts relative to the video.

**Correcting it.** `background.recorders` in context.yaml outranks the measurement,
and is applied on every compile, without a re-analysis:

```yaml
background:
  recorders:
    # A camera that recorded no sound: nothing to measure, so say where.
    # The recorder was started 3.2 seconds before the camera.
    - { recorder: ZOOM0001.WAV, video: C0001.MP4, offset_ms: -3200 }
    # "This one": keep the measured offset, set other recorders aside.
    - { recorder: LAV_A.WAV, video: C0002.MP4 }
    # Never together, whatever the measurement found.
    - { recorder: ROOM.WAV, video: C0003.MP4, paired: false }
```

**Two cameras of one moment.** Two videos are lined up directly when their
capture times overlap, or through a recorder both were lined up with. Where an
event on one and an event on the other share at least half of the shorter one's
time, they are linked `duplicate_of` ("the same moment on another camera"), so
the planner's duplicate penalty keeps one angle: two phones filming one toast
would otherwise put the toast in the cut twice. Cutting between the angles
within the moment — a multicam edit — is not attempted.

**Not done yet.** One offset per pair: two devices' clocks drift apart by tens of
milliseconds an hour, which a recording that long would hear as a slowly growing
echo against the camera's own sound, though not on its own.
