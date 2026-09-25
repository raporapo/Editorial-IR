import {
  hasAudioStream,
  isNtscRate,
  operationTimelineDuration,
  operationsInOrder,
  smpteToFrames,
  type EditPlan,
  type MediaAsset,
  type Transition,
  type VideoOperation,
} from '@editorial-ir/contracts';
import { msToFrames } from './types.js';

/**
 * What every adapter needs to agree on before it writes a single element: where
 * each clip sits on the frame grid, what a clip is made of, and which cuts carry
 * a transition the footage can actually supply.
 *
 * These lived inside the OTIO and Premiere builders as two copies of the same
 * rule, with AviUtl rounding a third way. Three roundings of one plan are three
 * edits that disagree by a frame here and there, and a frame is a sync fault. An
 * EDL, an FCPXML, a caption file and a rendered preview all have to land on the
 * same frames as the NLE files beside them, so the rule is written once.
 */

/** A rational frame rate, `num / den` frames per second. */
export interface FrameRate {
  num: number;
  den: number;
}

/**
 * The rate a format that counts in whole frames per second can say: a whole
 * timebase, slowed by 1000/1001 for the NTSC family, and nothing else. FCP7 XML
 * and CMX 3600 both work this way.
 *
 * The Premiere writer set its NTSC flag for any rate with a denominator, so the
 * 2500/101 average of a phone clip that dropped frames was written as NTSC 25 —
 * 24.975 fps, a rate no camera records — with every clip measured at a rate the
 * sequence did not play at. A rate the format cannot say is written as the
 * nearest one it can, every frame count is taken at that rate so the cut keeps
 * its length in seconds, and the result says so.
 */
export function countedRate(
  num: number,
  den: number,
  format: string,
  warnings: string[] = [],
): { timebase: number; ntsc: boolean; rate: FrameRate } {
  const timebase = Math.max(1, Math.round(num / den));
  const ntsc = isNtscRate(num, den);
  const rate = ntsc ? { num: timebase * 1000, den: 1001 } : { num: timebase, den: 1 };
  if (rate.num * den !== num * rate.den) {
    warnings.push(
      `the sequence rate ${num}/${den} is not one ${format} can express; it is written as ` +
        `${timebase} fps and every clip is measured at that rate`,
    );
  }
  return { timebase, ntsc, rate };
}

/** One operation laid on the frame grid. Every number is a whole frame. */
export interface GridSpan {
  operation: VideoOperation;
  /** First frame on the timeline. */
  start: number;
  /** Frames the clip occupies on the timeline; never less than one. */
  length: number;
  /** One past the last frame on the timeline. */
  end: number;
  /** First source frame, counted at the sequence rate. */
  in: number;
  /** One past the last source frame used; `out - in === length`. */
  out: number;
}

export interface FrameGrid {
  rate: FrameRate;
  /** Milliseconds to whole frames at this rate. A property, so it can be passed around. */
  frames: (ms: number) => number;
  /** Every video track that has an operation on it, by index, each in timeline order. */
  tracks: Map<number, GridSpan[]>;
  /** The span of one operation. */
  span: (operationId: string) => GridSpan;
  /** One past the last frame any operation occupies. */
  length: number;
}

/**
 * Lays every operation on the frame grid, once, for every writer.
 *
 * A sequence is frames, not milliseconds, and three things have to hold at once:
 * a clip's two lengths agree (`end - start` and `out - in`), no clip starts
 * before the one before it on its track ends, and the cut gains no gaps the plan
 * did not ask for. Rounding each edge independently from milliseconds satisfies
 * none of them reliably — it made the two lengths differ by a frame on 14 of the
 * 39 clips in the worked example, and fixing that alone pushed one clip's end a
 * frame past the next clip's start.
 *
 * So the start and the end are placed from the clip's absolute position, the
 * source in taken from what the plan plays at the frame the clip really starts
 * on, and the source out derived from the length. Where the next clip on the
 * same track starts sooner than this one would end, the length gives way: an
 * overlap is a thing a track cannot represent. Where the plan has the two
 * touching, they touch on the grid too.
 *
 * Tracks are laid independently. The Premiere writer used to look for "the next
 * clip" across every track at once, so a clip on V2 shortened whatever V1 clip
 * happened to precede it in the list.
 */
