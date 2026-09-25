import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import {
  AdapterCapabilities,
  EditorialError,
  compareText,
  type ApplyResult,
  type EditPlan,
  type MediaAsset,
} from '@editorial-ir/contracts';
import type { ApplyRequest, EditorAdapter } from './types.js';
import { booleanOption, negotiate, numberOption, resolveAssetPath } from './types.js';
import {
  assetById,
  bedSpan,
  clipAudio,
  layOnGrid,
  pictureOf,
  recordersOf,
  streamOf,
  type FrameRate,
  type GridSpan,
} from './timeline.js';
import { buildSrt, captionCues } from './subtitles.js';

/**
 * A rendered preview of the cut: a small mp4 anyone can play.
 *
 * Every other adapter writes a file for an editing application, and the only
 * way to see the cut is to own that application and import it. This one runs
 * ffmpeg over the original media and hands back the edit itself, at 640 pixels
 * wide by default — enough to judge a cut, cheap enough to make every time one
 * is planned.
 *
 * Each clip is rendered on its own, seeking straight to its in point, and the
 * pieces are joined without re-encoding. One filter graph over a whole cut hits
 * command-line and graph limits at a few dozen clips, and a clip rendered alone
 * lands on exactly the frames the NLE files give it: the preview is laid on the
 * same grid (`layOnGrid`), so its length matches the plan to the frame.
 *
 * Sound is kept as PCM until the last step. AAC adds encoder priming to every
 * piece, and joining pieces that each start with a few milliseconds of it
 * drifts the sound against the picture by that much at every cut.
 */
export const PREVIEW_CAPABILITIES: AdapterCapabilities = AdapterCapabilities.parse({
  id: 'preview',
  name: 'Preview render (ffmpeg)',
  mode: 'file',
  output_extensions: ['.preview.mp4'],
  text: false,
  captions: true,
  markers: true,
  basic_transition: true,
  transition_types: ['fade_in', 'fade_out'],
  keyframes: false,
  masking: false,
  nested_sequence: false,
  speed_change: false,
  still_images: true,
  color_adjustment: false,
  audio_tracks: 2,
  max_video_tracks: 4,
  reads_back_timeline: false,
  renders_preview: true,
  notes: [
    'Renders the cut with ffmpeg to a small mp4 (640 px wide by default, the sequence’s frame rate, AAC sound).',
    'Hard cuts; fades from and to black are rendered, dissolves become cuts and are reported. The top track’s picture wins where tracks overlap.',
    'Captions are burned in when this ffmpeg has the subtitles filter, and written beside the mp4 as .srt when it does not. Chapters become mp4 chapters.',
    'Options: width (pixels, default 640), burn_captions (true/false), jobs (pieces rendered at once), keep_work (keep the rendered pieces).',
  ],
});

/* -------------------------------------------------------------------------- */
/* Running programs                                                            */
/* -------------------------------------------------------------------------- */

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * The one way this adapter runs a program, injected so the preview can be
 * tested with no ffmpeg — the same shape as the perception package's runner,
 * which this package does not depend on.
 */
export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<CommandResult>;
}

/** Runs a real program. A missing one answers with code 127 rather than throwing. */
export class ProcessCommandRunner implements CommandRunner {
  run(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 0,
          maxBuffer: 16 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr, code: 0 });
            return;
          }
          const code =
            error.code === 'ENOENT' ? 127 : typeof error.code === 'number' ? error.code : 1;
          resolve({ stdout, stderr: stderr || error.message, code });
        },
      );
    });
  }
}

export interface PreviewSettings {
  runner?: CommandRunner;
  ffmpeg?: string;
  ffprobe?: string;
  /** Pieces rendered at once. */
  concurrency?: number;
}

/* -------------------------------------------------------------------------- */
/* What to render                                                              */
/* -------------------------------------------------------------------------- */

