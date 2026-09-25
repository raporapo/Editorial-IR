import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterCapabilities,
  framesToSmpte,
  smpteToFrames,
  supportsDropFrame,
  type ApplyResult,
  type CapabilityDowngrade,
  type EditPlan,
  type MediaAsset,
} from '@editorial-ir/contracts';
import type { ApplyRequest, EditorAdapter } from './types.js';
import { negotiate, resolveAssetPath, stringOption } from './types.js';
import {
  assetById,
  clipAudio,
  countedRate,
  describeTimecodeOrigins,
  layOnGrid,
  mediaFramesOf,
  pictureOf,
  recordersOf,
  soundTransitionsOf,
  sourceTimecodeOf,
  transitionsOf,
  type ClipAudio,
  type ClipSound,
  type GridSpan,
  type PlacedTransition,
  type SourceTimecode,
} from './timeline.js';

/**
 * CMX 3600 edit decision list.
 *
 * The oldest interchange format still in use, and the one every finishing tool
 * reads: Resolve, Avid, Baselight, a colourist's conform. It is also the most
 * limited — one picture track, sound only as channels of the same events, no
 * stills, reel names of eight characters — and those limits are declared here
 * so that negotiation reports what does not fit instead of this file quietly
 * holding less than the plan.
 *
 * Every source time is the media's own clock: its embedded start timecode where
 * it has one. A camera or a broadcast master routinely starts at 01:00:00:00,
 * and a list that counts from zero asks the conform for an hour of frames that
 * do not exist.
 */
export const EDL_CAPABILITIES: AdapterCapabilities = AdapterCapabilities.parse({
  id: 'edl',
  name: 'CMX 3600 EDL',
  mode: 'file',
  output_extensions: ['.edl'],
  text: false,
  captions: false,
  markers: true,
  basic_transition: true,
  transition_types: ['cross_dissolve', 'fade_in', 'fade_out'],
  keyframes: false,
  masking: false,
  nested_sequence: false,
  speed_change: false,
  still_images: false,
  color_adjustment: false,
  audio_tracks: 1,
  max_video_tracks: 1,
  reads_back_timeline: false,
  renders_preview: false,
  notes: [
    'One picture track with its sound as channels of the same events (V, B, AA/V, A, AA), frame-accurate at the sequence rate.',
    'A dissolve is written on the channels both clips carry; a channel only one side has comes in or goes out on the cut, as an event of its own at the same record time.',
    'A dissolve between two sound-only clips is a D event on their sound channels, where the handles allow it.',
    'A clip whose sound is a separate recorder’s is two events at the same record time: the picture (V) from the camera’s reel, the sound (A, AA) from the recorder’s.',
    'Drop-frame timecode for 29.97 and 59.94; source timecodes start at each file’s embedded start timecode.',
    'Reel names are made from file names within eight characters, with the full name in a FROM CLIP NAME comment; chapters are LOC comments.',
    'No stills, no second video track and no music bed: negotiation reports each one it leaves out.',
    'Options: record_start (the record timecode of the first frame, e.g. 01:00:00:00; default 00:00:00:00).',
  ],
});

export class EdlAdapter implements EditorAdapter {
  readonly capabilities = EDL_CAPABILITIES;

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    const { plan, downgrades } = negotiate(request.plan, this.capabilities, request.ir.assets);
    const warnings: string[] = [];
    const { text, timecodes } = buildEdlDocument(plan, request, warnings, downgrades);