export function layOnGrid(
  plan: EditPlan,
  rate: FrameRate = { num: plan.sequence.frame_rate_num, den: plan.sequence.frame_rate_den },
): FrameGrid {
  const frames = (ms: number): number => msToFrames(ms, rate.num, rate.den);

  const tracks = new Map<number, GridSpan[]>();
  const byTrack = new Map<number, VideoOperation[]>();
  for (const operation of operationsInOrder(plan)) {
    const list = byTrack.get(operation.track) ?? [];
    list.push(operation);
    byTrack.set(operation.track, list);
  }

  const spans = new Map<string, GridSpan>();
  let length = 0;
  for (const [track, operations] of [...byTrack.entries()].sort((a, b) => a[0] - b[0])) {
    const laid: GridSpan[] = [];
    for (const [index, operation] of operations.entries()) {
      const start = frames(operation.timeline_start_ms);
      // The end placed from its absolute position like the start, rather than
      // the length rounded on its own: two roundings put the last clip of a
      // track, and any clip before a gap, up to a frame and a half from where
      // the plan ends it.
      const wanted = Math.max(
        1,
        frames(operation.timeline_start_ms + operationTimelineDuration(operation)) - start,
      );
      const next = operations[index + 1];
      const nextStart = next ? frames(next.timeline_start_ms) : undefined;
      // A clip the plan butts against the next one ends where the next begins.
      // Rounding its start and its length separately left a frame of black
      // between them on 3 of the worked example's 37 cuts (op_0008 → op_0009
      // ends on frame 748 and the next starts on 749), in every file written
      // from it — and a dissolve across that cut had nothing to join.
      const abuts =
        next !== undefined &&
        next.timeline_start_ms <=
          operation.timeline_start_ms + operationTimelineDuration(operation);
      const spanLength =
        nextStart !== undefined && nextStart > start
          ? abuts
            ? nextStart - start
            : Math.min(wanted, nextStart - start)
          : wanted;
      // The source frame at the clip's first timeline frame is the one the plan
      // plays at that instant, not the source in point rounded on its own. The
      // start was rounded to the grid, and the source has to move with it: the
      // two rounded apart made the source out overshoot by up to a frame and a
      // half, and a clip whose planned out point is one of the edit's own cuts
      // then showed the first frame of the next shot — the flash frame cut
      // snapping exists to prevent. Measured over 760 clips (the worked example
      // and the probe plans at 24000/1001, 25, 30, 30000/1001 and 60000/1001):
      // 16 clips off the plan by more than a frame at one end and 12 showing a
      // frame from wholly outside their planned range before; none of either
      // after, with every frame shown the one nearest to what the plan puts at
      // that moment.
      const sourceIn = sourceFrameAt(operation.source_in_ms, operation, start, rate);
      const span: GridSpan = {
        operation,
        start,
        length: spanLength,
        end: start + spanLength,
        in: sourceIn,
        out: sourceIn + spanLength,
      };
      laid.push(span);
      spans.set(operation.operation_id, span);
      length = Math.max(length, span.end);
    }
    tracks.set(track, laid);
  }

  return {
    rate,
    frames,
    tracks,
    span(operationId: string): GridSpan {
      const span = spans.get(operationId);
      if (!span) throw new Error(`${operationId} is not on the grid`);
      return span;
    },
    length,
  };
}

/**
 * The frame of a file a clip plays at its first frame on the grid, when the
 * plan reads that file from `sourceInMs` at the clip's planned start.
 *
 * The clip's start was rounded to the grid, so whatever it reads moves with it:
 * by the rounding, times the speed. The picture's source in is placed this way,
 * and so is a separate recorder's (`clipAudio`), because two files placed by
 * two roundings are out of sync by up to a frame before anyone has touched them.
 */
