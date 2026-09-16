import type { DetectShotsParams, DetectShotsResult } from '@editorial-ir/contracts';
import type { CommandRunner } from '../command.js';
import { NodeCommandRunner } from '../command.js';
import type { ModelIdentity, ShotDetector } from '../types.js';

/**
 * Shot detection with nothing but ffmpeg.
 *
 * ffmpeg's `scene` metric already measures frame-to-frame content change, so a
 * `select` plus `showinfo` pass gives boundaries without PySceneDetect, without
 * Python and without a GPU. That matters more than it sounds: shot boundaries
 * are the scaffolding for event segmentation, so a machine that can run ffmpeg
 * can compile a usable IR.
 */
export interface FfmpegShotOptions {
  runner?: CommandRunner;
  binary?: string;
  timeoutMs?: number;
}

export class FfmpegShotDetector implements ShotDetector {
  readonly identity: ModelIdentity;
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(options: FfmpegShotOptions = {}) {
    this.runner = options.runner ?? new NodeCommandRunner();
    this.binary = options.binary ?? 'ffmpeg';
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.identity = {
      backend: 'ffmpeg-scene',
      model: 'scene-select',
      locality: 'local',
      mediaLeavesDevice: false,
    };
  }

  async available(): Promise<boolean> {
    return this.runner.available(this.binary);
  }

  async detectShots(params: DetectShotsParams): Promise<DetectShotsResult> {
    const { stderr } = await this.runner.run(
      this.binary,
      sceneArgs(params.path, params.threshold),
      {
        timeoutMs: this.timeoutMs,
        allowFailure: true,
      },
    );
    const boundaries = parseShowinfoTimes(stderr);
    const durationMs = await this.probeDurationMs(params.path);
    return {
      model: 'ffmpeg-scene',
      shots: buildShots(boundaries, durationMs, params.min_shot_ms),
    };
  }

  private async probeDurationMs(path: string): Promise<number> {
    const { stderr } = await this.runner.run(this.binary, ['-hide_banner', '-i', path], {
      timeoutMs: 60_000,
      allowFailure: true,
    });
    const match = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr);
    if (!match) return 0;
    const [, h, m, s, cs] = match;
    return (
      Number(h) * 3_600_000 +
      Number(m) * 60_000 +
      Number(s) * 1000 +
      Number((cs ?? '0').padEnd(3, '0'))
    );
  }
}

export function sceneArgs(input: string, threshold: number): string[] {
  return [
    '-hide_banner',
    '-i',
    input,
    '-filter:v',
    `select='gt(scene,${threshold})',showinfo`,
    '-an',
    '-f',
    'null',
    '-',
  ];
}

/** Pulls `pts_time:` values out of showinfo's log lines. */
export function parseShowinfoTimes(stderr: string): number[] {
  const times: number[] = [];
  const re = /pts_time:([0-9.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds)) times.push(Math.round(seconds * 1000));
  }
  return times;
}

/**
 * Turns boundary instants into shots.
 *
 * Boundaries closer together than `minShotMs` are dropped rather than merged
 * into a sliver: a 200 ms "shot" is a flash frame or a compression artefact, and
 * carrying it forward would poison the event segmentation that reads shot counts.
 */
export function buildShots(
  boundaryMs: number[],
  durationMs: number,
  minShotMs: number,
): { start_ms: number; end_ms: number; representative_frame_ms: number; change_score?: number }[] {
  const cuts = [0, ...boundaryMs.filter((t) => t > 0 && (durationMs === 0 || t < durationMs))].sort(
    (a, b) => a - b,
  );

  const kept: number[] = [];
  for (const cut of cuts) {
    const last = kept[kept.length - 1];
    if (last === undefined || cut - last >= minShotMs) kept.push(cut);
  }

  const end = durationMs > 0 ? durationMs : (kept[kept.length - 1] ?? 0) + minShotMs;
  const shots: { start_ms: number; end_ms: number; representative_frame_ms: number }[] = [];
  for (let i = 0; i < kept.length; i++) {
    const start = kept[i] ?? 0;
    const stop = i + 1 < kept.length ? (kept[i + 1] ?? end) : end;
    if (stop <= start) continue;
    shots.push({
      start_ms: start,
      end_ms: stop,
      // A third of the way in: past the transition, before the camera moves on.
      representative_frame_ms: start + Math.floor((stop - start) / 3),
    });
  }
  return shots;
}
