import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareText } from '@editorial-ir/contracts';
import type { AnalyzeVideoParams, AnalyzeVideoResult } from '@editorial-ir/contracts';
import type { CommandRunner } from '../command.js';
import { NodeCommandRunner } from '../command.js';
import type { ModelIdentity, VideoModel } from '../types.js';

/**
 * How much the picture moves, and where it is black, with nothing but ffmpeg.
 *
 * The visual twin of the WAV analyser, and the half of "nothing is happening
 * here" that did not exist: silence was measured, stillness was not. Its only
 * job is to tell the expensive stages where they need not look, so it has to
 * cost almost nothing — a 64x36 greyscale decode at five samples a second, about
 * 1% of real time on a 480p proxy — and it has to fail towards "moving", because
 * a moment wrongly called still loses content and one wrongly called moving
 * only costs a few tokens.
 *
 * ## Why these numbers
 *
 * Measured on real footage and on a still frame looped with synthetic grain
 * (see `STATIC_MOTION_THRESHOLD` in the contracts):
 *
 * - The downscale is what separates grain from motion. Sensor noise is
 *   independent per pixel and averages away over a 30x30 block; a person does
 *   not. `flags=area` is the averaging filter; bilinear would sample instead.
 * - The largest cell of a 3x4 grid rather than the whole-frame mean, so a person
 *   crossing one corner of a wide shot still counts.
 * - The 98th-percentile luma for black rather than the mean, so a city at night
 *   is not black.
 */
export const MOTION_WIDTH = 64;
export const MOTION_HEIGHT = 36;
const GRID_ROWS = 3;
const GRID_COLS = 4;

export interface FfmpegVideoAnalyzerOptions {
  runner?: CommandRunner;
  binary?: string;
  timeoutMs?: number;
  /** Where the raw samples are written while they are read. Defaults to the OS temp dir. */
  scratchDir?: string;
}

export class FfmpegVideoAnalyzer implements VideoModel {
  readonly identity: ModelIdentity;
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly scratchDir: string | undefined;

  constructor(options: FfmpegVideoAnalyzerOptions = {}) {
    this.runner = options.runner ?? new NodeCommandRunner();
    this.binary = options.binary ?? 'ffmpeg';
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.scratchDir = options.scratchDir;
    this.identity = {
      backend: 'ffmpeg-motion',
      model: 'cell-max-64x36',
      modelVersion: '1',
      locality: 'local',
      mediaLeavesDevice: false,
      parameters: { width: MOTION_WIDTH, height: MOTION_HEIGHT, grid: `${GRID_ROWS}x${GRID_COLS}` },
    };
  }

  async available(): Promise<boolean> {
    return this.runner.available(this.binary);
  }

  async analyzeVideo(params: AnalyzeVideoParams): Promise<AnalyzeVideoResult> {
    const dir = mkdtempSync(join(this.scratchDir ?? tmpdir(), 'oea-motion-'));
    const out = join(dir, 'samples.gray');
    try {
      await this.runner.run(this.binary, motionArgs(params.path, params.sample_fps, out), {
        timeoutMs: this.timeoutMs,
      });
      let samples: Uint8Array;
      try {
        samples = readFileSync(out);
      } catch {
        // No picture at all, or a runner that does not write files (tests):
        // nothing measured, which reads downstream as "unknown", never "still".
        samples = new Uint8Array(0);
      }
      return analyseSamples(samples, params);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function motionArgs(input: string, fps: number, output: string): string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    '-i',
    input,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `fps=${fps},scale=${MOTION_WIDTH}:${MOTION_HEIGHT}:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-y',
    output,
  ];
}

/**
 * The whole decision surface, on plain bytes: one greyscale 64x36 frame after
 * another, as ffmpeg's `rawvideo` writes them.
 */
export function analyseSamples(
  samples: Uint8Array,
  params: AnalyzeVideoParams,
): AnalyzeVideoResult {
  const frameSize = MOTION_WIDTH * MOTION_HEIGHT;
  const count = Math.floor(samples.length / frameSize);
  const hopMs = Math.max(1, Math.round(1000 / params.sample_fps));

  const motion: number[] = [];
  const luma: number[] = [];
  const peak: number[] = [];
  for (let i = 0; i < count; i++) {
    const frame = samples.subarray(i * frameSize, (i + 1) * frameSize);
    const stats = lumaOf(frame);
    luma.push(round(stats.mean, 2));
    peak.push(stats.p98);
    if (i === 0) {
      motion.push(0);
      continue;
    }
    motion.push(
      round(cellMaxDifference(samples.subarray((i - 1) * frameSize, i * frameSize), frame), 3),
    );
  }
  // The first sample has nothing to differ from. Give it its successor's value
  // rather than zero, so a file never opens with a fabricated moment of stillness.
  if (motion.length > 1) motion[0] = motion[1]!;

  const events: AnalyzeVideoResult['events'] = [];
  for (const run of runs(motion.map((m) => m < params.static_threshold))) {
    const startMs = run.start * hopMs;
    const endMs = run.end * hopMs;
    if (endMs - startMs < params.min_static_ms) continue;
    const mean = average(motion.slice(run.start, run.end));
    events.push({
      start_ms: startMs,
      end_ms: endMs,
      event_type: 'static',
      // Further below the threshold is surer. Never certain: a still frame and a
      // very slow pan look alike over three seconds.
      confidence: round(clamp(1 - mean / params.static_threshold, 0.5, 0.95), 3),
    });
  }
  for (const run of runs(peak.map((p) => p < params.black_luma))) {
    const startMs = run.start * hopMs;
    const endMs = run.end * hopMs;
    if (endMs - startMs < params.min_black_ms) continue;
    events.push({ start_ms: startMs, end_ms: endMs, event_type: 'black', confidence: 0.9 });
  }
  events.sort((a, b) => a.start_ms - b.start_ms || compareText(a.event_type, b.event_type));

  return { model: 'cell-max-64x36', hop_ms: hopMs, motion, luma, events };
}

/** Largest mean absolute difference of any grid cell, in grey levels. */
export function cellMaxDifference(previous: Uint8Array, current: Uint8Array): number {
  const cellW = MOTION_WIDTH / GRID_COLS;
  const cellH = MOTION_HEIGHT / GRID_ROWS;
  let largest = 0;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      let sum = 0;
      for (let y = row * cellH; y < (row + 1) * cellH; y++) {
        const offset = y * MOTION_WIDTH;
        for (let x = col * cellW; x < (col + 1) * cellW; x++) {
          sum += Math.abs(current[offset + x]! - previous[offset + x]!);
        }
      }
      largest = Math.max(largest, sum / (cellW * cellH));
    }
  }
  return largest;
}

function lumaOf(frame: Uint8Array): { mean: number; p98: number } {
  const histogram = new Uint32Array(256);
  let sum = 0;
  for (const value of frame) {
    histogram[value]!++;
    sum += value;
  }
  const target = Math.ceil(frame.length * 0.98);
  let seen = 0;
  let p98 = 255;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]!;
    if (seen >= target) {
      p98 = v;
      break;
    }
  }
  return { mean: frame.length === 0 ? 0 : sum / frame.length, p98 };
}

function runs(flags: readonly boolean[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i]!;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push({ start, end: i });
      start = -1;
    }
  }
  return out;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