function sourceFrameAt(
  sourceInMs: number,
  operation: VideoOperation,
  start: number,
  rate: FrameRate,
): number {
  const lead = start - (operation.timeline_start_ms / 1000) * (rate.num / rate.den);
  return Math.max(
    0,
    Math.round((sourceInMs / 1000) * (rate.num / rate.den) + lead * operation.speed),
  );
}

/* -------------------------------------------------------------------------- */
/* What a clip is made of                                                      */
/* -------------------------------------------------------------------------- */

/** What a clip shows: moving picture, a held still, or nothing (sound only). */
export type Picture = 'video' | 'still' | 'none';

/**
 * The picture an asset gives a clip.
 *
 * Every adapter wrote every operation as a moving-picture clip, whatever the
 * file was: an m4a became a video clip on V1 pointing at a sound file, and a
 * photograph a video clip with a source range sixty frames into a file zero
 * frames long.
 */
export function pictureOf(asset: MediaAsset): Picture {
  if (asset.kind === 'image') return 'still';
  if (asset.kind === 'audio') return 'none';
  return 'video';
}

/** The sound one clip carries: which stream of its file, and how many channels. */
export interface ClipSound {
  /** Audio-relative stream index, `-map 0:a:<index>`. */
  stream: number;
  /** Channels in that stream. */
  channels: number;
  /**
   * Channels in the streams before it, so that "channel 1 of stream 1" can be
   * addressed in a format that numbers a file's channels in one run.
   */
  channelOffset: number;
  /** Audio streams in the file. */
  streams: number;
}

/**
 * The sound a clip carries into the cut, or nothing.
 *
 * Nothing when the plan does not want it, and nothing when there is none to
 * want: a drone clip with no audio stream was written with two audio clipitems
 * per clip, which import as offline media — thirty of them on a fifteen-clip
 * cut, each a red bar under a picture that was fine.
 *
 * The stream is the one the plan chose (`audio_stream_index`), because the
 * analysis chose it for having the speech in it; linking stream 0 of a camera
 * with a lavalier on its second track put the room tone under a cut the
 * transcript was used to make.
 */
export function soundOf(
  asset: MediaAsset,
  operation: VideoOperation,
  warnings?: string[],
): ClipSound | undefined {
  if (!operation.use_source_audio) return undefined;
  if (!hasAudioStream(asset)) return undefined;
  return streamOf(asset, operation.audio_stream_index, operation.operation_id, warnings);
}

/** The sound one clip plays: which file, which of its streams, and where in it. */
export interface ClipAudio {
  /**
   * The file the sound is read from: the clip's own, or the separate recorder
   * that heard the same moment (`audio_source`).
   */
  asset: MediaAsset;
  sound: ClipSound;
  /** First frame of the sound in `asset`, counted at the grid's rate. */
  in: number;
  /** One past the last frame; `out - in` is the clip's length, as it is for the picture. */
  out: number;
  /**
   * Where the sound starts in `asset`, in that file's own milliseconds, as the
   * plan says: for a target that can place sound finer than a frame.
   */
  sourceInMs: number;
  /** True when the sound is a separate recorder's rather than the clip's own file's. */
  separate: boolean;
}

/**
 * The sound a clip plays, wherever it comes from, or nothing.
 *
 * A clip's sound was always its own file's, and every writer read it from
 * there. A plan can now say otherwise: `audio_source` names a lavalier or a field
 * recorder the analysis lined up with the camera, and it is the sound the
 * transcript that chose the clip was made from. A writer that kept reading the
 * camera exported the room a metre from the speaker — or, with the camera's
 * microphone off, nothing at all — under a cut that was made by listening to
 * the collar.
 *
 * One answer for every writer, as the grid is: the file, the stream, and the
 * frame of the recorder the clip starts on, placed from the recorder's own time
 * exactly as the picture's source in is placed from the camera's, so the two
 * move together with the clip's rounding. The sound runs for the clip's length.
 * The recorder's stream is its own `audio_stream_index`; the operation's names a
 * stream of the camera.
 *
 * A recorder that is not among the media, or that has no sound, falls back to
 * the clip's own sound, and says so: silence where the plan asked for speech is
 * a worse export than the camera's microphone. Without `audio_source` this is
 * `soundOf` over the picture's own range, unchanged.
 */
