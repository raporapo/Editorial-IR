import {
  EditorialError,
  type ProbeResult,
  ProbeResult as ProbeResultSchema,
  parseOrThrow,
} from '@editorial-ir/contracts';
import type { CommandRunner } from '../command.js';
import { NodeCommandRunner } from '../command.js';
import type { MediaProbe, ModelIdentity } from '../types.js';

/**
 * Container metadata via ffprobe.
 *
 * ffprobe is the only hard external dependency in the whole project, and it is
 * the right one: re-implementing container parsing in Node or Python would be
 * both slower and wrong.
 *
 * The Python worker's `media.probe` is the same mapping, rule for rule. Which of
 * the two runs is a deployment detail, and an asset must not change because the
 * other one happened to be installed.
 */
export interface FfprobeOptions {
  runner?: CommandRunner;
  binary?: string;
  timeoutMs?: number;
}

export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_packets?: string;
  channels?: number;
  sample_rate?: string;
  duration?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
  side_data_list?: { rotation?: number }[];
}

export interface FfprobeOutput {
  format?: {
    duration?: string;
    format_name?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams?: FfprobeStream[];
}

/**
 * What the probe's output means changed in a way its cache key would not see:
 * the rate became the nominal one, cover art stopped being a picture, and every
 * audio stream is listed. A cached probe from before would be served forever —
 * ingest keys it on the file and the probe's identity, nothing else.
 */
export const PROBE_VERSION = '2';

export class FfprobeMediaProbe implements MediaProbe {
  readonly identity: ModelIdentity;
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(options: FfprobeOptions = {}) {
    this.runner = options.runner ?? new NodeCommandRunner();
    this.binary = options.binary ?? 'ffprobe';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.identity = {
      backend: 'ffprobe',
      model: this.binary,
      modelVersion: PROBE_VERSION,
      locality: 'local',
      mediaLeavesDevice: false,
    };
  }

  async available(): Promise<boolean> {
    return this.runner.available(this.binary);
  }

  async probe(path: string): Promise<ProbeResult> {
    const parsed = await this.json(path, ['-show_format', '-show_streams']);
    const picture = pictureStream(parsed.streams ?? []);
    let packets: number | undefined;
    if (picture && needsPacketCount(picture, parsed)) {
      packets = await this.countPackets(path, picture.index ?? 0);
    }
    return parseOrThrow(
      ProbeResultSchema,
      toProbeResult(parsed, packets === undefined ? {} : { packetCount: packets }),
      `ffprobe output for ${path}`,
    );
  }

