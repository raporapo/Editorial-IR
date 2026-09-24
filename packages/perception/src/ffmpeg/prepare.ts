import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  EditorialError,
  type PrepareParams,
  type PrepareResult,
  type PreparedDerivative,
  type ProbeResult,
} from '@editorial-ir/contracts';
import type { CommandRunner } from '../command.js';
import { NodeCommandRunner } from '../command.js';
import type { MediaPreparer, MediaProbe, ModelIdentity } from '../types.js';
import { computeHopStatistics } from '../wav.js';
import { analyseHops } from './audio.js';
import { FfprobeMediaProbe, MAX_NOMINAL_FPS, isStillFormat } from './probe.js';

/**
 * Cheap derivatives, made once and reused by everything downstream.
 *
 * The originals are never touched. Everything here is regenerable from the
 * source file, which is what makes the work directory safe to delete and safe to
 * cache by content hash.
 *
 * Three rules, each paid for by a bug:
 *
 * - **Each derivative is on its own.** They were one sequence in one `try`, audio
 *   before frames, so a video with no audio track lost its frames to the audio
 *   step's error — and the proxy that had already been made with them.
 * - **A derivative is named after everything that makes it different** — proxy
 *   height and rate, audio stream, frame rate — so a work directory reused by a
 *   later run, or by the other runtime, can never serve one made differently.
 * - **Nothing half-written is ever reused.** Each is written under a temporary
 *   name and renamed into place, so an interrupted run leaves a stray temporary
 *   rather than a truncated proxy that the next run finds, trusts and keeps.
 *
 * `media.prepare` in the Python worker follows the same rules and makes the same
 * choices, file for file.
 */
export interface FfmpegPrepareOptions {
  runner?: CommandRunner;
  binary?: string;
  timeoutMs?: number;
  /** Constant rate factor for the proxy. Higher is smaller and uglier. */
  crf?: number;
  /** Where the preparer learns what the file holds. Defaults to ffprobe on the same runner. */
  probe?: MediaProbe;
}

export class FfmpegMediaPreparer implements MediaPreparer {
  readonly identity: ModelIdentity;
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly crf: number;
  private readonly prober: MediaProbe;

  constructor(options: FfmpegPrepareOptions = {}) {
    this.runner = options.runner ?? new NodeCommandRunner();
    this.binary = options.binary ?? 'ffmpeg';
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.crf = options.crf ?? 28;
    this.prober = options.probe ?? new FfprobeMediaProbe({ runner: this.runner });
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
    // The file says what it holds, not the caller: an asset registered before
    // streams were listed says nothing about its second audio track, and one
    // with a stale rate would make the proxy at the wrong one.
    const probed = await this.prober.probe(params.path);
    const result: PrepareResult = { frame_timestamps_ms: [] };
    const failed: { derivative: PreparedDerivative; reason: string }[] = [];
    const attempt = async (derivative: PreparedDerivative, work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        failed.push({ derivative, reason: failureReason(error) });
      }
    };

    const picture = hasPicture(probed);
    if (params.proxy_height > 0 && picture) {
      await attempt('proxy', async () => {
        const rate = params.constant_frame_rate === false ? undefined : proxyFrameRate(probed);
        const path = join(params.work_dir, proxyFileName(params.proxy_height, rate));
        if (!existsSync(path)) {
          await this.writeAtomically(path, (partial) =>
            proxyArgs(params.path, partial, params.proxy_height, this.crf, rate),
          );
        }
        result.proxy_path = path;
      });
    }

    // A probe that does not list streams still says whether there is a first one.
    const streams =
      probed.audio_streams ?? (probed.audio_codec === undefined ? [] : [{ index: 0 }]);
    result.audio_stream_count = streams.length;
    if (params.extract_audio && streams.length > 0) {
      await attempt('audio', async () => {
        const chosen = await this.audio(params, streams.length, failed);
        result.audio_path = chosen.path;
        result.audio_stream_index = chosen.index;
        result.audio_stream_reason = chosen.reason;
      });
    }

    if (params.frame_fps > 0 && picture) {
      await attempt('frames', async () => {
        const dir = join(params.work_dir, framesDirName(params.frame_fps));
        if (!existsSync(dir)) {
          const partial = partialPath(dir);
          rmSync(partial, { recursive: true, force: true });
          mkdirSync(partial, { recursive: true });
          try {
            await this.runner.run(this.binary, frameArgs(params.path, partial, params.frame_fps), {
              timeoutMs: this.timeoutMs,
            });
            renameSync(partial, dir);
          } catch (error) {
            rmSync(partial, { recursive: true, force: true });
            // Another run finished the same directory first, which is success.
            if (!existsSync(dir)) throw error;
          }
        }
        result.frames_dir = dir;
        result.frame_timestamps_ms = frameTimestampsIn(dir, params.frame_fps);
      });
    }