export function clipAudio(
  span: GridSpan,
  lookup: (assetId: string) => MediaAsset | undefined,
  rate: FrameRate,
  warnings?: string[],
): ClipAudio | undefined {
  const operation = span.operation;
  if (!operation.use_source_audio) return undefined;

  const own = (): ClipAudio | undefined => {
    const asset = lookup(operation.source_asset_id);
    const sound = asset ? soundOf(asset, operation, warnings) : undefined;
    if (!asset || !sound) return undefined;
    return {
      asset,
      sound,
      in: span.in,
      out: span.out,
      sourceInMs: operation.source_in_ms,
      separate: false,
    };
  };

  const source = operation.audio_source;
  if (!source) return own();

  const recorder = lookup(source.asset_id);
  const sound = recorder
    ? streamOf(recorder, source.audio_stream_index, operation.operation_id, warnings)
    : undefined;
  if (recorder && sound) {
    const at = sourceFrameAt(source.source_in_ms, operation, span.start, rate);
    return {
      asset: recorder,
      sound,
      in: at,
      out: at + span.length,
      sourceInMs: source.source_in_ms,
      separate: true,
    };
  }
  const fallback = own();
  warnings?.push(
    `${operation.operation_id} takes its sound from ${recorder?.file_name ?? source.asset_id}, ` +
      `which ${recorder ? 'has no audio stream' : 'is not available'}; ` +
      (fallback ? 'the clip’s own sound is used instead' : 'the clip is silent'),
  );
  return fallback;
}

/**
 * The separate recorders a plan's clips take their sound from, in the order the
 * clips come, each once.
 *
 * A recorder is media no operation's `source_asset_id` names, so every list a
 * writer made of "the files this cut uses" left it out: an EDL gave it no reel,
 * and a preview never checked that ffmpeg could read it.
 */
