import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrepareParams, PrepareResult } from '@editorial-ir/contracts';
import type { CommandRunner } from '../command.js';
import { NodeCommandRunner } from '../command.js';
import type { MediaPreparer, ModelIdentity } from '../types.js';

/**
 * Cheap derivatives, made once and reused by everything downstream.
 *
 * The originals are never touched. Everything here is regenerable from the
 * source file, which is what makes the work directory safe to delete and safe to
 * cache by content hash.
 */
export interface FfmpegPrepareOptions {
  runner?: CommandRunner;
  binary?: string;
  timeoutMs?: number;
  /** Constant rate factor for the proxy. Higher is smaller and uglier. */
  crf?: number;
}

export class FfmpegMediaPreparer implements MediaPreparer {
  readonly identity: ModelIdentity;
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly crf: number;

  constructor(options: FfmpegPrepareOptions = {}) {
    this.runner = options.runner ?? new NodeCommandRunner();
    this.binary = options.binary ?? 'ffmpeg';
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.crf = options.crf ?? 28;
    this.identity = {
      backend: 'ffmpeg',
      model: this.binary,
      locality: 'local',
      mediaLeavesDevice: false,
      parameters: { crf: this.crf },
    };
  }

  async available(): Promise<boolean> {
    return this.runner.available(this.binary);
  }

  async prepare(params: PrepareParams): Promise<PrepareResult> {
    mkdirSync(params.work_dir, { recursive: true });
    const result: PrepareResult = { frame_timestamps_ms: [] };

    if (params.proxy_height > 0) {
      const proxyPath = join(params.work_dir, 'proxy.mp4');
      await this.runner.run(
        this.binary,
        proxyArgs(params.path, proxyPath, params.proxy_height, this.crf),
        {
          timeoutMs: this.timeoutMs,
        },
      );
      result.proxy_path = proxyPath;
    }

    if (params.extract_audio) {
      const audioPath = join(params.work_dir, 'audio.wav');
      await this.runner.run(this.binary, audioArgs(params.path, audioPath), {
        timeoutMs: this.timeoutMs,
      });
      result.audio_path = audioPath;
    }

    if (params.frame_fps > 0) {
      const framesDir = join(params.work_dir, 'frames');
      mkdirSync(framesDir, { recursive: true });
      await this.runner.run(this.binary, frameArgs(params.path, framesDir, params.frame_fps), {
        timeoutMs: this.timeoutMs,
      });
      result.frames_dir = framesDir;
    }

    return result;
  }
}

/** Audio for analysis: mono, 16 kHz, uncompressed. What every ASR wants. */
export const AUDIO_SAMPLE_RATE = 16_000;

export function proxyArgs(input: string, output: string, height: number, crf: number): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    // -2 keeps the width even, which h264 requires.
    '-vf',
    `scale=-2:${height}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(crf),
    '-an',
    '-movflags',
    '+faststart',
    output,
  ];
}

export function audioArgs(input: string, output: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(AUDIO_SAMPLE_RATE),
    // Keep the audio on the file's clock. A track with gaps in its timestamps —
    // a screen recorder that dropped audio packets, a phone that paused its
    // encoder — was concatenated, so everything after the first gap came out
    // early: measured on a 60 s capture with six 2 s gaps, a 48 s WAV and speech
    // found up to 12 s before it was said. Every transcript time, every silence
    // and every cut point derived from it was wrong by that much, silently.
    // `async=1` fills a gap with silence instead; `first_pts=0` pads a track
    // that starts late, so 0 in the WAV is 0 in the video.
    '-af',
    'aresample=async=1:first_pts=0',
    '-c:a',
    'pcm_s16le',
    output,
  ];
}

export function frameArgs(input: string, framesDir: string, fps: number): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vf',
    `fps=${fps}`,
    '-q:v',
    '4',
    join(framesDir, '%08d.jpg'),
  ];
}

/**
 * Timestamp of the nth sampled frame.
 *
 * ffmpeg's `fps` filter emits the frame nearest each 1/fps boundary, starting at
 * zero, so index i lands at i/fps seconds. Frame files are 1-based.
 */
export function frameTimestampMs(index1Based: number, fps: number): number {
  return Math.round(((index1Based - 1) * 1000) / fps);
}

export function frameFileName(index1Based: number): string {
  return `${String(index1Based).padStart(8, '0')}.jpg`;
}