    if (failed.length > 0) result.failed = failed;
    return result;
  }

  /**
   * The audio stream to analyse, extracted.
   *
   * With one stream there is nothing to decide. With several, each is extracted
   * and the one with the most speech is kept, because ffmpeg's own default is
   * the stream with the most channels — and a camera records its stereo room
   * tone on the first track and the mono lavalier on the second. Measured on
   * such a file: the room tone was transcribed, five sentences became none.
   */
  private async audio(
    params: PrepareParams,
    count: number,
    failed: { derivative: PreparedDerivative; reason: string }[],
  ): Promise<{ path: string; index: number; reason: string }> {
    const extract = async (index: number): Promise<string> => {
      const path = join(params.work_dir, audioFileName(index));
      if (!existsSync(path)) {
        await this.writeAtomically(path, (partial) => audioArgs(params.path, partial, index));
      }
      return path;
    };

    if (params.audio_stream_index !== undefined && count > 1) {
      if (params.audio_stream_index >= count) {
        throw new Error(
          `there is no audio stream ${params.audio_stream_index}; the file has ${count}`,
        );
      }
      return {
        path: await extract(params.audio_stream_index),
        index: params.audio_stream_index,
        reason: 'asked for',
      };
    }
    if (count === 1) return { path: await extract(0), index: 0, reason: 'the only one' };

    const stored = readStreamMeasurements(params.work_dir, count);
    const measured: StreamSpeech[] = [];
    for (let index = 0; index < count; index++) {
      let path: string;
      try {
        path = await extract(index);
      } catch (error) {
        // One unreadable track is not a reason to hear none of them.
        failed.push({
          derivative: 'audio',
          reason: `stream ${index}: ${failureReason(error)}`,
        });
        continue;
      }
      measured.push(stored?.get(index) ?? measureSpeech(path, index));
    }
    if (measured.length === 0) throw new Error('none of the audio streams could be extracted');
    if (!stored && measured.length === count) writeStreamMeasurements(params.work_dir, measured);

    const choice = chooseAudioStream(measured, count);
    return { path: join(params.work_dir, audioFileName(choice.index)), ...choice };
  }

  private async writeAtomically(
    finalPath: string,
    argsFor: (partial: string) => string[],
  ): Promise<void> {
    const partial = partialPath(finalPath);
    try {
      await this.runner.run(this.binary, argsFor(partial), { timeoutMs: this.timeoutMs });
      renameSync(partial, finalPath);
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
  }
}

/**
 * A failure in one line: what failed, and ffmpeg's first word on why.
 *
 * The runner's message carries the whole command and all of stderr: 539
 * characters for one silent drone clip, most of them paths, ending in
 * "Invalid argument" — with the only words that mattered, "Output file does not
 * contain any stream", in the middle. ffmpeg says the cause first and its
 * consequences after. The worker reports it the same way.
 */