export function recordersOf(plan: EditPlan): string[] {
  const ids: string[] = [];
  for (const operation of operationsInOrder(plan)) {
    const id = operation.use_source_audio ? operation.audio_source?.asset_id : undefined;
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Every sound an asset could give, for a bed or a file definition. */
export function streamOf(
  asset: MediaAsset,
  wanted: number | undefined,
  owner: string,
  warnings?: string[],
): ClipSound | undefined {
  if (!hasAudioStream(asset)) return undefined;
  const streams = [...(asset.audio_streams ?? [])].sort((a, b) => a.index - b.index);
  if (streams.length === 0) {
    // Registered before streams were listed: the first-stream fields are all
    // there is. Two channels when even those are missing, which is what every
    // adapter assumed before it asked.
    return {
      stream: 0,
      channels: positive(asset.audio_channels) ?? 2,
      channelOffset: 0,
      streams: 1,
    };
  }
  const index = wanted ?? 0;
  let stream = streams.find((candidate) => candidate.index === index);
  if (!stream) {
    warnings?.push(
      `${owner} asks for audio stream ${index} of ${asset.file_name}, which has ` +
        `${streams.length}; the first is used`,
    );
    stream = streams[0]!;
  }
  const channelsOf = (s: (typeof streams)[number]): number => streamChannels(asset, s);
  let channelOffset = 0;
  for (const earlier of streams) {
    if (earlier.index >= stream.index) break;
    channelOffset += channelsOf(earlier);
  }
  return {
    stream: stream.index,
    channels: channelsOf(stream),
    channelOffset,
    streams: streams.length,
  };
}

/**
 * How many channels one audio stream of a file has, by the one rule every
 * writer uses.
 *
 * The stream's own count; for the first stream, the probe's first-stream field
 * when the stream carries none; two otherwise, which is what every adapter
 * assumed before it asked. A file definition that counted a stream one way and
 * a clip that counted it another addressed the wrong channel: Premiere declared
 * a stream with no count as two channels while the clip reading the stream
 * after it counted the first as the probe's one, and so linked the first
 * stream's second channel instead of the lavalier.
 */
export function streamChannels(
  asset: Pick<MediaAsset, 'audio_channels'>,
  stream: { index: number; channels?: number | undefined },
): number {
  return (
    positive(stream.channels) ?? (stream.index === 0 ? (positive(asset.audio_channels) ?? 2) : 2)
  );
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* Source timecode                                                             */
/* -------------------------------------------------------------------------- */

/** Where a source's own clock starts, and where that was read from. */
export interface SourceTimecode {
  /** The timecode as found, or `00:00:00:00`. */
  timecode: string;
  origin: 'start_timecode' | 'metadata.timecode' | 'none';
  /** The rate it counts at: the asset's own, or the sequence's when it has none. */
  rate: FrameRate;
  /** Frames at `rate` from midnight. */
  frames: number;
}

/**
 * The timecode a source file's first frame carries.
 *
 * An EDL or an FCPXML addresses media by its own clock. A camera or a broadcast
 * master routinely starts at 01:00:00:00 (measured: a MOV with a tmcd track,
 * which ffprobe reports as `01:00:00;00` on the video stream), and an edit list
 * that counts from zero asks the conform for frames an hour before the file
 * begins. Zero is right only for a file with no clock, and the artifact says
 * which it used.
 *
 * `start_timecode` is read before the free-form probe tag because a typed field,
 * where the ingest provides one, has been checked; the tag is whatever the
 * container said.
 */
export function sourceTimecodeOf(asset: MediaAsset, fallback: FrameRate): SourceTimecode {
  const rate: FrameRate =
    asset.fps_num !== undefined && asset.fps_num > 0 && asset.fps_den !== undefined
      ? { num: asset.fps_num, den: asset.fps_den }
      : fallback;

  const candidates: [SourceTimecode['origin'], unknown][] = [
    ['start_timecode', (asset as unknown as Record<string, unknown>).start_timecode],
    ['metadata.timecode', asset.metadata.timecode],
  ];
  for (const [origin, value] of candidates) {
    if (typeof value !== 'string') continue;
    const frames = smpteToFrames(value, rate.num, rate.den);
    if (frames === undefined) continue;
    return { timecode: value.trim(), origin, rate, frames };
  }
  return { timecode: '00:00:00:00', origin: 'none', rate, frames: 0 };
}

/** A sentence for an artifact's description: which clocks the source times count from. */
export function describeTimecodeOrigins(timecodes: Iterable<SourceTimecode>): string {
  const all = [...timecodes];
  const embedded = all.filter((t) => t.origin !== 'none').length;
  if (all.length === 0 || embedded === 0) {
    return 'Source timecodes count from 00:00:00:00: no source carried its own start timecode.';
  }
  if (embedded === all.length) {
    return 'Source timecodes start at each file’s embedded start timecode.';
  }
  return (
    `Source timecodes start at the embedded start timecode for ${embedded} of ${all.length} ` +
    'files, and at 00:00:00:00 for the rest, which carried none.'
  );
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                 */
/* -------------------------------------------------------------------------- */

/** A transition as it will be written: at a join between two pictures, or at an edge. */
export interface PlacedTransition {
  kind: 'between' | 'head' | 'tail';
  transition: Transition;
  /** The clip before the join, or the clip fading out. */
  outgoing?: GridSpan;
  /** The clip after the join, or the clip fading in. */
  incoming?: GridSpan;
  /**
   * Frames on each side of the cut for a join (the dissolve is twice this);
   * frames of the whole fade at an edge.
   */
  frames: number;
}

/**
 * The transitions one track of pictures really has, with the frames each can
 * have.
 *
 * A dissolve is made of frames neither clip is using: from past the outgoing
 * clip's out point and from before the incoming clip's in point. Writing one the
 * media cannot supply is how an interchange file imports with clips in the wrong
 * places, so a join gets what the handles allow, and one with no handles stays a
 * cut and says so. A still has handles without end — a photograph is the same
 * at every instant — which is why a dissolve into a photograph always works.
 *
 * A fade at the head of a track, or out of its last clip, has nothing on the
 * other side to borrow from and needs no handles: it is the clip's own frames
 * going to or from black. Both ends were dropped before — a `fade_out` on the
 * last clip, which is how most films end, reached no file but AviUtl's.
 *
 * Clips are joined only when they touch: a clip after a gap starts from black.
 * A jump cut (`continues_previous`) is always a cut, whatever it asks for.
 */
export function transitionsOf(
  spans: readonly GridSpan[],
  frames: (ms: number) => number,
  mediaFrames: (span: GridSpan) => number | 'unbounded',
  warnings: string[],
): PlacedTransition[] {
  const placed: PlacedTransition[] = [];
  const wanted = (t: Transition | undefined): Transition | undefined =>
    t && t.type !== 'hard_cut' && t.duration_ms > 0 ? t : undefined;

  /** The dissolve at a join, or nothing: no transition asked for, a jump cut, no handles. */
  const join = (previous: GridSpan, span: GridSpan): PlacedTransition | undefined => {
    const transition =
      wanted(span.operation.transition_in) ?? wanted(previous.operation.transition_out);
    if (!transition) return undefined;
    if (span.operation.continues_previous) {
      warnings.push(
        `${span.operation.operation_id} continues ${previous.operation.operation_id}'s take, and a ` +
          `jump cut is always a cut; its ${transition.type} was not written`,
      );
      return undefined;
    }
    const after = mediaFrames(previous);
    const handleAfter = after === 'unbounded' ? Infinity : Math.max(0, after - previous.out);
    const handleBefore = mediaFrames(span) === 'unbounded' ? Infinity : Math.max(0, span.in);
    // Centred, so each side gives half; the shorter handle decides, and a
    // dissolve may not reach past the far end of either clip.
    const half = Math.min(
      Math.floor(frames(transition.duration_ms) / 2),
      handleAfter,
      handleBefore,
      previous.length,
      span.length,
    );
    if (half < 1) {
      warnings.push(
        `${span.operation.operation_id} asked for a ${transition.type}, and there is not enough footage ` +
          'either side of the cut to make one; it stays a hard cut',
      );
      return undefined;
    }
    return { kind: 'between', transition, outgoing: previous, incoming: span, frames: half };
  };

  for (const [index, span] of spans.entries()) {
    const previous = spans[index - 1];
    const next = spans[index + 1];

    if (previous !== undefined && previous.end === span.start) {
      const between = join(previous, span);
      if (between) placed.push(between);
    } else {
      const fadeIn = wanted(span.operation.transition_in);
      if (fadeIn) {
        placed.push({
          kind: 'head',
          transition: fadeIn,
          incoming: span,
          frames: Math.max(1, Math.min(frames(fadeIn.duration_ms), span.length)),
        });
      }
    }

    const endsTrack = next === undefined || next.start > span.end;
    const fadeOut = wanted(span.operation.transition_out);
    if (endsTrack && fadeOut) {
      placed.push({
        kind: 'tail',
        transition: fadeOut,
        outgoing: span,
        frames: Math.max(1, Math.min(frames(fadeOut.duration_ms), span.length)),
      });
    }
  }
  return placed;
}

/** How many frames of media an asset has at the grid's rate; stills are unbounded. */
export function mediaFramesOf(
  assets: readonly MediaAsset[],
  frames: (ms: number) => number,
): (span: GridSpan) => number | 'unbounded' {
  return (span) => {
    const asset = assets.find((a) => a.id === span.operation.source_asset_id);
    if (!asset) return 0;
    if (asset.kind === 'image') return 'unbounded';
    return frames(asset.duration_ms);
  };
}

/** Looks an asset up by id. */
export function assetById(assets: readonly MediaAsset[], id: string): MediaAsset | undefined {
  return assets.find((asset) => asset.id === id);
}

/* -------------------------------------------------------------------------- */
/* How far into each file the cut reads                                        */
/* -------------------------------------------------------------------------- */

/**
 * One past the last frame the cut reads from each file, counted at the grid's
 * rate: a picture's own file, the file its sound is read from, and a bed's.
 * Stills are not counted; they have no length to read past.
 *
 * The grid places whole frames, and a file is not a whole number of them. A
 * clip the plan plays to the very end of a sound file therefore reads a
 * fraction of a frame the file does not have: measured on a 2232 ms mp3 played
 * 0–2232 ms at 30 fps, the clip is 67 frames (2233.3 ms) and the file 66.96. A
 * clip that starts a fraction of a frame into its file and rounds up at both
 * ends can overshoot by a whole frame (a 2215 ms file read from 23 ms: frames 1
 * to 67 of a file that rounds to 66).
 *
 * A writer that declares a file's length says it with this as the floor
 * (`mediaLengthOf`). The alternative, trimming the clip to the whole frames the
 * file has, leaves a frame of silence or black in this writer's timeline that
 * the others beside it do not have, and moves the cut off the grid every writer
 * shares. Declaring the file a fraction of a frame longer asks the importer for
 * nothing it cannot give: the last frame is the file's last, part sound and
 * part the silence after it.
 */
export function furthestReads(
  plan: EditPlan,
  grid: FrameGrid,
  assets: readonly MediaAsset[],
): Map<string, number> {
  const reach = new Map<string, number>();
  const note = (id: string, frame: number): void => {
    reach.set(id, Math.max(reach.get(id) ?? 0, frame));
  };
  const lookup = (id: string): MediaAsset | undefined => assetById(assets, id);
  for (const spans of grid.tracks.values()) {
    for (const span of spans) {
      const asset = lookup(span.operation.source_asset_id);
      if (asset && pictureOf(asset) === 'video') note(asset.id, span.out);
      // No warnings: the writer asks for the same sound again and says it then.
      const audio = clipAudio(span, lookup, grid.rate);
      if (audio) note(audio.asset.id, audio.out);
    }
  }
  for (const spec of plan.tracks.audio) {
    if (spec.type !== 'external') continue;
    const asset = lookup(spec.asset_id);
    const bed = asset ? bedSpan(spec, asset, grid.length, grid.frames) : undefined;
    if (asset && bed) note(asset.id, bed.in + bed.length);
  }
  return reach;
}

/**
 * A file's length in frames at the grid's rate, and never less than the cut
 * reads of it (`furthestReads`).
 */
export function mediaLengthOf(
  asset: MediaAsset,
  frames: (ms: number) => number,
  reach: ReadonlyMap<string, number>,
): number {
  return Math.max(frames(asset.duration_ms), reach.get(asset.id) ?? 0);
}

/** Where an external bed sits, in frames: from its start to its end or the cut's. */
export function bedSpan(
  spec: { timeline_start_ms: number; source_in_ms: number; duration_ms?: number | undefined },
  asset: MediaAsset,
  sequenceFrames: number,
  frames: (ms: number) => number,
): { start: number; length: number; in: number } | undefined {
  const start = frames(spec.timeline_start_ms);
  const available = Math.max(0, asset.duration_ms - spec.source_in_ms);
  const wanted = frames(spec.duration_ms ?? available);
  const length = Math.min(wanted, frames(available), sequenceFrames - start);
  if (length < 1) return undefined;
  return { start, length, in: frames(spec.source_in_ms) };
}
