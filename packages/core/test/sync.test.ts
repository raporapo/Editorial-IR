import { describe, expect, it } from 'vitest';
import { MIN_PEAK_RATIO, crossCorrelation, estimateOffset, onsetEnvelope } from '../src/sync.js';

/**
 * Lining up two recordings of one moment by their sound.
 *
 * Built on envelopes rather than WAV files so the arithmetic can be checked
 * exactly: a sequence of sound onsets, heard by two devices that started at
 * different times, with different gain and their own noise.
 */

/** Deterministic noise in [0, 1). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** A minute of room tone with sounds starting at irregular moments, at 10 ms hops. */
function scene(seed: number, hops = 6000): number[] {
  const next = random(seed);
  const level = new Array<number>(hops).fill(-60);
  let t = 50;
  while (t < hops - 100) {
    const length = 20 + Math.floor(next() * 60);
    const loudness = -35 + next() * 20;
    for (let i = t; i < t + length; i++) level[i] = loudness - (i - t) * 0.2;
    t += length + 10 + Math.floor(next() * 150);
  }
  return level;
}

/** The same scene through another device: started `startHop` hops later, its own gain and noise. */
function heardBy(level: number[], startHop: number, gainDb: number, seed: number): number[] {
  const noise = random(seed);
  return level.slice(startHop).map((db) => db + gainDb + (noise() - 0.5) * 4);
}

describe('estimateOffset', () => {
  it('finds where the second recording starts in the first', () => {
    const room = scene(1);
    const recorder = heardBy(room, 321, -6, 7);
    const estimate = estimateOffset(room, recorder, 10, 60_000)!;
    expect(Math.abs(estimate.offset_ms - 3_210)).toBeLessThanOrEqual(10);
    expect(estimate.score).toBeGreaterThan(MIN_PEAK_RATIO);
    expect(estimate.confidence).toBeGreaterThan(0);
  });

  it('gives the same offset negated when asked the other way round', () => {
    const room = scene(2);
    const recorder = heardBy(room, 150, 3, 9);
    const forward = estimateOffset(room, recorder, 10, 60_000)!;
    const backward = estimateOffset(recorder, room, 10, 60_000)!;
    expect(backward.offset_ms).toBe(-forward.offset_ms);
  });

  it('does not match two recordings of different moments', () => {
    // A correlation always has a maximum. What matters is that the maximum
    // between unrelated recordings is not believed.
    const estimate = estimateOffset(scene(3), scene(4), 10, 60_000)!;
    expect(estimate.score).toBeLessThan(MIN_PEAK_RATIO);
    expect(estimate.confidence).toBe(0);
  });

  it('refuses a recording with nothing in it', () => {
    expect(
      estimateOffset(scene(5), new Array<number>(3000).fill(-100), 10, 60_000),
    ).toBeUndefined();
  });

  it('is not fooled by a hum both devices hear throughout', () => {
    // A steady tone has no onsets, so it cannot line anything up by itself.
    const hum = new Array<number>(4000).fill(-30);
    expect(onsetEnvelope(hum).every((v) => v === 0)).toBe(true);
  });
});

describe('crossCorrelation', () => {
  it('agrees with direct summation', () => {
    const next = random(11);
    const a = Float64Array.from({ length: 300 }, () => next() - 0.5);
    const b = Float64Array.from({ length: 200 }, () => next() - 0.5);
    const maxLag = 50;
    const fast = crossCorrelation(a, b, maxLag);
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let direct = 0;
      for (let t = 0; t < b.length; t++) {
        const i = t + lag;
        if (i >= 0 && i < a.length) direct += a[i]! * b[t]!;
      }
      expect(fast[lag + maxLag]).toBeCloseTo(direct, 9);
    }
  });
});
