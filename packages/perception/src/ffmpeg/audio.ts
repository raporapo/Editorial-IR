import { compareText } from '@editorial-ir/contracts';
import type { AnalyzeAudioParams, AnalyzeAudioResult } from '@editorial-ir/contracts';
import type { AudioModel, ModelIdentity } from '../types.js';
import { computeHopStatistics, type HopStatistics } from '../wav.js';

/**
 * Loudness, silence and speech presence, computed from the prepared WAV.
 *
 * This deliberately stops short of classifying laughter, applause or music:
 * those need a trained audio tagger, which belongs in the Python worker. What it
 * does cover is the part the editor actually needs on every machine — where the
 * quiet is — because that is what lets a cut land between words instead of
 * through one.
 */
export interface WavAudioAnalyzerOptions {
  /** A hop below the floor plus this margin counts as silent. */
  silenceMarginDb?: number;
  /** Shortest run that becomes a silence event. */
  minSilenceMs?: number;
  /** Shortest run that becomes a speech event. */
  minSpeechMs?: number;
}

export class WavAudioAnalyzer implements AudioModel {
  readonly identity: ModelIdentity;
  private readonly silenceMarginDb: number;
  private readonly minSilenceMs: number;
  private readonly minSpeechMs: number;

  constructor(options: WavAudioAnalyzerOptions = {}) {
    this.silenceMarginDb = options.silenceMarginDb ?? 8;
    this.minSilenceMs = options.minSilenceMs ?? 300;
    this.minSpeechMs = options.minSpeechMs ?? 400;
    this.identity = {
      backend: 'wav-statistics',
      model: 'rms-zcr',
      modelVersion: '1',
      locality: 'local',
      mediaLeavesDevice: false,
      parameters: {
        silence_margin_db: this.silenceMarginDb,
        min_silence_ms: this.minSilenceMs,
        min_speech_ms: this.minSpeechMs,
      },
    };
  }

  async analyzeAudio(params: AnalyzeAudioParams): Promise<AnalyzeAudioResult> {
    const stats = computeHopStatistics(params.audio_path, params.hop_ms);
    return analyseHops(stats, {
      silenceThresholdDb: params.silence_threshold_db,
      silenceMarginDb: this.silenceMarginDb,
      minSilenceMs: this.minSilenceMs,
      minSpeechMs: this.minSpeechMs,
    });
  }
}

/**
 * Smallest spread between the quiet and loud parts of a recording for which an
 * adaptive threshold means anything. Below it, the recording has no structure to
 * measure — constant tone, constant hiss, digital silence — and guessing from it
 * produces nonsense.
 */
const MIN_DYNAMIC_RANGE_DB = 10;

/**
 * Where silence begins, for this recording.
 *
 * A fixed -40 dB is wrong in both directions: a quiet indoor recording never
 * reaches it and reads as silent throughout, and a windy street never drops
 * below it and reads as continuous sound. So the threshold is derived from the
 * recording's own floor and spread, and the configured value is kept as the
 * fallback for recordings too flat to measure.
 */
export function hasDynamicRange(rmsDb: number[]): boolean {
  return percentile(rmsDb, 0.9) - percentile(rmsDb, 0.1) >= MIN_DYNAMIC_RANGE_DB;
}

export function silenceThreshold(rmsDb: number[], options: AnalyseHopsOptions): number {
  const floor = percentile(rmsDb, 0.1);
  const ceiling = percentile(rmsDb, 0.9);
  const range = ceiling - floor;
  if (range < MIN_DYNAMIC_RANGE_DB) {
    // Nothing to learn from: fall back, and stay below the floor so a flat
    // recording is not declared silent from end to end.
    return Math.min(options.silenceThresholdDb, floor - 1);
  }
  // Never more than a third of the way up the recording's own range, so a
  // generous margin cannot swallow quiet speech.
  return floor + Math.min(options.silenceMarginDb, range * 0.3);
}

export interface AnalyseHopsOptions {
  silenceThresholdDb: number;
  silenceMarginDb: number;
  minSilenceMs: number;
  minSpeechMs: number;
}

/** Split out from I/O so the whole decision surface is testable with plain arrays. */
export function analyseHops(stats: HopStatistics, options: AnalyseHopsOptions): AnalyzeAudioResult {
  const { rmsDb, zcr, hopMs } = stats;

  const threshold = silenceThreshold(rmsDb, options);
  const measurable = hasDynamicRange(rmsDb);

  // With no dynamic range there is nothing to measure: a constant tone, a
  // constant hiss and a muted track all look identical to an energy detector,
  // and none of them is speech. Reporting zero is the honest answer; a
  // transcriber will say otherwise if there is anything to hear.
  const speechProb = measurable
    ? rmsDb.map((db, i) => speechProbability(db, zcr[i] ?? 0, threshold))
    : rmsDb.map(() => 0);

  const events: AnalyzeAudioResult['events'] = [];
  for (const run of runsOf(rmsDb.map((db) => db < threshold))) {
    const durationMs = (run.end - run.start) * hopMs;
    if (durationMs >= options.minSilenceMs) {
      events.push({
        start_ms: run.start * hopMs,
        end_ms: run.end * hopMs,
        event_type: 'silence',
        confidence: 0.8,
      });
    }
  }
  for (const run of runsOf(speechProb.map((p) => p >= 0.5))) {
    const durationMs = (run.end - run.start) * hopMs;
    if (durationMs >= options.minSpeechMs) {
      events.push({
        start_ms: run.start * hopMs,
        end_ms: run.end * hopMs,
        event_type: 'speech',
        // Energy and zero-crossing rate are a weak speech detector. Saying so in
        // the confidence is better than pretending otherwise: an ASR pass will
        // overwrite this with something far better when one is available.
        confidence: 0.5,
      });
    }
  }
  events.sort((a, b) => a.start_ms - b.start_ms || compareText(a.event_type, b.event_type));

  return {
    model: 'rms-zcr',
    hop_ms: hopMs,
    rms_db: rmsDb.map((v) => round(v, 2)),
    speech_prob: speechProb.map((v) => round(v, 3)),
    events,
  };
}

/**
 * Voiced speech at 16 kHz sits in a narrow zero-crossing band. Below it is hum
 * and rumble, above it is hiss, sibilance and cymbals.
 */
const ZCR_LOW = 0.01;
const ZCR_HIGH = 0.3;

export function speechProbability(rmsDb: number, zcr: number, thresholdDb: number): number {
  if (rmsDb < thresholdDb) return 0;
  const loudness = clamp01((rmsDb - thresholdDb) / 18);
  const band = zcr >= ZCR_LOW && zcr <= ZCR_HIGH ? 1 : zcr < ZCR_LOW ? 0.3 : 0.4;
  return round(clamp01(loudness * band), 3);
}

export function percentile(values: number[], q: number): number {
  if (values.length === 0) return -100;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[index] ?? -100;
}

export function runsOf(flags: boolean[]): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      if (start === null) start = i;
    } else if (start !== null) {
      runs.push({ start, end: i });
      start = null;
    }
  }
  if (start !== null) runs.push({ start, end: flags.length });
  return runs;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