    const name = request.name ?? 'timeline';
    mkdirSync(request.outputDir, { recursive: true });
    const path = join(request.outputDir, `${name}.edl`);
    writeFileSync(path, text);
    return {
      adapter: this.capabilities.id,
      artifacts: [
        {
          path,
          kind: 'interchange',
          description: `A CMX 3600 edit list. ${describeTimecodeOrigins(timecodes)}`,
          byte_size: statSync(path).size,
        },
      ],
      downgrades,
      warnings,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

/** The list as text. */
export function buildEdl(
  plan: EditPlan,
  request: ApplyRequest,
  warnings: string[] = [],
  downgrades: CapabilityDowngrade[] = [],
): string {
  return buildEdlDocument(plan, request, warnings, downgrades).text;
}

/**
 * Reel names for every asset, in the order the cut first uses them.
 *
 * CMX reels are at most eight characters, and the asset ids this project uses
 * (`asset_001`) are nine, so a reel is made from the file's own name — the
 * letters and digits, upper-cased, and when that is too long the first three
 * (the camera's prefix: IMG, DJI, PXL) and the last five (its counter) — which
 * is what a conform by reel can be matched against. Two cards both holding a
 * DJI_0001.MP4 collide, so a later duplicate gives up its last characters to a
 * number. `BL` and `AX` are reserved: black, and "auxiliary".
 */
export function reelNames(assets: readonly MediaAsset[]): Map<string, string> {
  const used = new Set(['BL', 'AX']);
  const names = new Map<string, string>();
  for (const asset of assets) {
    if (names.has(asset.id)) continue;
    const stem = asset.file_name.replace(/\.[^.]*$/, '');
    let base = stem.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (base.length === 0) base = 'REEL';
    if (base.length > 8) base = `${base.slice(0, 3)}${base.slice(-5)}`;
    let reel = base;
    for (let n = 2; used.has(reel); n++) {
      const suffix = String(n);
      reel = `${base.slice(0, 8 - suffix.length)}${suffix}`;
    }
    used.add(reel);
    names.set(asset.id, reel);
  }
  return names;
}

interface EdlLine {
  reel: string;
  channel: string;
  /** Undefined for a cut; the dissolve's length in frames otherwise. */
  dissolve?: number;
  sourceIn: number;
  sourceOut: number;
  recordIn: number;
  recordOut: number;
}

interface EdlEvent {
  lines: EdlLine[];
  comments: string[];
  recordIn: number;
  recordOut: number;
  /**
   * Sound under a picture event, as an event of its own: a separate recorder's,
   * or a clip's own sound split from its picture at a dissolve. Chapters are
   * not put under it.
   */
  underPicture?: true;
}

/**
 * What an event carries: the picture, and which of the first two sound
 * channels. A list can name these sets and no others (`channelCode`).
 */
interface Channels {
  picture: boolean;
  /** Sound channels, from 1: `[1]` for mono, `[1, 2]` for a pair. */
  sound: number[];
}

/** A clip's channels: its picture if it has one, and one or two of sound. */
function channelsOf(picture: boolean, sound: ClipSound | undefined): Channels {
  return { picture, sound: sound ? (sound.channels >= 2 ? [1, 2] : [1]) : [] };
}

/** The channels two clips both carry. */
function common(a: Channels, b: Channels): Channels {
  return { picture: a.picture && b.picture, sound: a.sound.filter((c) => b.sound.includes(c)) };
}

/**
 * The list and the clocks its source times were counted from. `downgrades`
 * receives the transitions between sound-only clips that stay cuts.
 */
export function buildEdlDocument(
  plan: EditPlan,
  request: ApplyRequest,
  warnings: string[] = [],
  downgrades: CapabilityDowngrade[] = [],
): { text: string; timecodes: SourceTimecode[] } {
  const { num: planNum, den: planDen } = {
    num: plan.sequence.frame_rate_num,
    den: plan.sequence.frame_rate_den,
  };
  const { rate } = countedRate(planNum, planDen, 'an EDL', warnings);
  const dropFrame = supportsDropFrame(rate.num, rate.den);
  const grid = layOnGrid(plan, rate);
  const assets = request.ir.assets;
  const tc = (frames: number): string => framesToSmpte(frames, rate.num, rate.den, dropFrame);

  const recordStartText = stringOption(request, 'record_start', '00:00:00:00');
  const recordStart = smpteToFrames(recordStartText, rate.num, rate.den, dropFrame);
  if (recordStart === undefined) {
    warnings.push(
      `record_start "${recordStartText}" is not a timecode; the list starts at 00:00:00:00`,
    );
  }
  const record = (frames: number): number => (recordStart ?? 0) + frames;

  const spans = [...grid.tracks.values()].flat().sort((a, b) => a.start - b.start);
  // The recorders a clip's sound is read from are reels too, although no
  // clip's picture names them. They come after every picture's, so a camera
  // keeps the reel name it has in a list without them.
  const used = [
    ...spans.map((span) => assetById(assets, span.operation.source_asset_id)),
    ...recordersOf(plan).map((id) => assetById(assets, id)),
  ].filter((asset): asset is MediaAsset => asset !== undefined);
  const reels = reelNames(used);
  const lookup = (id: string): MediaAsset | undefined => assetById(assets, id);

  // Each file's own clock, converted to the list's rate. A file at another rate
  // cannot be addressed exactly by a list that counts at one rate: its
  // timecodes are written at the list's, and a conform by timecode will miss.
  const timecodes = new Map<string, SourceTimecode>();
  const clockStart = new Map<string, number>();
  for (const asset of used) {
    if (timecodes.has(asset.id)) continue;
    const clock = sourceTimecodeOf(asset, rate);
    timecodes.set(asset.id, clock);
    const sameRate = clock.rate.num * rate.den === rate.num * clock.rate.den;
    clockStart.set(
      asset.id,
      sameRate
        ? clock.frames
        : Math.round((clock.frames * clock.rate.den * rate.num) / (clock.rate.num * rate.den)),
    );
    if (!sameRate && pictureOf(asset) === 'video') {
      warnings.push(
        `${asset.file_name} is ${clock.rate.num}/${clock.rate.den} fps in a ${rate.num}/${rate.den} list; ` +
          'its source timecodes are counted at the list’s rate, so conform it by clip name rather than timecode',
      );
    }
  }

  /** One file's part in an event: which reel, which frames of it, which sound. */
  interface Source {
    asset: MediaAsset;
    reel: string;
    sound: ClipSound | undefined;
    clock: number;
    /** Source frames, before the file's clock is added. */
    in: number;
    out: number;
  }
  interface Described extends Source {
    span: GridSpan;
    channels: Channels;
    /** `channels` as the list writes them. */
    channel: string;
    /** A separate recorder whose sound goes under this clip's picture. */
    recorder?: Source & { sound: ClipSound };
    /** For a sound-only clip, the sound it plays: it has no picture. */
    soundOnly?: ClipAudio;
  }
  const sourceOf = <S extends ClipSound | undefined>(
    asset: MediaAsset,
    sound: S,
    from: number,
    to: number,
  ): Source & { sound: S } => ({
    asset,
    reel: reels.get(asset.id)!,
    sound,
    clock: clockStart.get(asset.id) ?? 0,
    in: from,
    out: to,
  });
  const described: Described[] = [];
  for (const span of spans) {
    const asset = assetById(assets, span.operation.source_asset_id);
    if (!asset || !resolveAssetPath(request, asset.id)) {
      warnings.push(
        `${span.operation.operation_id} refers to ${span.operation.source_asset_id}, which has no file`,
      );
      continue;
    }
    const picture = pictureOf(asset);
    const audio = clipAudio(span, lookup, grid.rate, warnings);
    if (picture === 'still') continue; // negotiation has already said so
    if (picture === 'none' && !audio) {
      warnings.push(
        `${span.operation.operation_id} is sound only and does not use its sound; nothing of it was written`,
      );
      continue;
    }
    if (picture === 'none') {
      // A sound-only clip is its sound, from whichever file holds it.
      described.push({
        span,
        ...sourceOf(audio!.asset, audio!.sound, audio!.in, audio!.out),
        channels: channelsOf(false, audio!.sound),
        channel: channelCode(channelsOf(false, audio!.sound)),
        soundOnly: audio!,
      });
      continue;
    }
    // A list has one reel per event, so a picture whose sound is a recorder's
    // is two events at the same record time: the picture alone from the
    // camera's reel, and the sound from the recorder's.
    const recorder = audio?.separate ? audio : undefined;
    const sound = recorder ? undefined : audio?.sound;
    described.push({
      span,
      ...sourceOf(asset, sound, span.in, span.out),
      channels: channelsOf(true, sound),
      channel: channelCode(channelsOf(true, sound)),
      ...(recorder
        ? { recorder: sourceOf(recorder.asset, recorder.sound, recorder.in, recorder.out) }
        : {}),
    });
  }

  // The file a sound-only clip reads is its sound's (`asset` above), which may
  // be a recorder with a picture of its own; whether the clip has a picture is
  // what it was described as.
  const pictured = described.filter((d) => !d.soundOnly);
  const placed = [
    ...transitionsOf(
      pictured.map((d) => d.span),
      grid.frames,
      mediaFramesOf(assets, grid.frames),
      warnings,
    ),
    // A dissolve between two sound-only clips is a dissolve on their sound
    // channels (`AA D`), which the list writes like any other.
    ...soundTransitionsOf(
      described.map((d) => (d.soundOnly ? { span: d.span, sound: d.soundOnly } : { span: d.span })),
      grid.frames,
      downgrades,
    ),
  ];
  const into = new Map<string, PlacedTransition>();
  const outOf = new Map<string, PlacedTransition>();
  for (const transition of placed) {
    if (transition.kind !== 'tail')
      into.set(transition.incoming!.operation.operation_id, transition);
    if (transition.kind !== 'head')
      outOf.set(transition.outgoing!.operation.operation_id, transition);
  }
  const describedById = new Map(described.map((d) => [d.span.operation.operation_id, d]));

  const events: EdlEvent[] = [];
  for (const d of described) {
    const id = d.span.operation.operation_id;
    const incoming = into.get(id);
    const outgoing = outOf.get(id);
    // Where a fade out of this clip begins.
    const fadeOutAt = d.span.end - (outgoing?.kind === 'tail' ? outgoing.frames : 0);

    // A dissolve is written on the channels both clips carry, and nothing else.
    // It was written on the incoming clip's channels whatever the outgoing one
    // had: measured on the worked example's memory-film cut, a picture-only clip
    // (op_0003, its sound not used) into one with stereo sound gave
    // `004 IMG1001 AA/V C` and `004 IMG1001 AA/V D 024` — a conform asked for
    // op_0003's sound through the dissolve, the sound the plan left out, and
    // OpenTimelineIO refused the file, since the list's first sound was a
    // transition from nothing ("Transitions can't be at the very beginning of a
    // track"). The other way round, a clip with sound into one without, ended
    // the outgoing sound half a dissolve before the cut.
    //
    // So each channel of a clip is placed on its own. One the dissolve into it
    // carries starts half the dissolve before the cut, as part of it; one the
    // dissolve out of it carries ends half the dissolve before the cut, where
    // the next clip's dissolve takes it over. Any other channel starts and ends
    // on the cut, where the plan puts the clip, as a straight cut in an event
    // of its own at the same record time — the shape a separate recorder's
    // sound already has below. A fade at an edge carries every channel. Where
    // both clips carry the same channels, every channel is placed alike and
    // the clip is one event, exactly as before.
    const carried = (transition: PlacedTransition | undefined, other: 'outgoing' | 'incoming') =>
      transition?.kind === 'between'
        ? common(d.channels, describedById.get(transition[other]!.operation.operation_id)!.channels)
        : undefined;
    const carriedIn = carried(incoming, 'outgoing');
    const carriedOut = carried(outgoing, 'incoming');
    const has = (set: Channels | undefined, channel: 'V' | number): boolean =>
      set !== undefined && (channel === 'V' ? set.picture : set.sound.includes(channel));

    interface Part {
      channels: Channels;
      begins: 'dissolve' | 'fade' | 'cut';
      /** Frames before the clip's end at which this part hands over or fades out. */
      endsEarly: number;
    }
    const parts: Part[] = [];
    for (const channel of [...(d.channels.picture ? ['V' as const] : []), ...d.channels.sound]) {
      const begins = has(carriedIn, channel)
        ? 'dissolve'
        : incoming?.kind === 'head'
          ? 'fade'
          : 'cut';
      const endsEarly =
        outgoing && (outgoing.kind === 'tail' || has(carriedOut, channel)) ? outgoing.frames : 0;
      let part = parts.find((p) => p.begins === begins && p.endsEarly === endsEarly);
      if (!part) {
        part = { channels: { picture: false, sound: [] }, begins, endsEarly };
        parts.push(part);
      }
      if (channel === 'V') part.channels.picture = true;
      else part.channels.sound.push(channel);
    }

    const path = resolveAssetPath(request, d.asset.id);
    for (const part of parts) {
      const channel = channelCode(part.channels);
      // A centred dissolve starts half its length before the cut, on footage
      // from before this clip's in point.
      const lead = part.begins === 'dissolve' ? incoming!.frames : 0;
      const recordIn = d.span.start - lead;
      const recordOut = d.span.end - part.endsEarly;
      const own: EdlLine = {
        reel: d.reel,
        channel,
        sourceIn: d.clock + d.in - lead,
        sourceOut: d.clock + d.out - part.endsEarly,
        recordIn: record(recordIn),
        recordOut: record(recordOut),
      };
      const comments = [`* FROM CLIP NAME: ${d.asset.file_name}`];
      if (path) comments.push(`* SOURCE FILE: ${path}`);
      if (d.sound && d.sound.streams > 1 && part.channels.sound.length > 0) {
        // The list has no way to name a stream; this is for the person conforming.
        comments.push(`* AUDIO STREAM: ${d.sound.stream + 1} OF ${d.sound.streams}`);
      }
      const placement = {
        recordIn: record(recordIn),
        recordOut: record(recordOut),
        // The clip's own sound split from its picture: chapters go under the picture.
        ...(d.channels.picture && !part.channels.picture ? { underPicture: true as const } : {}),
      };

      if (part.begins === 'dissolve') {
        const from = describedById.get(incoming!.outgoing!.operation.operation_id)!;
        const at = from.clock + from.out - incoming!.frames;
        events.push({
          lines: [
            {
              reel: from.reel,
              channel,
              sourceIn: at,
              sourceOut: at,
              recordIn: record(recordIn),
              recordOut: record(recordIn),
            },
            { ...own, dissolve: incoming!.frames * 2 },
          ],
          comments: [
            `* FROM CLIP NAME: ${from.asset.file_name}`,
            `* TO CLIP NAME: ${d.asset.file_name}`,
            ...comments.slice(1),
          ],
          ...placement,
        });
      } else if (part.begins === 'fade') {
        // A fade in is a dissolve from black.
        events.push({
          lines: [
            { ...blackLine(channel), recordIn: record(recordIn), recordOut: record(recordIn) },
            { ...own, dissolve: incoming!.frames },
          ],
          comments: [`* TO CLIP NAME: ${d.asset.file_name}`, ...comments.slice(1)],
          ...placement,
        });
      } else {
        events.push({ lines: [own], comments, ...placement });
      }
    }

    if (d.recorder) {
      // The recorder's sound, at the same record time as the picture and from
      // the recorder's own frame: the whole clip, cut where the clip is cut.
      // The picture's dissolves and fades are the picture's; the sound under
      // them is a straight cut, which is what a list can say about two reels.
      const r = d.recorder;
      const soundComments = [`* FROM CLIP NAME: ${r.asset.file_name}`];
      const soundPath = resolveAssetPath(request, r.asset.id);
      if (soundPath) soundComments.push(`* SOURCE FILE: ${soundPath}`);
      if (r.sound.streams > 1) {
        soundComments.push(`* AUDIO STREAM: ${r.sound.stream + 1} OF ${r.sound.streams}`);
      }
      events.push({
        lines: [
          {
            reel: r.reel,
            channel: channelCode(channelsOf(false, r.sound)),
            sourceIn: r.clock + r.in,
            sourceOut: r.clock + r.out,
            recordIn: record(d.span.start),
            recordOut: record(d.span.end),
          },
        ],
        comments: soundComments,
        recordIn: record(d.span.start),
        recordOut: record(d.span.end),
        underPicture: true,
      });
    }

    if (outgoing?.kind === 'tail') {
      // A fade out is a dissolve to black, from where this clip's cut ends.
      // Every channel ends here, so one event carries them all.
      const at = d.clock + d.out - outgoing.frames;
      events.push({
        lines: [
          {
            reel: d.reel,
            channel: d.channel,
            sourceIn: at,
            sourceOut: at,
            recordIn: record(fadeOutAt),
            recordOut: record(fadeOutAt),
          },
          {
            ...blackLine(d.channel),
            dissolve: outgoing.frames,
            sourceOut: outgoing.frames,
            recordIn: record(fadeOutAt),
            recordOut: record(d.span.end),
          },
        ],
        comments: [`* FROM CLIP NAME: ${d.asset.file_name}`],
        recordIn: record(fadeOutAt),
        recordOut: record(d.span.end),
      });
    }
  }

  // Chapters as LOC comments under the event they fall in, which is where
  // Avid-style readers look for them: the picture's, not a recorder's sound
  // under it.
  const located = events.filter((e) => !e.underPicture);
  for (const marker of plan.markers) {
    const at = record(grid.frames(marker.timeline_ms));
    const event =
      located.find((e) => e.recordIn <= at && at < e.recordOut) ??
      [...located].reverse().find((e) => e.recordIn <= at) ??
      located[0];
    if (!event) continue;
    const name = marker.name.replace(/\s+/g, ' ').trim();
    event.comments.push(
      `* LOC: ${tc(at)} ${marker.kind === 'chapter' ? 'GREEN' : 'YELLOW'}  ${name}`,
    );
  }

  if (events.length > 999) {
    warnings.push(
      `the list has ${events.length} events; CMX 3600 numbers them to 999 and some readers stop there`,
    );
  }

  const title = asciiTitle(plan.sequence.name, plan.skill.name);
  const out: string[] = [
    `TITLE: ${title}`,
    `FCM: ${dropFrame ? 'DROP FRAME' : 'NON-DROP FRAME'}`,
    '',
  ];
  for (const [index, event] of events.entries()) {
    const number = String(index + 1).padStart(3, '0');
    for (const line of event.lines) {
      const transition =
        line.dissolve === undefined ? 'C       ' : `D    ${String(line.dissolve).padStart(3, '0')}`;
      out.push(
        `${number}  ${line.reel.padEnd(8)} ${line.channel.padEnd(5)} ${transition} ` +
          `${tc(line.sourceIn)} ${tc(line.sourceOut)} ${tc(line.recordIn)} ${tc(line.recordOut)}`,
      );
    }
    out.push(...event.comments, '');
  }

  return { text: `${out.join('\n').trimEnd()}\n`, timecodes: [...timecodes.values()] };
}

/**
 * The channel field: which of picture and sound an event carries.
 *
 * `B` is picture and one channel of sound, `AA/V` picture and a stereo pair,
 * and the sound-only forms drop the `V`; `A2` and `A2/V` are the second
 * channel without the first, which is what is left of a stereo clip when a
 * dissolve takes its first channel with the picture. A clip whose file has no
 * audio is `V` — the list used to claim sound for every clip, and a conform
 * then looked for channels a drone clip never had.
 */
function channelCode(channels: Channels): string {
  const sound = channels.sound.join(',');
  const audio = sound === '1,2' ? 'AA' : sound === '1' ? 'A' : sound === '2' ? 'A2' : '';
  if (!channels.picture) return audio;
  return audio === '' ? 'V' : audio === 'A' ? 'B' : `${audio}/V`;
}

function blackLine(channel: string): EdlLine {
  return { reel: 'BL', channel, sourceIn: 0, sourceOut: 0, recordIn: 0, recordOut: 0 };
}

/**
 * The title, in the characters the format was defined for.
 *
 * CMX 3600 is ASCII, and a title line of Japanese is where older readers
 * choke first. The clip names below keep their own spelling in comments, which
 * readers skip rather than parse. A name that is mostly not ASCII leaves a
 * meaningless residue — `大阪1周年旅行 — 180s` became `1 180S` — so it gives
 * way to the skill's name.
 */
function asciiTitle(name: string, skill: string): string {
  const ascii = (value: string): string =>
    value
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  const title = ascii(name);
  const letters = title.replace(/[^A-Z]/g, '').length;
  return (letters >= 3 ? title : ascii(`EDITORIAL IR ${skill}`)).slice(0, 70);
}
