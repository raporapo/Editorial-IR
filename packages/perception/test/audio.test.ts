import { describe, expect, it } from 'vitest';
import { analyseHops, percentile, runsOf, silenceThreshold, speechProbability } from '../src/index.js';
import type { HopStatistics } from '../src/wav.js';

const OPTIONS = {
  silenceThresholdDb: -40,
  silenceMarginDb: 8,
  minSilenceMs: 300,
  minSpeechMs: 400,
};

function hops(rmsDb: number[], zcr?: number[]): HopStatistics {
  return {
    hopMs: 100,
    rmsDb,
    zcr: zcr ?? rmsDb.map(() => 0.08),
    sampleRate: 16_000,
    durationMs: rmsDb.length * 100,
  };
}

describe('runsOf', () => {
  it('finds contiguous true runs', () => {
    expect(runsOf([false, true, true, false, true])).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 5 },
    ]);
  });

  it('closes a run that reaches the end', () => {
    expect(runsOf([true, true])).toEqual([{ start: 0, end: 2 }]);
  });

  it('returns nothing for an empty or all-false input', () => {
    expect(runsOf([])).toEqual([]);
    expect(runsOf([false, false])).toEqual([]);
  });
});

describe('percentile', () => {
  it('reads the requested quantile', () => {
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
  });

  it('survives an empty series', () => {
    expect(percentile([], 0.1)).toBe(-100);
  });
});

describe('speechProbability', () => {
  it('is zero below the threshold', () => {
    expect(speechProbability(-60, 0.08, -40)).toBe(0);
  });

  it('rises with level once above the threshold', () => {
    const quiet = speechProbability(-38, 0.08, -40);
    const loud = speechProbability(-20, 0.08, -40);
    expect(loud).toBeGreaterThan(quiet);
  });

  it('discounts a zero-crossing rate outside the voiced band', () => {
    const voiced = speechProbability(-20, 0.08, -40);
    const rumble = speechProbability(-20, 0.001, -40);
    const hiss = speechProbability(-20, 0.6, -40);
    expect(voiced).toBeGreaterThan(rumble);
    expect(voiced).toBeGreaterThan(hiss);
  });
});

describe('analyseHops', () => {
  it('adapts the silence floor to the recording', () => {
    // A quiet room: nothing is anywhere near -40 dB, but the gaps are obvious.
    const quiet = [-70, -70, -70, -70, -52, -50, -51, -52, -70, -70, -70, -70];
    const result = analyseHops(hops(quiet), OPTIONS);
    const silences = result.events.filter((e) => e.event_type === 'silence');
    expect(silences.length).toBe(2);
    expect(silences[0]).toMatchObject({ start_ms: 0, end_ms: 400 });
    expect(silences[1]).toMatchObject({ start_ms: 800, end_ms: 1200 });
  });

  it('ignores a silence shorter than the minimum', () => {
    const series = [-20, -20, -70, -20, -20, -20, -20, -20];
    const result = analyseHops(hops(series), OPTIONS);
    expect(result.events.filter((e) => e.event_type === 'silence')).toHaveLength(0);
  });

  it('reports speech where the level and the zero-crossing rate agree', () => {
    const rms = [-70, -70, -18, -17, -18, -19, -18, -70, -70];
    const zcr = [0.001, 0.001, 0.09, 0.1, 0.08, 0.11, 0.09, 0.001, 0.001];
    const result = analyseHops(hops(rms, zcr), OPTIONS);
    const speech = result.events.find((e) => e.event_type === 'speech');
    expect(speech).toBeDefined();
    expect(speech!.start_ms).toBe(200);
    expect(speech!.end_ms).toBe(700);
    // Energy plus zero crossings is a weak detector and says so.
    expect(speech!.confidence).toBeLessThan(0.7);
  });

  it('keeps the series aligned with the hop grid', () => {
    const result = analyseHops(hops([-20, -30, -40]), OPTIONS);
    expect(result.rms_db).toHaveLength(3);
    expect(result.speech_prob).toHaveLength(3);
    expect(result.hop_ms).toBe(100);
  });

  it('is deterministic', () => {
    const series = [-70, -70, -20, -18, -70, -70, -21, -19, -70];
    expect(JSON.stringify(analyseHops(hops(series), OPTIONS))).toBe(
      JSON.stringify(analyseHops(hops(series), OPTIONS)),
    );
  });
});

describe('silenceThreshold', () => {
  it('follows the recording rather than a fixed number', () => {
    // A noisy street: the gaps sit at -30 dB and would never reach a fixed -40.
    const noisy = [-30, -30, -10, -12, -11, -30, -30, -10, -11, -12];
    const threshold = silenceThreshold(noisy, OPTIONS);
    expect(threshold).toBeGreaterThan(-40);
    expect(threshold).toBeLessThan(-20);

    const events = analyseHops(hops(noisy), { ...OPTIONS, minSilenceMs: 150 }).events;
    expect(events.filter((e) => e.event_type === 'silence')).toHaveLength(2);
  });

  it('falls back when the recording has no dynamic range', () => {
    const flat = new Array(20).fill(-25);
    expect(silenceThreshold(flat, OPTIONS)).toBeLessThan(-25);
    // Nothing measurable means no claims at all, rather than a confident wrong one.
    const result = analyseHops(hops(flat), OPTIONS);
    expect(result.events).toHaveLength(0);
    expect(result.speech_prob).toEqual(new Array(20).fill(0));
  });

  it('never declares a whole quiet recording silent', () => {
    const quiet = [-70, -70, -70, -70, -52, -50, -51, -52, -70, -70, -70, -70];
    const silences = analyseHops(hops(quiet), OPTIONS).events.filter(
      (e) => e.event_type === 'silence',
    );
    const silentMs = silences.reduce((sum, e) => sum + (e.end_ms - e.start_ms), 0);
    expect(silentMs).toBeLessThan(quiet.length * 100);
  });
});