/** One piece of the preview: a stretch of the timeline with one picture and one sound. */
export interface PreviewSegment {
  /** First frame on the timeline. */
  start: number;
  frames: number;
  /** Sample range on the timeline, placed from absolute positions so pieces never drift. */
  sampleStart: number;
  samples: number;
  picture:
    | { kind: 'video'; path: string; seconds: number; operation: string }
    | { kind: 'still'; path: string; operation: string }
    | { kind: 'black' };
  sound:
    | {
        kind: 'file';
        path: string;
        seconds: number;
        stream: number;
        sameInput: boolean;
        operation: string;
      }
    | { kind: 'silence' };
  /** Frames of fade from black at the start, and to black at the end. */
  fadeIn: number;
  fadeOut: number;
}

/**
 * The cut as a run of pieces, each one picture and one sound.
 *
 * Tracks are flattened the way an editor's viewer does it: where two tracks
 * overlap, the higher one's picture is shown, and the sound is the highest clip
 * there that has sound and uses it — a cutaway on V2 over a narrator on V1 shows
 * the cutaway and plays the narrator. Where nothing is there, the piece is
 * black and silent, so a gap in the plan is a gap in the preview rather than a
 * jump.
 */
export function previewSegments(
  plan: EditPlan,
  assets: readonly MediaAsset[],
  resolve: (assetId: string) => string | undefined,
  warnings: string[] = [],
): { segments: PreviewSegment[]; frames: number; rate: FrameRate } {
  const grid = layOnGrid(plan);
  const rate = grid.rate;
  const sampleRate = plan.sequence.sample_rate;
  const sampleAt = (frame: number): number =>
    Math.round((frame * sampleRate * rate.den) / rate.num);
  const seconds = (frames: number): number => (frames * rate.den) / rate.num;

  interface Laid {
    span: GridSpan;
    track: number;
    asset: MediaAsset;
    path: string;
    picture: 'video' | 'still' | 'none';
    /**
     * Where the clip's sound is read: its own file, or the recorder that heard
     * it, from that file's frame at the clip's first frame.
     */
    sound: { path: string; in: number; stream: number; separate: boolean } | undefined;
  }
  // Only media ffmpeg can read: a recorder it cannot open gives way to the
  // camera's own sound, rather than failing the piece.
  const readable = (id: string): MediaAsset | undefined => {
    const asset = assetById(assets, id);
    return asset && resolve(asset.id) ? asset : undefined;
  };
  const laid: Laid[] = [];
  for (const [track, spans] of grid.tracks) {
    for (const span of spans) {
      const asset = assetById(assets, span.operation.source_asset_id);
      const path = asset ? resolve(asset.id) : undefined;
      if (!asset || !path) {
        warnings.push(
          `${span.operation.operation_id} refers to ${span.operation.source_asset_id}, which has no readable file; it is black and silent in the preview`,
        );
        continue;
      }
      const audio = clipAudio(span, readable, rate, warnings);
      laid.push({
        span,
        track,
        asset,
        path,
        picture: pictureOf(asset),
        sound: audio && {
          path: resolve(audio.asset.id)!,
          in: audio.in,
          stream: audio.sound.stream,
          separate: audio.separate,
        },
      });
    }
  }

  const cuts = new Set<number>([0, grid.length]);
  for (const item of laid) {
    cuts.add(item.span.start);
    cuts.add(item.span.end);
  }
  const edges = [...cuts].filter((f) => f >= 0 && f <= grid.length).sort((a, b) => a - b);

  const topmost = (candidates: Laid[]): Laid | undefined =>
    [...candidates].sort((a, b) => b.track - a.track)[0];

  const segments: PreviewSegment[] = [];
  let previousKey = '';
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    if (to <= from) continue;
    const covering = laid.filter((item) => item.span.start <= from && from < item.span.end);
    const pictureItem = topmost(covering.filter((item) => item.picture !== 'none'));
    const soundItem = topmost(covering.filter((item) => item.sound !== undefined));
    const key = `${pictureItem?.span.operation.operation_id ?? '-'}|${soundItem?.span.operation.operation_id ?? '-'}`;

    const previous = segments.at(-1);
    if (previous && key === previousKey && previous.start + previous.frames === from) {
      previous.frames += to - from;
      previous.samples = sampleAt(previous.start + previous.frames) - previous.sampleStart;
      continue;
    }
    previousKey = key;

    const offsetIn = (item: Laid): number => seconds(item.span.in + (from - item.span.start));
    const picture: PreviewSegment['picture'] = !pictureItem
      ? { kind: 'black' }
      : pictureItem.picture === 'still'
        ? {
            kind: 'still',
            path: pictureItem.path,
            operation: pictureItem.span.operation.operation_id,
          }
        : {
            kind: 'video',
            path: pictureItem.path,
            seconds: offsetIn(pictureItem),
            operation: pictureItem.span.operation.operation_id,
          };
    // A recorder's sound is another input, however the picture is read.
    const heard = soundItem?.sound;
    const sound: PreviewSegment['sound'] =
      !soundItem || !heard
        ? { kind: 'silence' }
        : {
            kind: 'file',
            path: heard.path,
            seconds: seconds(heard.in + (from - soundItem.span.start)),
            stream: heard.stream,
            sameInput:
              soundItem === pictureItem && pictureItem.picture === 'video' && !heard.separate,
            operation: soundItem.span.operation.operation_id,
          };
    segments.push({
      start: from,
      frames: to - from,
      sampleStart: sampleAt(from),
      samples: sampleAt(to) - sampleAt(from),
      picture,
      sound,
      fadeIn: 0,
      fadeOut: 0,
    });
  }

  // Fades belong to the clip that asked for them, at its own ends.
  for (const item of laid) {
    const operation = item.span.operation;
    const fadeIn =
      operation.transition_in?.type === 'fade_in' ? operation.transition_in : undefined;
    const fadeOut =
      operation.transition_out?.type === 'fade_out' ? operation.transition_out : undefined;
    if (fadeIn && fadeIn.duration_ms > 0) {
      const segment = segments.find((s) => s.start === item.span.start);
      if (segment)
        segment.fadeIn = Math.min(segment.frames, Math.max(1, grid.frames(fadeIn.duration_ms)));
    }
    if (fadeOut && fadeOut.duration_ms > 0) {
      const segment = segments.find((s) => s.start + s.frames === item.span.end);
      if (segment)
        segment.fadeOut = Math.min(segment.frames, Math.max(1, grid.frames(fadeOut.duration_ms)));
    }
  }

  return { segments, frames: grid.length, rate };
}