  /**
   * Frames in a container that does not say how many it holds.
   *
   * Matroska and WebM carry no frame count, and their two declared rates agree
   * even when the frames do not: a variable-rate WebM with 132 frames in 8 s
   * reports 30/1 for both. Counting packets reads the file without decoding it —
   * measured at 56 ms for a 17 MB, 143 s file — and it is paid once, since the
   * probe is cached. A count that fails costs the VFR check, not the probe.
   */
  private async countPackets(path: string, streamIndex: number): Promise<number | undefined> {
    try {
      const counted = await this.json(path, [
        '-count_packets',
        '-select_streams',
        String(streamIndex),
        '-show_entries',
        'stream=nb_read_packets',
      ]);
      const value = Number(counted.streams?.[0]?.nb_read_packets);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async json(path: string, args: string[]): Promise<FfprobeOutput> {
    const { stdout } = await this.runner.run(
      this.binary,
      ['-v', 'error', '-print_format', 'json', ...args, path],
      { timeoutMs: this.timeoutMs },
    );
    try {
      return JSON.parse(stdout) as FfprobeOutput;
    } catch {
      throw new EditorialError('media_error', `ffprobe returned output that is not JSON`, { path });
    }
  }
}

/**
 * The first video stream that is a picture of the recording.
 *
 * An MP3 or M4A with album art carries the art as a one-frame video stream with
 * `disposition.attached_pic` set (and a declared rate of 90000/1), and taking
 * the first video stream regardless recorded a podcast episode as 600x600
 * `mjpeg` — a picture size the sequence could then be built to.
 */
export function pictureStream(streams: readonly FfprobeStream[]): FfprobeStream | undefined {
  return streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
}

/**
 * Whether the container is ffmpeg's reader for a single picture.
 *
 * Such a reader reports a frame rate — 25/1, the image2 default, for every
 * JPEG and PNG — and a still has none. Carried into the asset, that 25 made a
 * 30 fps project a 25 fps sequence.
 */
export function isStillFormat(formatName: string | undefined): boolean {
  if (!formatName) return false;
  return formatName.split(',').some((name) => name === 'image2' || name.endsWith('_pipe'));
}

function needsPacketCount(picture: FfprobeStream, parsed: FfprobeOutput): boolean {
  if (isStillFormat(parsed.format?.format_name)) return false;
  return !(Number(picture.nb_frames) > 0);
}

/**
 * Above this a declared rate is the container's clock showing through, not a
 * frame rate. Matroska writes timestamps in milliseconds, and a stream with
 * irregular ones declares 1000/1 — measured on a synthetic 51.5 fps VFR file.
 * 240 is the fastest ordinary capture rate (phone slow motion).
 */
export const MAX_NOMINAL_FPS = 240;

/** How far the measured rate may stray from the nominal one before the file is VFR. */
export const VFR_TOLERANCE = 0.01;

/**
 * Handler names ffmpeg and Apple write when nobody named the track. Reported as
 * a title they read as though somebody had called both tracks "SoundHandler".
 */
const GENERIC_HANDLERS = new Set(['SoundHandler', 'Core Media Audio', 'Apple Sound Media Handler']);

/** Exported so the mapping can be tested without running ffprobe. */
export function toProbeResult(
  parsed: FfprobeOutput,
  measured: { packetCount?: number } = {},
): unknown {
  const streams = parsed.streams ?? [];
  const video = pictureStream(streams);
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const audio = audios[0];
  const still = isStillFormat(parsed.format?.format_name);

  const durationSec = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  const rates = still || !video ? undefined : frameRates(video, parsed, measured.packetCount);

  const tags = { ...(parsed.format?.tags ?? {}), ...(video?.tags ?? {}) };
  const creation = tags.creation_time ?? tags.date;

  // Rotation arrives either as a display-matrix side datum or as a legacy tag.
  const sideRotation = video?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  const tagRotation = tags.rotate ? Number(tags.rotate) : undefined;
  const rotation = sideRotation ?? tagRotation;

  const result: Record<string, unknown> = {
    duration_ms: Math.max(0, Math.round(durationSec * 1000)),
    metadata: tags,
  };
  if (video?.width) result.width = video.width;
  if (video?.height) result.height = video.height;
  if (rates?.nominal) {
    result.fps_num = rates.nominal.num;
    result.fps_den = rates.nominal.den;
  }
  if (rates?.average) {
    result.avg_fps_num = rates.average.num;
    result.avg_fps_den = rates.average.den;
  }
  if (rates?.variable !== undefined) result.variable_frame_rate = rates.variable;
  if (video?.codec_name) result.video_codec = video.codec_name;
  if (audio?.codec_name) result.audio_codec = audio.codec_name;
  if (audio?.channels) result.audio_channels = audio.channels;
  if (audio?.sample_rate) result.audio_sample_rate = Number(audio.sample_rate);
  result.audio_streams = audios.map((stream, index) => audioStreamOf(stream, index));
  if (parsed.format?.format_name) result.container = parsed.format.format_name;
  if (parsed.format?.bit_rate) result.bit_rate = Number(parsed.format.bit_rate);
  if (rotation !== undefined && Number.isFinite(rotation)) {
    result.rotation = ((Math.round(rotation) % 360) + 360) % 360;
  }
  if (creation) result.creation_time = creation;
  return result;
}

function audioStreamOf(stream: FfprobeStream, index: number): Record<string, unknown> {
  const out: Record<string, unknown> = { index };
  if (stream.codec_name) out.codec = stream.codec_name;
  if (stream.channels) out.channels = stream.channels;
  if (stream.sample_rate && Number(stream.sample_rate) > 0) {
    out.sample_rate = Number(stream.sample_rate);
  }
  const language = stream.tags?.language;
  if (language && language !== 'und') out.language = language;
  const handler = stream.tags?.handler_name;
  // `||`, not `??`: an empty title is no title, and falls through to the handler
  // name exactly as it does in the worker.
  const named = stream.tags?.title;
  const title = named || (handler && !GENERIC_HANDLERS.has(handler) ? handler : undefined);
  if (title) out.title = title;
  return out;
}

interface FrameRates {
  nominal?: { num: number; den: number };
  average?: { num: number; den: number };
  variable?: boolean;
}

/**
 * The nominal rate, the reported average, and whether the frames follow either.
 *
 * `avg_frame_rate` was the rate, and for a phone clip that dropped frames it is
 * one nobody chose: 91/4 = 22.75 for a 30 fps recording, which became the
 * sequence rate. `r_frame_rate` is what the camera was set to and what an NLE
 * conforms to, so it is the rate; the average is kept beside it, and the file is
 * variable-rate when the frames it actually holds run more than 1% off the
 * nominal rate — by the container's own average where it lists its frames, and
 * by the packets counted over the picture's length where it does not.
 */
export function frameRates(
  video: FfprobeStream,
  parsed: FfprobeOutput,
  packetCount?: number,
): FrameRates {
  const declared = parseRational(video.r_frame_rate);
  const average = parseRational(video.avg_frame_rate);
  const plausible = (rate: { num: number; den: number } | undefined) =>
    rate && rate.num / rate.den <= MAX_NOMINAL_FPS ? rate : undefined;
  const nominal = plausible(declared) ?? plausible(average);

  // Where the container lists its frames (MP4, MOV), its average is already the
  // count over the frames' own durations, taken from that list. Dividing the
  // count by the stream's duration instead was wrong for any clip trimmed
  // without re-encoding: the edit list shortens the duration and not the list,
  // so a 30 fps clip cut with `-c copy` held 131 frames in 4.067 s — "32.2 fps",
  // variable — while its average said 30/1. That is how a phone's own trim and
  // every lossless cutter export, which is to say most pre-trimmed material.
  // Where the container lists nothing (Matroska, WebM, MPEG-TS, fragmented MP4)
  // the average is a declaration, and the packets are counted.
  const listed = Number(video.nb_frames) > 0;
  const seconds = pictureSeconds(video, parsed);
  const counted =
    !listed && packetCount !== undefined && packetCount > 1 && seconds > 0
      ? packetCount / seconds
      : undefined;
  const measured = counted ?? (average ? average.num / average.den : undefined);

  const out: FrameRates = {};
  if (nominal) out.nominal = nominal;
  if (average) out.average = average;
  if (declared && measured !== undefined) {
    const rate = declared.num / declared.den;
    out.variable = Math.abs(measured - rate) / rate > VFR_TOLERANCE;
  }
  return out;
}

/**
 * How long the picture runs, which is not how long the file runs.
 *
 * Matroska and WebM give a stream no `duration` of their own, and the file's
 * lasts until its longest stream ends. The frames were counted over the file's,
 * so a constant 30 fps WebM whose audio ran a second past its picture — 90
 * frames in 3.000 s, the file 4.008 s, which is what a screen recorder that stops
 * the picture first writes — measured 22.45 fps and was called variable-rate.
 * The muxer does write the picture's own length, as a `DURATION` tag
 * (`DURATION-eng` when mkvmerge names a language); only past that is the file's
 * length the best there is.
 */
function pictureSeconds(video: FfprobeStream, parsed: FfprobeOutput): number {
  if (Number(video.duration) > 0) return Number(video.duration);
  const tagged = Object.entries(video.tags ?? {}).find(([key]) => /^DURATION(-\w+)?$/i.test(key));
  const clock = tagged ? parseClock(tagged[1]) : undefined;
  if (clock !== undefined && clock > 0) return clock;
  return Number(parsed.format?.duration);
}

/** `00:00:03.000000000` as seconds, or nothing for anything else. */
function parseClock(value: string): number | undefined {
  const match = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Parses ffprobe's `30000/1001` form, keeping the exact rational. */
export function parseRational(value: string | undefined): { num: number; den: number } | undefined {
  if (!value) return undefined;
  const [numRaw, denRaw] = value.split('/');
  const num = Number(numRaw);
  const den = denRaw === undefined ? 1 : Number(denRaw);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return undefined;
  return { num, den };
}