export function failureReason(error: unknown): string {
  if (EditorialError.is(error)) {
    const { command, stderr } = error.details;
    if (typeof command === 'string' && typeof stderr === 'string') {
      const first = stderr
        .split('\n')
        .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
        .find((line) => line.length > 0);
      if (first) return `${command} failed: ${first}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether there is a moving picture to make a proxy and frames of. Not album
 * art, which the probe leaves out, and not a still, which is its own frame: a
 * one-frame proxy of a photo is a file nobody reads.
 */
function hasPicture(probed: ProbeResult): boolean {
  return (
    probed.video_codec !== undefined && (probed.width ?? 0) > 0 && !isStillFormat(probed.container)
  );
}

/** Audio for analysis: mono, 16 kHz, uncompressed. What every ASR wants. */
export const AUDIO_SAMPLE_RATE = 16_000;

/**
 * The rate a proxy is made at when the file declares none worth believing.
 *
 * A screen recorder writing Matroska declares its millisecond clock as the rate
 * — 1000/1, measured — and a constant-rate proxy at that would hold a thousand
 * frames a second, nearly all of them copies. The probe refuses any rate above
 * `MAX_NOMINAL_FPS`, and this is what the proxy is made at instead.
 *
 * Only then. This was a cap on every file, and a 120 fps action-camera clip
 * lost every other frame to it: measured, each cut the shot detector found on
 * the 60 fps proxy came one source frame late — 1008 ms became 1017, 2508
 * became 2517 — and the last shot ended at 3720 rather than 3710. Every
 * boundary downstream is taken from the proxy, so a real rate is kept, as it
 * always was before the proxy was made constant-rate.
 */
export const PROXY_FALLBACK_FPS = 60;

/** The rate a constant-rate proxy is made at: the nominal one, or the fallback when there is none. */
export function proxyFrameRate(probed: Pick<ProbeResult, 'fps_num' | 'fps_den'>): {
  num: number;
  den: number;
} {
  const num = probed.fps_num ?? 0;
  const den = probed.fps_den ?? 1;
  if (num <= 0 || den <= 0 || num / den > MAX_NOMINAL_FPS) {
    return { num: PROXY_FALLBACK_FPS, den: 1 };
  }
  return { num, den };
}

export function proxyFileName(
  height: number,
  rate: { num: number; den: number } | undefined,
): string {
  if (!rate) return `proxy-${height}p.mp4`;
  return `proxy-${height}p-cfr${rate.num}${rate.den === 1 ? '' : `-${rate.den}`}.mp4`;
}

/** Named for its stream, so a reused work directory never serves another stream's audio. */
export function audioFileName(streamIndex: number): string {
  return `audio-a${streamIndex}.wav`;
}

export function framesDirName(fps: number): string {
  return `frames-${formatRate(fps)}fps`;
}

function formatRate(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/0+$/, '');
}

/** A sibling name for the unfinished file, keeping the extension ffmpeg reads the format from. */
function partialPath(finalPath: string): string {
  const extension = extname(finalPath);
  const stem = basename(finalPath, extension);
  return join(dirname(finalPath), `${stem}.partial-${process.pid}${extension}`);
}

export function proxyArgs(
  input: string,
  output: string,
  height: number,
  crf: number,
  rate?: { num: number; den: number },
): string[] {
  // Constant rate by the `fps` filter rather than `-fps_mode cfr -r`: the two
  // produced the same 600 frames at 30/1 from a 455-frame variable-rate phone
  // clip, and the filter needs no version check — `-fps_mode` does not exist
  // before ffmpeg 5.1. Without either, the proxy was constant-rate only because
  // the mp4 muxer happens to default to it. Before `scale`, so frames that are
  // about to be dropped are never scaled.
  const filters = [...(rate ? [`fps=${rate.num}/${rate.den}`] : []), `scale=-2:${height}`];
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    // -2 keeps the width even, which h264 requires.
    '-vf',
    filters.join(','),
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

export function audioArgs(input: string, output: string, streamIndex = 0): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    // Always a named stream. Left to itself ffmpeg takes the audio stream with
    // the most channels, which on a camera is the stereo room tone and not the
    // mono lavalier beside it.
    '-map',
    `0:a:${streamIndex}`,
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

/** The timestamps of the frames a finished frames directory holds, as the worker reports them. */
export function frameTimestampsIn(dir: string, fps: number): number[] {
  const count = readdirSync(dir).filter((name) => /^\d{8}\.jpg$/.test(name)).length;
  return Array.from({ length: count }, (_, i) => frameTimestampMs(i + 1, fps));
}

/* --- choosing an audio stream ------------------------------------------------ */

/** How much of one audio stream is speech, by the same measure the audio stage reports. */
export interface StreamSpeech {
  index: number;
  /** Hops whose speech probability is at least 0.5. */
  speech_hops: number;
  hops: number;
  /** The lower median of the per-hop level, in dBFS. */
  median_db: number;
}

/** Identifies the measure, so a stored measurement made another way is not trusted. */
const MEASURE = 'rms-zcr-100ms-1';
const MEASUREMENTS_FILE = 'audio-streams.json';

/**
 * Speech evidence for one extracted stream.
 *
 * The energy and zero-crossing analysis the audio stage already runs, with its
 * defaults, so "most speech" means what `speech_prob` means everywhere else.
 * Weak as a speech detector, and enough here: the question is which of a few
 * tracks carries a voice, and room tone has no dynamic range to speak of — the
 * analysis reports zero speech for it by construction.
 */
export function measureSpeech(wavPath: string, index: number): StreamSpeech {
  const analysed = analyseHops(computeHopStatistics(wavPath, 100), {
    silenceThresholdDb: -40,
    silenceMarginDb: 8,
    minSilenceMs: 300,
    minSpeechMs: 400,
  });
  return speechOf(analysed.speech_prob ?? [], analysed.rms_db, index);
}

export function speechOf(speechProb: number[], rmsDb: number[], index: number): StreamSpeech {
  // The lower median by integer index. `percentile` rounds a half-way index
  // up here and to even in Python, and a choice both runtimes must make
  // identically cannot rest on that.
  const sorted = [...rmsDb].sort((a, b) => a - b);
  return {
    index,
    speech_hops: speechProb.filter((p) => p >= 0.5).length,
    hops: speechProb.length,
    median_db: sorted.length > 0 ? (sorted[(sorted.length - 1) >> 1] ?? -100) : -100,
  };
}

/**
 * The stream with the most speech, and why, in a line a person can check.
 *
 * Share of hops, compared by cross-multiplying the integer counts so no
 * rounding can make the two runtimes disagree; then the louder median; then
 * the earlier stream.
 */
export function chooseAudioStream(
  measured: readonly StreamSpeech[],
  streamCount: number,
): { index: number; reason: string } {
  const ranked = [...measured].sort(
    (a, b) =>
      b.speech_hops * Math.max(1, a.hops) - a.speech_hops * Math.max(1, b.hops) ||
      b.median_db - a.median_db ||
      a.index - b.index,
  );
  const best = ranked[0];
  if (!best) throw new Error('no audio stream to choose from');
  const next = ranked[1];
  if (!next) return { index: best.index, reason: 'the only one that could be read' };
  const share = (s: StreamSpeech) => s.speech_hops / Math.max(1, s.hops);
  const moreSpeech =
    best.speech_hops * Math.max(1, next.hops) > next.speech_hops * Math.max(1, best.hops);
  if (moreSpeech) {
    return {
      index: best.index,
      reason: `most speech of ${streamCount} (${hundredths(share(best))} vs ${hundredths(share(next))})`,
    };
  }
  if (best.median_db > next.median_db) {
    return {
      index: best.index,
      reason: `as much speech as the others of ${streamCount} (${hundredths(share(best))}), and the loudest (${tenths(best.median_db)} vs ${tenths(next.median_db)} dB)`,
    };
  }
  return { index: best.index, reason: `the first of ${streamCount}, which all measured alike` };
}

/** Formatted from integers, so both runtimes write the same characters. */
function hundredths(value: number): string {
  const n = Math.floor(value * 100 + 0.5);
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

function tenths(value: number): string {
  const n = Math.floor(value * 10 + 0.5);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 10)}.${abs % 10}`;
}

/**
 * Measurements from an earlier run, when they cover every stream.
 *
 * Kept because measuring means reading every stream's audio, and prepare runs
 * on every analysis that is not reused: the Python measure is a pure-Python loop
 * over every sample. The WAVs they describe are complete by construction, so a
 * stored measurement of one can only be stale if the measure itself changed.
 */
function readStreamMeasurements(
  workDir: string,
  count: number,
): Map<number, StreamSpeech> | undefined {
  const path = join(workDir, MEASUREMENTS_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      measure?: unknown;
      streams?: unknown;
    };
    if (stored.measure !== MEASURE || !Array.isArray(stored.streams)) return undefined;
    const byIndex = new Map<number, StreamSpeech>();
    for (const entry of stored.streams as Partial<StreamSpeech>[]) {
      const { index, speech_hops, hops, median_db } = entry;
      if (
        typeof index !== 'number' ||
        typeof speech_hops !== 'number' ||
        typeof hops !== 'number' ||
        typeof median_db !== 'number' ||
        !existsSync(join(workDir, audioFileName(index)))
      ) {
        return undefined;
      }
      byIndex.set(index, { index, speech_hops, hops, median_db });
    }
    for (let index = 0; index < count; index++) if (!byIndex.has(index)) return undefined;
    return byIndex;
  } catch {
    return undefined;
  }
}

function writeStreamMeasurements(workDir: string, measured: readonly StreamSpeech[]): void {
  const path = join(workDir, MEASUREMENTS_FILE);
  const partial = partialPath(path);
  writeFileSync(
    partial,
    `${JSON.stringify({ measure: MEASURE, streams: [...measured].sort((a, b) => a.index - b.index) })}\n`,
  );
  renameSync(partial, path);
}
