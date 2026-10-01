import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterCapabilities,
  smpteToFrames,
  supportsDropFrame,
  type ApplyResult,
  type CapabilityDowngrade,
  type EditPlan,
  type MediaAsset,
  type TextOperation,
} from '@editorial-ir/contracts';
import type { ApplyRequest, EditorAdapter } from './types.js';
import { negotiate, resolveAssetPath, stringOption, toFileUrl } from './types.js';
import {
  assetById,
  bedSpan,
  clipAudio,
  describeTimecodeOrigins,
  furthestReads,
  layOnGrid,
  mediaFramesOf,
  pictureOf,
  soundTransitionsOf,
  sourceTimecodeOf,
  streamChannels,
  streamOf,
  transitionsOf,
  type ClipAudio,
  type ClipSound,
  type FrameRate,
  type GridSpan,
  type PlacedTransition,
  type SourceTimecode,
  type TrackClip,
} from './timeline.js';
import { escapeXml } from './xml.js';

/**
 * FCPXML 1.10: Final Cut Pro, and DaVinci Resolve's richest import.
 *
 * Not the FCP7 XML the Premiere adapter writes (`buildFcpXml`, xmeml): a
 * different format with the same family name, in which every time is a
 * rational number of seconds (`1001/30000s`), media is declared once as a
 * resource and a sequence is a *spine* of clips with everything else anchored
 * to them.
 *
 * Final Cut validates an import against its DTD and refuses the whole file on
 * one misplaced element, so this writes the smallest vocabulary that carries
 * the plan — asset-clips, stills as `video` on image assets, gaps, cross
 * dissolves and fades, connected clips for upper tracks and beds, chapter
 * markers and captions — and the tests assert the invariants the importers
 * enforce: every time on the sequence's frame grid, every reference resolved,
 * the spine contiguous from zero.
 */
export const FCPXML_CAPABILITIES: AdapterCapabilities = AdapterCapabilities.parse({
  id: 'fcpxml',
  name: 'Final Cut Pro XML (FCPXML 1.10)',
  mode: 'file',
  output_extensions: ['.fcpxml'],
  text: false,
  captions: true,
  markers: true,
  basic_transition: true,
  transition_types: ['cross_dissolve', 'fade_in', 'fade_out'],
  keyframes: false,
  masking: false,
  nested_sequence: false,
  speed_change: false,
  still_images: true,
  color_adjustment: false,
  audio_tracks: 2,
  max_video_tracks: 4,
  reads_back_timeline: false,
  renders_preview: false,
  notes: [
    'FCPXML 1.10 for Final Cut Pro and DaVinci Resolve: rational times on the sequence’s frame grid, media declared once.',
    'Stills are video elements on image assets; sound-only files are audio clips in the storyline; upper tracks and music beds are connected clips.',
    'A dissolve between two sound-only clips is a storyline transition, whose Audio Crossfade is all it does, where the handles allow it.',
    'A clip whose sound is a separate recorder’s keeps its picture only, with the recorder as a connected audio clip below it.',
    'Chapters are chapter markers; captions are SRT-role captions, which Final Cut shows and Resolve ignores — use --editor srt for Resolve.',
    'Only standard frame rates: another rate is written as the nearest standard one, and the result says so.',
    'Options: record_start (the sequence’s starting timecode, e.g. 01:00:00:00; default 00:00:00:00).',
  ],
});

export class FcpxmlAdapter implements EditorAdapter {
  readonly capabilities = FCPXML_CAPABILITIES;

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    const { plan, downgrades } = negotiate(request.plan, this.capabilities, request.ir.assets);
    const warnings: string[] = [];
    const { xml, timecodes } = buildFcpxmlDocument(plan, request, warnings, downgrades);