/** The frame size of the preview: `width` wide, the sequence's shape, both even. */
export function previewSize(plan: EditPlan, width: number): { width: number; height: number } {
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  const w = even(Math.min(width, plan.sequence.width));
  return { width: w, height: even((w * plan.sequence.height) / plan.sequence.width) };
}

/**
 * ffmpeg's arguments for one piece.
 *
 * Seeking is on the input (`-ss` before `-i`), which since ffmpeg 2.1 is
 * frame-accurate when re-encoding and does not decode the file from the start —
 * the difference between a preview in seconds and one in minutes on a long
 * recording. The picture is made constant-rate at the sequence rate, fitted
 * inside the frame without stretching, padded with the last frame if the source
 * runs out early and cut at exactly the piece's frame count; the sound is
 * resampled, padded with silence and cut at exactly its sample count.
 */
export function segmentArgs(
  segment: PreviewSegment,
  settings: {
    width: number;
    height: number;
    rate: FrameRate;
    sampleRate: number;
    /** Burn these captions in, read from this file relative to the working directory. */
    captions?: string;
  },
  output: string,
): string[] {
  const { width, height, rate, sampleRate } = settings;
  const fps = `${rate.num}/${rate.den}`;
  const duration = (segment.frames * rate.den) / rate.num;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];

  if (segment.picture.kind === 'video') {
    args.push('-ss', segment.picture.seconds.toFixed(6), '-i', segment.picture.path);
  } else if (segment.picture.kind === 'still') {
    // Read once and repeated in the filter graph. `-loop 1` on the input
    // decodes the file again for every frame, and a phone photograph is twelve
    // megapixels: measured, 7.8 s to render three seconds of one 4032x3024 JPEG
    // that way, 0.37 s scaled once and looped.
    args.push('-i', segment.picture.path);
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`);
  }

  let audioInput: string;
  if (segment.sound.kind === 'file' && segment.sound.sameInput) {
    audioInput = `0:a:${segment.sound.stream}`;
  } else if (segment.sound.kind === 'file') {
    args.push('-ss', segment.sound.seconds.toFixed(6), '-i', segment.sound.path);
    audioInput = `1:a:${segment.sound.stream}`;
  } else {
    args.push('-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=stereo`);
    audioInput = '1:a';
  }

  const fit = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    'format=yuv420p',
  ];
  const video =
    segment.picture.kind === 'still'
      ? [...fit, 'loop=loop=-1:size=1:start=0', `fps=${fps}`]
      : [`fps=${fps}`, ...fit, `tpad=stop_mode=clone:stop_duration=${Math.ceil(duration + 1)}`];
  video.push(`trim=end_frame=${segment.frames}`, 'setpts=PTS-STARTPTS');
  const audio = [
    `aresample=${sampleRate}`,
    'aformat=sample_fmts=s16:channel_layouts=stereo',
    'apad',
    `atrim=end_sample=${segment.samples}`,
    'asetpts=PTS-STARTPTS',
  ];
  const fade = (frames: number) => ((frames * rate.den) / rate.num).toFixed(6);
  if (segment.fadeIn > 0) {
    video.push(`fade=t=in:st=0:d=${fade(segment.fadeIn)}`);
    audio.push(`afade=t=in:st=0:d=${fade(segment.fadeIn)}`);
  }
  if (segment.fadeOut > 0) {
    const from = fade(segment.frames - segment.fadeOut);
    video.push(`fade=t=out:st=${from}:d=${fade(segment.fadeOut)}`);
    audio.push(`afade=t=out:st=${from}:d=${fade(segment.fadeOut)}`);
  }
  if (settings.captions) {
    // The captions are timed to the whole cut, so the piece is moved to where it
    // sits in it, drawn on, and moved back.
    const offset = ((segment.start * rate.den) / rate.num).toFixed(6);
    video.push(
      `setpts=PTS+${offset}/TB`,
      `subtitles=filename=${settings.captions}`,
      'setpts=PTS-STARTPTS',
    );
  }

  args.push(
    '-filter_complex',
    `[0:v]${video.join(',')}[v];[${audioInput}]${audio.join(',')}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-frames:v',
    String(segment.frames),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '26',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'pcm_s16le',
    '-ar',
    String(sampleRate),
    '-ac',
    '2',
    output,
  );
  return args;
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

export class PreviewAdapter implements EditorAdapter {
  readonly capabilities = PREVIEW_CAPABILITIES;
  private readonly runner: CommandRunner;
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly concurrency: number;
  private subtitlesFilter: Promise<boolean> | undefined;

  constructor(settings: PreviewSettings = {}) {
    this.runner = settings.runner ?? new ProcessCommandRunner();
    this.ffmpeg = settings.ffmpeg ?? process.env.OEA_FFMPEG ?? 'ffmpeg';
    this.ffprobe = settings.ffprobe ?? process.env.OEA_FFPROBE ?? 'ffprobe';
    // Measured on a 2:40 cut of 20 clips from six sample files (1080p, 432p
    // and 404p at 12, 24, 30 and 59.94 fps) on a 4-CPU machine: one piece at a
    // time 21.9–24.0 s, two 19.6 s, four 12.2–12.5 s, eight 12.3 s. Each ffmpeg
    // keeps about one core busy, so nothing is gained past the CPU count. The
    // default is capped at four, the most that was measured to pay; `jobs`
    // raises it on a bigger machine.
    this.concurrency = Math.max(1, settings.concurrency ?? Math.min(4, availableParallelism()));
  }

  async available(): Promise<boolean> {
    const result = await this.runner.run(this.ffmpeg, ['-hide_banner', '-version'], {
      timeoutMs: 10_000,
    });
    return result.code === 0;
  }

  /** Whether this ffmpeg can draw captions: the subtitles filter needs libass. */
  canBurnCaptions(): Promise<boolean> {
    this.subtitlesFilter ??= this.runner
      .run(this.ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 10_000 })
      .then((result) => result.code === 0 && /^\s*\S*\s+subtitles\s/m.test(result.stdout));
    return this.subtitlesFilter;
  }

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    if (!(await this.available())) {
      throw new EditorialError(
        'adapter_failed',
        `the preview needs ffmpeg, and "${this.ffmpeg}" could not be run`,
        { install: 'macOS: brew install ffmpeg, Debian/Ubuntu: apt install ffmpeg' },
      );
    }
    const { plan, downgrades } = negotiate(request.plan, this.capabilities, request.ir.assets);
    const warnings: string[] = [];
    const name = request.name ?? 'timeline';
    mkdirSync(request.outputDir, { recursive: true });
    const work = join(request.outputDir, `.${name}.preview-work`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });

    // Every file is opened once before anything is rendered. A file ffmpeg
    // cannot read failed its first piece and took the whole preview down with
    // it — the worked example's footage is stand-ins, and the first thing the
    // preview said about them was "Invalid data found when processing input"
    // for piece 4. A cut with one unreadable file is still worth seeing, with
    // that file's clips black and named; one where nothing can be read is not.
    const used = new Set<string>();
    for (const operation of plan.tracks.video) {
      const path = resolveAssetPath(request, operation.source_asset_id);
      if (path) used.add(path);
    }
    // And the recorders clips take their sound from, which no clip's picture
    // names: one ffmpeg cannot read is warned about here, and the clips it was
    // the sound of play their own.
    for (const id of recordersOf(plan)) {
      const path = resolveAssetPath(request, id);
      if (path) used.add(path);
    }
    const unreadable = await this.unreadable([...used].sort(compareText));
    for (const [path, reason] of unreadable) {
      warnings.push(
        `ffmpeg cannot read ${path} (${reason}); its clips are black and silent in the preview`,
      );
    }
    if (used.size > 0 && unreadable.size === used.size) {
      throw new EditorialError(
        'adapter_failed',
        'ffmpeg cannot read any of the media this cut uses, so there is nothing to render',
        { first: [...unreadable.entries()][0]!.join(': ') },
      );
    }

    const { segments, frames, rate } = previewSegments(
      plan,
      request.ir.assets,
      (id) => {
        const path = resolveAssetPath(request, id);
        return path && !unreadable.has(path) ? path : undefined;
      },
      warnings,
    );
    if (segments.length === 0) {
      throw new EditorialError('adapter_failed', 'the plan has nothing on its timeline to render');
    }
    const size = previewSize(plan, numberOption(request, 'width', 640));
    const artifacts: ApplyResult['artifacts'] = [];

    // Captions: drawn on when this ffmpeg can, and beside the mp4 when it
    // cannot, so a build without libass still gives the words.
    const cues = captionCues(plan);
    let burn: string | undefined;
    if (cues.length > 0) {
      const wanted = booleanOption(request, 'burn_captions', true);
      if (wanted && (await this.canBurnCaptions())) {
        writeFileSync(join(work, 'captions.srt'), buildSrt(plan));
        burn = 'captions.srt';
      } else {
        const sidecar = join(request.outputDir, `${name}.preview.srt`);
        writeFileSync(sidecar, buildSrt(plan));
        if (wanted) {
          warnings.push(
            'this ffmpeg has no subtitles filter (it is built without libass), so the captions are beside the preview instead of on it',
          );
        }
        artifacts.push({
          path: sidecar,
          kind: 'subtitles',
          description: `${cues.length} caption(s) for the preview.`,
          byte_size: statSync(sidecar).size,
        });
      }
    }

    const pieces = segments.map((_, index) => `piece-${String(index + 1).padStart(4, '0')}.mov`);
    let next = 0;
    const failures: string[] = [];
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= segments.length || failures.length > 0) return;
        const args = segmentArgs(
          segments[index]!,
          {
            width: size.width,
            height: size.height,
            rate,
            sampleRate: plan.sequence.sample_rate,
            ...(burn ? { captions: burn } : {}),
          },
          pieces[index]!,
        );
        const result = await this.runner.run(this.ffmpeg, args, { cwd: work });
        if (result.code !== 0) failures.push(`piece ${index + 1}: ${tail(result.stderr)}`);
      }
    };
    const jobs = Math.max(1, Math.round(numberOption(request, 'jobs', this.concurrency)));
    await Promise.all(Array.from({ length: Math.min(jobs, segments.length) }, worker));
    if (failures.length > 0) {
      throw new EditorialError(
        'adapter_failed',
        `ffmpeg could not render the preview: ${failures[0]}`,
        {
          work,
        },
      );
    }

    writeFileSync(join(work, 'pieces.txt'), pieces.map((piece) => `file '${piece}'\n`).join(''));
    const output = join(request.outputDir, `${name}.preview.mp4`);
    const finalArgs = this.finalArgs(plan, request, work, output, warnings);
    const final = await this.runner.run(this.ffmpeg, finalArgs, { cwd: work });
    if (final.code !== 0) {
      throw new EditorialError(
        'adapter_failed',
        `ffmpeg could not join the preview: ${tail(final.stderr)}`,
        {
          work,
        },
      );
    }

    const measured = await this.countFrames(output);
    const seconds = (frames * rate.den) / rate.num;
    let description = `The cut, rendered at ${size.width}x${size.height}, ${formatSeconds(seconds)}`;
    if (measured !== undefined) {
      description += ` (${measured} frames; the plan is ${frames})`;
      if (Math.abs(measured - frames) > 1) {
        warnings.push(
          `the preview has ${measured} frames and the plan ${frames}; its timing is off by more than a frame`,
        );
      }
    }
    if (!booleanOption(request, 'keep_work', false)) rmSync(work, { recursive: true, force: true });

    artifacts.unshift({
      path: output,
      kind: 'preview',
      description: `${description}.`,
      byte_size: existsSync(output) ? statSync(output).size : 0,
    });
    return {
      adapter: this.capabilities.id,
      artifacts,
      downgrades,
      warnings,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  /**
   * The join: pieces copied as they are, sound encoded to AAC once, beds mixed
   * in under it at their own level, chapters written as mp4 chapters.
   */
  private finalArgs(
    plan: EditPlan,
    request: ApplyRequest,
    work: string,
    output: string,
    warnings: string[],
  ): string[] {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
    args.push('-f', 'concat', '-safe', '0', '-i', 'pieces.txt');
    const grid = layOnGrid(plan);
    const seconds = (frames: number): string =>
      ((frames * grid.rate.den) / grid.rate.num).toFixed(6);

    let inputs = 1;
    const beds: string[] = [];
    for (const spec of plan.tracks.audio) {
      if (spec.type !== 'external') continue;
      const asset = assetById(request.ir.assets, spec.asset_id);
      const path = asset ? resolveAssetPath(request, asset.id) : undefined;
      const sound = asset ? streamOf(asset, undefined, spec.asset_id, warnings) : undefined;
      const bed = asset ? bedSpan(spec, asset, grid.length, grid.frames) : undefined;
      if (!asset || !path || !sound || !bed) {
        warnings.push(
          `the bed on audio track ${spec.track} (${spec.asset_id}) is not in the preview`,
        );
        continue;
      }
      args.push('-ss', seconds(bed.in), '-t', seconds(bed.length), '-i', path);
      const delay = Math.round((bed.start * grid.rate.den * 1000) / grid.rate.num);
      beds.push(
        `[${inputs}:a:${sound.stream}]aresample=${plan.sequence.sample_rate},` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${delay}:all=1,volume=${spec.gain_db}dB[b${inputs}]`,
      );
      inputs++;
    }

    let chapters: number | undefined;
    if (plan.markers.some((marker) => marker.kind === 'chapter')) {
      writeFileSync(join(work, 'chapters.txt'), ffmetadataChapters(plan, grid.length, grid.rate));
      args.push('-f', 'ffmetadata', '-i', 'chapters.txt');
      chapters = inputs++;
    }

    if (beds.length > 0) {
      const labels = beds.map((_, index) => `[b${index + 1}]`).join('');
      args.push(
        '-filter_complex',
        `${beds.join(';')};[0:a]${labels}amix=inputs=${beds.length + 1}:normalize=0:duration=first[a]`,
        '-map',
        '0:v',
        '-map',
        '[a]',
      );
    } else {
      args.push('-map', '0:v', '-map', '0:a');
    }
    if (chapters !== undefined)
      args.push('-map_metadata', String(chapters), '-map_chapters', String(chapters));
    args.push(
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      String(plan.sequence.sample_rate),
      '-movflags',
      '+faststart',
      output,
    );
    return args;
  }

  /**
   * The files ffprobe cannot open, with its reason. Nothing is ruled out when
   * ffprobe itself is missing: then the render is the test.
   */
  private async unreadable(paths: string[]): Promise<Map<string, string>> {
    const results = await Promise.all(
      paths.map((path) =>
        this.runner.run(
          this.ffprobe,
          ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', path],
          { timeoutMs: 60_000 },
        ),
      ),
    );
    const unreadable = new Map<string, string>();
    for (const [index, result] of results.entries()) {
      if (result.code === 127) return new Map();
      if (result.code !== 0) {
        unreadable.set(paths[index]!, tail(result.stderr) || `ffprobe exited ${result.code}`);
      }
    }
    return unreadable;
  }

  /** Frames in the rendered file, counted from its packets; undefined without ffprobe. */
  private async countFrames(path: string): Promise<number | undefined> {
    const result = await this.runner.run(
      this.ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-count_packets',
        '-show_entries',
        'stream=nb_read_packets',
        '-of',
        'csv=p=0',
        path,
      ],
      { timeoutMs: 60_000 },
    );
    if (result.code !== 0) return undefined;
    const value = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  }
}

/** The plan's chapters as an ffmetadata file, each running to the next. */
export function ffmetadataChapters(plan: EditPlan, frames: number, rate: FrameRate): string {
  const end = Math.round((frames * rate.den * 1000) / rate.num);
  const chapters = plan.markers
    .filter((marker) => marker.kind === 'chapter')
    .sort((a, b) => a.timeline_ms - b.timeline_ms);
  const escape = (value: string): string => value.replace(/([=;#\\\n])/g, '\\$1');
  const lines = [';FFMETADATA1'];
  for (const [index, chapter] of chapters.entries()) {
    const start = Math.min(chapter.timeline_ms, end);
    const stop = Math.min(chapters[index + 1]?.timeline_ms ?? end, end);
    if (stop <= start) continue;
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${start}`,
      `END=${stop}`,
      `title=${escape(chapter.name)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function tail(stderr: string): string {
  const lines = stderr.trim().split('\n');
  return lines.slice(-3).join(' | ').slice(0, 600);
}

function formatSeconds(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
