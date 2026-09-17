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
 */
export interface FfprobeOptions {
  runner?: CommandRunner;
  binary?: string;
  timeoutMs?: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  duration?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

interface FfprobeOutput {
  format?: {
    duration?: string;
    format_name?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams?: FfprobeStream[];
}

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
      locality: 'local',
      mediaLeavesDevice: false,
    };
  }

  async available(): Promise<boolean> {
    return this.runner.available(this.binary);
  }

  async probe(path: string): Promise<ProbeResult> {
    const { stdout } = await this.runner.run(
      this.binary,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      { timeoutMs: this.timeoutMs },
    );
    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch {
      throw new EditorialError('media_error', `ffprobe returned output that is not JSON`, { path });
    }
    return parseOrThrow(ProbeResultSchema, toProbeResult(parsed), `ffprobe output for ${path}`);
  }
}

/** Exported so the mapping can be tested without running ffprobe. */
export function toProbeResult(parsed: FfprobeOutput): unknown {
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  const durationSec = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  const fps = parseRational(video?.avg_frame_rate ?? video?.r_frame_rate);

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
  if (fps) {
    result.fps_num = fps.num;
    result.fps_den = fps.den;
  }
  if (video?.codec_name) result.video_codec = video.codec_name;
  if (audio?.codec_name) result.audio_codec = audio.codec_name;
  if (audio?.channels) result.audio_channels = audio.channels;
  if (audio?.sample_rate) result.audio_sample_rate = Number(audio.sample_rate);
  if (parsed.format?.format_name) result.container = parsed.format.format_name;
  if (parsed.format?.bit_rate) result.bit_rate = Number(parsed.format.bit_rate);
  if (rotation !== undefined && Number.isFinite(rotation)) {
    result.rotation = ((Math.round(rotation) % 360) + 360) % 360;
  }
  if (creation) result.creation_time = creation;
  return result;
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