    const name = request.name ?? 'timeline';
    mkdirSync(request.outputDir, { recursive: true });
    const path = join(request.outputDir, `${name}.fcpxml`);
    writeFileSync(path, xml);
    return {
      adapter: this.capabilities.id,
      artifacts: [
        {
          path,
          kind: 'interchange',
          description:
            'Import into Final Cut Pro (File > Import > XML) or DaVinci Resolve (File > Import > Timeline). ' +
            describeTimecodeOrigins(timecodes),
          byte_size: statSync(path).size,
        },
      ],
      downgrades,
      warnings,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Rational time                                                               */
/* -------------------------------------------------------------------------- */

/** Seconds as `n / d`, kept exact: FCPXML refuses a time that is off the frame grid. */
interface Rational {
  n: number;
  d: number;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function rational(n: number, d: number): Rational {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

function add(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

/** `3600s`, `1001/30000s`: the only two forms FCPXML writes. */
export function formatTime(value: Rational): string {
  const r = rational(value.n, value.d);
  return r.d === 1 ? `${r.n}s` : `${r.n}/${r.d}s`;
}

/* -------------------------------------------------------------------------- */
/* Rates and formats                                                           */
/* -------------------------------------------------------------------------- */

/** The frame rates Final Cut Pro can edit in, with the code its format names use. */
const STANDARD_RATES: { rate: FrameRate; code: string }[] = [
  { rate: { num: 24000, den: 1001 }, code: '2398' },
  { rate: { num: 24, den: 1 }, code: '24' },
  { rate: { num: 25, den: 1 }, code: '25' },
  { rate: { num: 30000, den: 1001 }, code: '2997' },
  { rate: { num: 30, den: 1 }, code: '30' },
  { rate: { num: 50, den: 1 }, code: '50' },
  { rate: { num: 60000, den: 1001 }, code: '5994' },
  { rate: { num: 60, den: 1 }, code: '60' },
];

/**
 * The sequence rate, as one Final Cut accepts.
 *
 * A project format is one of a fixed list, and a sequence at anything else —
 * the 2500/101 average a VFR phone clip reports, a 15 fps screen recording — is
 * refused on import. The nearest standard rate is used, every frame is counted
 * at it so the cut keeps its length in seconds, and the result says so.
 */
export function fcpxmlRate(
  num: number,
  den: number,
  warnings: string[] = [],
): FrameRate & { code: string } {
  const exact = STANDARD_RATES.find((s) => s.rate.num * den === num * s.rate.den);
  if (exact) return { ...exact.rate, code: exact.code };
  const fps = num / den;
  const nearest = [...STANDARD_RATES].sort(
    (a, b) =>
      Math.abs(a.rate.num / a.rate.den - fps) - Math.abs(b.rate.num / b.rate.den - fps) ||
      a.rate.num / a.rate.den - b.rate.num / b.rate.den,
  )[0]!;
  warnings.push(
    `FCPXML sequences run at standard rates only; ${num}/${den} is written as ` +
      `${nearest.rate.num}/${nearest.rate.den} and every clip is measured at that rate`,
  );
  return { ...nearest.rate, code: nearest.code };
}

/** Final Cut's own name for a format, where it has one; custom sizes have none. */
function formatName(width: number, height: number, code: string): string | undefined {
  const size =
    width === 1280 && height === 720
      ? '720p'
      : width === 1920 && height === 1080
        ? '1080p'
        : (width === 3840 || width === 4096) && height === 2160
          ? `${width}x${height}p`
          : undefined;
  return size ? `FFVideoFormat${size}${code}` : undefined;
}

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

/**
 * An element before it is written. Attributes are escaped when it is, in one
 * place, so no value — a file name, a chapter title, a caption — can reach the
 * file unescaped.
 */
interface Element {
  tag: string;
  attributes: [string, string][];
  children: Element[];
  text?: string;
}

function element(
  tag: string,
  attributes: Record<string, string | number | undefined>,
  children: Element[] = [],
  text?: string,
): Element {
  return {
    tag,
    attributes: Object.entries(attributes)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
    children,
    ...(text === undefined ? {} : { text }),
  };
}

function serialise(node: Element, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const attributes = node.attributes
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
  if (node.children.length === 0 && node.text === undefined)
    return [`${pad}<${node.tag}${attributes}/>`];
  if (node.children.length === 0) {
    return [`${pad}<${node.tag}${attributes}>${escapeXml(node.text!)}</${node.tag}>`];
  }
  return [
    `${pad}<${node.tag}${attributes}>`,
    ...node.children.flatMap((child) => serialise(child, depth + 1)),
    `${pad}</${node.tag}>`,
  ];
}

/** A storyline item, with what will be written inside it. */
interface SpineItem {
  node: Element;
  /** Position on the sequence, in frames. */
  offset: number;
  length: number;
  /** Its own local time at its first frame. */
  start: Rational;
  /** Adjustments: first, as the DTD orders them. */
  intrinsic: Element[];
  /** Connected clips and captions. */
  anchored: Element[];
  /** Markers, after everything anchored. */
  markers: Element[];
  /**
   * Which audio streams sound, after the markers. The DTD puts
   * `audio-channel-source` last in an asset-clip, behind anchored items and
   * markers, and Final Cut refuses a whole file for one element out of order —
   * which a clip with two streams, a caption and a chapter would otherwise be.
   */
  channels: Element[];
}

function finish(item: SpineItem): Element {
  return {
    ...item.node,
    children: [...item.intrinsic, ...item.anchored, ...item.markers, ...item.channels],
  };
}

/** Exported so the XML can be checked without touching the filesystem. */
export function buildFcpxml(
  plan: EditPlan,
  request: ApplyRequest,
  warnings: string[] = [],
  downgrades: CapabilityDowngrade[] = [],
): string {
  return buildFcpxmlDocument(plan, request, warnings, downgrades).xml;
}

/**
 * The document and the clocks its source times were counted from. `downgrades`
 * receives the transitions between sound-only clips that stay cuts.
 */
export function buildFcpxmlDocument(
  plan: EditPlan,
  request: ApplyRequest,
  warnings: string[] = [],
  downgrades: CapabilityDowngrade[] = [],
): { xml: string; timecodes: SourceTimecode[] } {
  const rate = fcpxmlRate(plan.sequence.frame_rate_num, plan.sequence.frame_rate_den, warnings);
  const grid = layOnGrid(plan, rate);
  const assets = request.ir.assets;
  const reach = furthestReads(plan, grid, assets);
  const at = (frames: number): Rational => rational(frames * rate.den, rate.num);
  const time = (frames: number): string => formatTime(at(frames));
  const dropFrame = supportsDropFrame(rate.num, rate.den);
  const tcFormat = dropFrame ? 'DF' : 'NDF';

  const recordStartText = stringOption(request, 'record_start', '00:00:00:00');
  const recordStartFrames = smpteToFrames(recordStartText, rate.num, rate.den, dropFrame);
  if (recordStartFrames === undefined) {
    warnings.push(`record_start "${recordStartText}" is not a timecode; the sequence starts at 0`);
  }

  // ---- resources -------------------------------------------------------------
  let nextId = 1;
  const resources: Element[] = [];
  const formatIds = new Map<string, string>();
  const formatFor = (width: number, height: number, frameRate?: FrameRate): string => {
    const key = `${width}x${height}@${frameRate ? `${frameRate.num}/${frameRate.den}` : 'still'}`;
    const existing = formatIds.get(key);
    if (existing) return existing;
    const id = `r${nextId++}`;
    formatIds.set(key, id);
    const code = frameRate
      ? STANDARD_RATES.find((s) => s.rate.num * frameRate.den === frameRate.num * s.rate.den)?.code
      : undefined;
    resources.push(
      element('format', {
        id,
        name: frameRate
          ? code
            ? formatName(width, height, code)
            : undefined
          : 'FFVideoFormatRateUndefined',
        frameDuration: frameRate ? formatTime(rational(frameRate.den, frameRate.num)) : undefined,
        width,
        height,
      }),
    );
    return id;
  };
  const sequenceFormat = formatFor(plan.sequence.width, plan.sequence.height, rate);

  const assetIds = new Map<string, string>();
  const clocks = new Map<string, SourceTimecode>();
  const assetStart = new Map<string, Rational>();
  const assetFor = (asset: MediaAsset): string | undefined => {
    const existing = assetIds.get(asset.id);
    if (existing) return existing;
    const path = resolveAssetPath(request, asset.id);
    if (!path) return undefined;
    const picture = pictureOf(asset);
    const attributes: Record<string, string | number | undefined> = {};
    let start: Rational = { n: 0, d: 1 };
    if (picture === 'still') {
      Object.assign(attributes, {
        name: stemOf(asset.file_name),
        start: '0s',
        duration: '0s',
        hasVideo: 1,
        format: formatFor(asset.width ?? plan.sequence.width, asset.height ?? plan.sequence.height),
        videoSources: 1,
      });
    } else {
      // The media's own clock: an asset-clip's `start` is read against it, so a
      // camera file that begins at 01:00:00;00 is addressed from there.
      const clock = sourceTimecodeOf(asset, rate);
      clocks.set(asset.id, clock);
      start = rational(clock.frames * clock.rate.den, clock.rate.num);
      // The length in the file's own units: frames at its own rate for a
      // picture, samples for sound.
      const unit =
        picture === 'video'
          ? { per: clock.rate.num, of: clock.rate.den }
          : { per: asset.audio_sample_rate ?? 48_000, of: 1 };
      let count =
        picture === 'video'
          ? Math.round((asset.duration_ms / 1000) * (unit.per / unit.of))
          : Math.round((asset.duration_ms * unit.per) / 1000);
      // Never shorter than the furthest frame a clip reads from it. The grid
      // rounds a clip played to the end of its file up to a whole frame, and
      // the file's own length is rarely one: a 2232 ms mp3 played to its end
      // at 30 fps is a 67-frame clip (2233.3 ms) reading a file declared 2232 ms
      // long, a clip past its asset's end, which an importer is entitled to
      // refuse. The asset is declared as long as the clip reads, rounded up to
      // the file's own unit so the value stays in the counting the rest of the
      // declaration uses; the frame it covers is the file's last, part sound and
      // part the silence after it. A file no clip reads past is declared exactly
      // as it always was.
      const read = reach.get(asset.id);
      if (read !== undefined) {
        // `read` frames at the sequence rate, in the file's units, rounded up:
        // whole numbers throughout, so the comparison is exact.
        const numerator = read * rate.den * unit.per;
        const denominator = rate.num * unit.of;
        let needed = Math.ceil(numerator / denominator);
        if (needed * denominator < numerator) needed++;
        count = Math.max(count, needed);
      }
      const duration = rational(count * unit.of, unit.per);
      Object.assign(attributes, {
        name: stemOf(asset.file_name),
        start: formatTime(start),
        duration: formatTime(duration),
      });
      if (picture === 'video') {
        Object.assign(attributes, {
          hasVideo: 1,
          format: formatFor(
            asset.width ?? plan.sequence.width,
            asset.height ?? plan.sequence.height,
            clock.rate,
          ),
          videoSources: 1,
        });
      }
      const streams = audioLayout(asset);
      if (streams.length > 0) {
        Object.assign(attributes, {
          hasAudio: 1,
          audioSources: streams.length,
          audioChannels: streams.reduce((sum, s) => sum + s.channels, 0),
          audioRate: asset.audio_sample_rate ?? 48_000,
        });
      }
    }
    assetStart.set(asset.id, start);
    const id = `r${nextId++}`;
    assetIds.set(asset.id, id);
    resources.push(
      element('asset', { id, ...attributes }, [
        element('media-rep', { kind: 'original-media', src: toFileUrl(path) }),
      ]),
    );
    return id;
  };

  let dissolveIds: { video: string; audio: string } | undefined;
  const dissolve = (): { video: string; audio: string } => {
    if (dissolveIds) return dissolveIds;
    dissolveIds = { video: `r${nextId++}`, audio: `r${nextId++}` };
    // Final Cut's own identifiers for its Cross Dissolve and Audio Crossfade;
    // Resolve maps the first to its own cross dissolve by name.
    resources.push(
      element('effect', {
        id: dissolveIds.video,
        name: 'Cross Dissolve',
        uid: 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265',
      }),
      element('effect', {
        id: dissolveIds.audio,
        name: 'Audio Crossfade',
        uid: 'FFAudioTransition',
      }),
    );
    return dissolveIds;
  };

  const gainOf = plan.tracks.audio.find((spec) => spec.type === 'source_audio')?.gain_db ?? 0;
  const lookup = (id: string): MediaAsset | undefined => assetById(assets, id);

  /**
   * One source per audio stream of a file, and only the chosen one active: the
   * lavalier, not the room tone on the stream in front of it.
   */
  const channelSources = (asset: MediaAsset, sound: ClipSound): Element[] => {
    if (sound.streams <= 1) return [];
    const channels: Element[] = [];
    let channel = 1;
    for (const [index, layout] of audioLayout(asset).entries()) {
      const numbers = Array.from({ length: layout.channels }, (_, c) => channel + c);
      channel += layout.channels;
      channels.push(
        element('audio-channel-source', {
          srcCh: numbers.join(', '),
          role: 'dialogue',
          active: index === sound.stream ? 1 : 0,
        }),
      );
    }
    return channels;
  };

  /**
   * A separate recorder's sound for one clip: an audio clip connected below its
   * picture, from the recorder's own frame, for the clip's length.
   *
   * Connected rather than put in the storyline, because a storyline clip is one
   * file and the storyline already holds the picture. A connected audio clip is
   * the shape this file already gives a music bed, so it asks nothing new of an
   * importer; Final Cut's synchronized clip (`sync-clip`) would be a second kind
   * of container for Final Cut and Resolve to agree on. `offset` is in the
   * parent's own time: the clip's first frame, when the parent is the clip.
   */
  const recorderClip = (
    audio: ClipAudio,
    length: number,
    offset: string,
    lane: number,
  ): Element | undefined => {
    const ref = assetFor(audio.asset);
    if (!ref) return undefined;
    return element(
      'asset-clip',
      {
        ref,
        lane,
        offset,
        name: stemOf(audio.asset.file_name),
        start: formatTime(add(assetStart.get(audio.asset.id) ?? { n: 0, d: 1 }, at(audio.in))),
        duration: time(length),
        audioRole: 'dialogue',
      },
      [
        ...(gainOf !== 0 ? [element('adjust-volume', { amount: `${gainOf}dB` })] : []),
        ...channelSources(audio.asset, audio.sound),
      ],
    );
  };

  /**
   * One clip as an item: a still is `video`, anything else an `asset-clip`.
   *
   * Its sound is its own file's, or a recorder's (`recorder`), which the caller
   * connects where the clip is: under the clip itself in the storyline, and
   * beside an upper track's clip on the storyline item it is connected to, since
   * Final Cut connects clips to the primary storyline and not to each other.
   */
  const clipItem = (
    span: GridSpan,
    lane: number,
  ): (SpineItem & { recorder?: ClipAudio }) | undefined => {
    const operation = span.operation;
    const asset = assetById(assets, operation.source_asset_id);
    const ref = asset ? assetFor(asset) : undefined;
    if (!asset || !ref) {
      warnings.push(
        `${operation.operation_id} refers to ${operation.source_asset_id}, which has no file`,
      );
      return undefined;
    }
    const picture = pictureOf(asset);
    const audio = clipAudio(span, lookup, grid.rate, warnings);
    if (picture === 'none' && !audio) {
      warnings.push(
        `${operation.operation_id} is sound only and does not use its sound; nothing of it was written`,
      );
      return undefined;
    }
    // A sound-only clip is its sound, read from whichever file holds it. A clip
    // with a picture plays its own file's sound, or a recorder's connected
    // below it — and then none of the camera's.
    const recorder = picture !== 'none' && audio?.separate ? audio : undefined;
    const sound = recorder ? undefined : audio?.sound;
    const read = picture === 'none' ? audio!.asset : asset;
    const readRef = read === asset ? ref : assetFor(read);
    if (!readRef) return undefined;
    const name = stemOf(read.file_name);
    const placement = {
      ref: readRef,
      lane: lane === 0 ? undefined : lane,
      offset: time(span.start),
      name,
    };

    if (picture === 'still') {
      // A still has no timeline of its own; an hour in leaves an hour of handle
      // either side for a dissolve, which is what Final Cut itself writes.
      return {
        node: element('video', { ...placement, start: '3600s', duration: time(span.length) }),
        offset: span.start,
        length: span.length,
        start: { n: 3600, d: 1 },
        intrinsic: [],
        anchored: [],
        markers: [],
        channels: [],
        ...(recorder ? { recorder } : {}),
      };
    }

    const start = add(
      assetStart.get(read.id) ?? { n: 0, d: 1 },
      at(picture === 'none' ? audio!.in : span.in),
    );
    const hasAudio = audioLayout(read).length > 0;
    const intrinsic: Element[] = [];
    if (sound && gainOf !== 0) intrinsic.push(element('adjust-volume', { amount: `${gainOf}dB` }));
    return {
      node: element('asset-clip', {
        ...placement,
        start: formatTime(start),
        duration: time(span.length),
        tcFormat,
        // A cutaway's sound is not used, so the clip keeps its picture only; nor
        // is a camera's whose sound is a recorder's. A file with no sound needs
        // no such thing, and a sound-only file has no picture to keep.
        srcEnable: !sound && hasAudio && picture === 'video' ? 'video' : undefined,
        audioRole: sound ? 'dialogue' : undefined,
      }),
      offset: span.start,
      length: span.length,
      start,
      intrinsic,
      anchored: [],
      markers: [],
      channels: sound ? channelSources(read, sound) : [],
      ...(recorder ? { recorder } : {}),
    };
  };

  // ---- the storyline ---------------------------------------------------------
  // Track 0 is the storyline: contiguous from zero to the end of the cut, with
  // a gap wherever the plan has nothing, because every other item — an upper
  // track, a bed, a caption, a chapter — is anchored to whatever the storyline
  // holds at that moment and needs something to be anchored to.
  const gapItem = (offset: number, length: number): SpineItem => ({
    node: element('gap', {
      name: 'Gap',
      offset: time(offset),
      start: '3600s',
      duration: time(length),
    }),
    offset,
    length,
    start: { n: 3600, d: 1 },
    intrinsic: [],
    anchored: [],
    markers: [],
    channels: [],
  });

  const main = grid.tracks.get(0) ?? [];
  const pictured = main.filter((span) => {
    const asset = assetById(assets, span.operation.source_asset_id);
    return (
      asset !== undefined && pictureOf(asset) !== 'none' && resolveAssetPath(request, asset.id)
    );
  });
  // A sound-only clip is in the storyline too, and a cross-fade between two of
  // them is a transition there, as a picture's is: Final Cut's Cross Dissolve
  // carries an Audio Crossfade, and between two clips with no picture that is
  // all it does.
  const storylineClips = main.flatMap((span): TrackClip[] => {
    const asset = assetById(assets, span.operation.source_asset_id);
    if (!asset || !resolveAssetPath(request, asset.id)) return [];
    if (pictureOf(asset) !== 'none') return [{ span }];
    const sound = clipAudio(span, lookup, grid.rate);
    return sound && resolveAssetPath(request, sound.asset.id) ? [{ span, sound }] : [];
  });
  const placed = [
    ...transitionsOf(pictured, grid.frames, mediaFramesOf(assets, grid.frames), warnings),
    ...soundTransitionsOf(storylineClips, grid.frames, downgrades),
  ];
  const leading = new Map<string, PlacedTransition>();
  const trailing = new Map<string, PlacedTransition>();
  for (const transition of placed) {
    if (transition.kind === 'tail')
      trailing.set(transition.outgoing!.operation.operation_id, transition);
    else leading.set(transition.incoming!.operation.operation_id, transition);
  }

  const spine: (SpineItem | PlacedTransition)[] = [];
  const items: SpineItem[] = [];
  const push = (item: SpineItem): void => {
    spine.push(item);
    items.push(item);
  };
  // Each video track's recorded sound on a lane of its own below the
  // storyline — track 0's on -1, track 1's on -2 — so no two of them are ever
  // asked to share one, and the beds below all of them. Resolve makes each lane
  // an audio track, and two clips claiming the same frames of one track is an
  // overwrite.
  let lowestSoundLane = 0;
  const soundLane = (track: number): number => {
    lowestSoundLane = Math.min(lowestSoundLane, -(track + 1));
    return -(track + 1);
  };

  let cursor = 0;
  for (const span of main) {
    const clip = clipItem(span, 0);
    if (!clip) continue;
    if (clip.recorder) {
      const connected = recorderClip(
        clip.recorder,
        span.length,
        formatTime(clip.start),
        soundLane(0),
      );
      if (connected) clip.anchored.push(connected);
    }
    if (span.start > cursor) push(gapItem(cursor, span.start - cursor));
    const before = leading.get(span.operation.operation_id);
    if (before) spine.push(before);
    push(clip);
    const after = trailing.get(span.operation.operation_id);
    if (after) spine.push(after);
    cursor = span.end;
  }
  if (cursor < grid.length || items.length === 0) {
    push(gapItem(cursor, Math.max(1, grid.length - cursor)));
  }

  /** The storyline item a moment on the timeline is anchored to. */
  const anchorAt = (frame: number): SpineItem =>
    items.find((item) => item.offset <= frame && frame < item.offset + item.length) ??
    items[items.length - 1]!;
  /** A moment on the timeline, in an item's own time: where anchored things say they are. */
  const localTime = (item: SpineItem, frame: number): string =>
    formatTime(add(item.start, at(frame - item.offset)));

  // ---- anchored items --------------------------------------------------------
  // Upper tracks: connected clips on lanes above the storyline. A transition on
  // one would need a storyline of its own; they are cuts, and said to be.
  for (const [track, spans] of grid.tracks) {
    if (track === 0) continue;
    for (const span of spans) {
      const asked = [span.operation.transition_in, span.operation.transition_out].find(
        (t) => t && t.type !== 'hard_cut',
      );
      if (asked) {
        warnings.push(
          `${span.operation.operation_id} is on track ${track}, a connected clip in FCPXML; its ${asked.type} was not written`,
        );
      }
      const clip = clipItem(span, track);
      if (!clip) continue;
      const parent = anchorAt(span.start);
      clip.node = {
        ...clip.node,
        attributes: clip.node.attributes.map(([key, value]) =>
          key === 'offset' ? [key, localTime(parent, span.start)] : [key, value],
        ),
      };
      parent.anchored.push(finish(clip));
      if (clip.recorder) {
        const connected = recorderClip(
          clip.recorder,
          span.length,
          localTime(parent, span.start),
          soundLane(track),
        );
        if (connected) parent.anchored.push(connected);
      }
    }
  }

  // Beds: connected clips below the storyline, at their own level, and below
  // any recorder's lane.
  let bedLane = lowestSoundLane;
  for (const spec of plan.tracks.audio) {
    if (spec.type !== 'external') continue;
    const asset = assetById(assets, spec.asset_id);
    const sound = asset ? streamOf(asset, undefined, spec.asset_id, warnings) : undefined;
    const bed = asset ? bedSpan(spec, asset, grid.length, grid.frames) : undefined;
    const ref = asset ? assetFor(asset) : undefined;
    if (!asset || !sound || !bed || !ref) {
      warnings.push(`the bed on audio track ${spec.track} (${spec.asset_id}) was not written`);
      continue;
    }
    bedLane--;
    const parent = anchorAt(bed.start);
    parent.anchored.push(
      element(
        'asset-clip',
        {
          ref,
          lane: bedLane,
          offset: localTime(parent, bed.start),
          name: stemOf(asset.file_name),
          start: formatTime(add(assetStart.get(asset.id) ?? { n: 0, d: 1 }, at(bed.in))),
          duration: time(bed.length),
          audioRole: 'music',
        },
        spec.gain_db !== 0 ? [element('adjust-volume', { amount: `${spec.gain_db}dB` })] : [],
      ),
    );
  }

  // Captions: above every video lane, one per caption, each with its own style
  // as Final Cut writes them.
  const captionLane = Math.max(0, ...grid.tracks.keys()) + 1;
  const captions = plan.tracks.text.filter((text) => text.kind === 'caption');
  for (const [index, caption] of captions.entries()) {
    const startFrame = grid.frames(caption.timeline_start_ms);
    const length = grid.frames(caption.timeline_end_ms) - startFrame;
    if (length < 1) continue;
    const parent = anchorAt(startFrame);
    parent.anchored.push(
      captionElement(caption, index + 1, captionLane, localTime(parent, startFrame), time(length)),
    );
  }

  // Chapters on the storyline item they fall in, in its own time.
  for (const marker of plan.markers) {
    const frame = Math.min(grid.frames(marker.timeline_ms), Math.max(0, grid.length - 1));
    const parent = anchorAt(frame);
    const attributes = { start: localTime(parent, frame), duration: time(1), value: marker.name };
    parent.markers.push(
      marker.kind === 'chapter'
        ? element('chapter-marker', { ...attributes, posterOffset: '0s' })
        : element('marker', attributes),
    );
  }

  // ---- write -------------------------------------------------------------------
  const spineChildren = spine.map((entry) =>
    'node' in entry ? finish(entry) : transitionElement(entry, time, dissolve()),
  );
  const audioRate =
    plan.sequence.sample_rate === 44_100
      ? '44.1k'
      : `${Math.round(plan.sequence.sample_rate / 1000)}k`;
  const document = element('fcpxml', { version: '1.10' }, [
    element('resources', {}, resources),
    element('library', {}, [
      element('event', { name: plan.sequence.name }, [
        element('project', { name: plan.sequence.name }, [
          element(
            'sequence',
            {
              format: sequenceFormat,
              duration: time(Math.max(grid.length, 1)),
              tcStart: time(recordStartFrames ?? 0),
              tcFormat,
              audioLayout: 'stereo',
              audioRate,
            },
            [element('spine', {}, spineChildren)],
          ),
        ]),
      ]),
    ]),
  ]);

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    ...serialise(document, 0),
  ];
  return { xml: `${xml.join('\n')}\n`, timecodes: [...clocks.values()] };
}

function transitionElement(
  placed: PlacedTransition,
  time: (frames: number) => string,
  effect: { video: string; audio: string },
): Element {
  let offset: number;
  let length: number;
  if (placed.kind === 'between') {
    offset = placed.outgoing!.end - placed.frames;
    length = placed.frames * 2;
  } else if (placed.kind === 'head') {
    offset = placed.incoming!.start;
    length = placed.frames;
  } else {
    offset = placed.outgoing!.end - placed.frames;
    length = placed.frames;
  }
  return element(
    'transition',
    { name: 'Cross Dissolve', offset: time(offset), duration: time(length) },
    [
      element('filter-video', { ref: effect.video, name: 'Cross Dissolve' }),
      element('filter-audio', { ref: effect.audio, name: 'Audio Crossfade' }),
    ],
  );
}

function captionElement(
  caption: TextOperation,
  index: number,
  lane: number,
  offset: string,
  duration: string,
): Element {
  // A caption role names its language, and Japanese filed as English is sorted
  // into the wrong caption track; the text itself says which it is.
  const language = /[぀-ヿ㐀-鿿]/.test(caption.text) ? 'ja' : 'en';
  const style = `ts${index}`;
  return element(
    'caption',
    {
      lane,
      offset,
      name: caption.text.split('\n')[0]!.slice(0, 40),
      start: '3600s',
      duration,
      role: `SRT?captionFormat=SRT.${language}`,
    },
    [
      element('text', { placement: 'bottom' }, [
        element('text-style', { ref: style }, [], caption.text),
      ]),
      element('text-style-def', { id: style }, [
        element('text-style', {
          font: '.AppleSystemUIFont',
          fontSize: 13,
          fontFace: 'Regular',
          fontColor: '1 1 1 1',
          backgroundColor: '0 0 0 1',
        }),
      ]),
    ],
  );
}

/** Each audio stream's channel count, in order. */
function audioLayout(asset: MediaAsset): { channels: number }[] {
  const streams = [...(asset.audio_streams ?? [])].sort((a, b) => a.index - b.index);
  if (streams.length > 0) {
    return streams.map((stream) => ({ channels: streamChannels(asset, stream) }));
  }
  const first = streamOf(asset, undefined, asset.id);
  return first ? [{ channels: first.channels }] : [];
}

function stemOf(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, '') || fileName;
}
