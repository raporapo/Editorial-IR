import { describe, expect, it } from 'vitest';
import { chooseTrim, preferredDuration, snapTo } from '../src/index.js';

const base = {
  range: { start_ms: 10_000, end_ms: 40_000 },
  speech: [],
  silences: [],
  desiredMs: 5000,
  minMs: 1500,
  maxMs: 9000,
  padInMs: 150,
  padOutMs: 250,
  snapToSilence: false,
  snapWindowMs: 600,
  preserveReaction: false,
};

describe('chooseTrim', () => {
  it('keeps a short event whole', () => {
    const result = chooseTrim({ ...base, range: { start_ms: 0, end_ms: 3000 }, desiredMs: 5000 });
    expect(result).toMatchObject({ in_ms: 0, out_ms: 3000, reason: 'whole_event' });
  });

  it('opens a little before the first words', () => {
    const result = chooseTrim({
      ...base,
      speech: [{ start_ms: 20_000, end_ms: 23_000 }],
    });
    expect(result.reason).toBe('speech');
    expect(result.in_ms).toBe(20_000 - base.padInMs);
  });

  it('prefers to stop between sentences rather than inside one', () => {
    const result = chooseTrim({
      ...base,
      desiredMs: 4000,
      speech: [
        { start_ms: 20_000, end_ms: 22_000 },
        { start_ms: 22_500, end_ms: 24_200 },
      ],
    });
    // 4s from 19.85s would land at 23.85s, mid-sentence; the end of the second
    // utterance plus the pad is close enough to move to.
    expect(result.out_ms).toBe(24_200 + base.padOutMs);
  });

  it('keeps the reaction when asked to', () => {
    const withReaction = chooseTrim({
      ...base,
      desiredMs: 3000,
      preserveReaction: true,
      speech: [{ start_ms: 20_000, end_ms: 25_000 }],
    });
    const without = chooseTrim({
      ...base,
      desiredMs: 3000,
      speech: [{ start_ms: 20_000, end_ms: 25_000 }],
    });
    expect(withReaction.out_ms).toBeGreaterThan(without.out_ms);
    expect(withReaction.out_ms).toBeGreaterThan(25_000);
  });

  it('skips the start of a wordless shot, where the camera is still settling', () => {
    const result = chooseTrim({ ...base, desiredMs: 4000 });
    expect(result.reason).toBe('centre');
    expect(result.in_ms).toBeGreaterThan(base.range.start_ms);
  });

  it('lands on a quiet moment when one is near', () => {
    const result = chooseTrim({
      ...base,
      desiredMs: 4000,
      snapToSilence: true,
      // A silence ending just after where the clip would otherwise start.
      silences: [{ start_ms: 10_800, end_ms: 11_600 }],
    });
    expect(result.reason).toBe('snapped');
    expect(result.in_ms).toBe(11_600);
  });

  it('refuses a snap that would break the clip’s own bounds', () => {
    const result = chooseTrim({
      ...base,
      desiredMs: 4000,
      minMs: 3900,
      maxMs: 4100,
      snapToSilence: true,
      // Snapping here would leave a clip far shorter than its floor.
      silences: [{ start_ms: 10_000, end_ms: 11_500 }, { start_ms: 11_900, end_ms: 12_400 }],
    });
    expect(result.out_ms - result.in_ms).toBeGreaterThanOrEqual(3900);
  });

  it('never reads outside the event', () => {
    for (const desired of [500, 5000, 50_000]) {
      const result = chooseTrim({ ...base, desiredMs: desired, maxMs: 60_000 });
      expect(result.in_ms).toBeGreaterThanOrEqual(base.range.start_ms);
      expect(result.out_ms).toBeLessThanOrEqual(base.range.end_ms);
      expect(result.out_ms).toBeGreaterThan(result.in_ms);
    }
  });

  it('honours the floor even when the request is tiny', () => {
    const result = chooseTrim({ ...base, desiredMs: 100, minMs: 2000 });
    expect(result.out_ms - result.in_ms).toBeGreaterThanOrEqual(2000);
  });

  it('is deterministic', () => {
    const request = { ...base, speech: [{ start_ms: 20_000, end_ms: 23_000 }], snapToSilence: true };
    expect(chooseTrim(request)).toEqual(chooseTrim(request));
  });
});

describe('snapTo', () => {
  it('finds the nearest edge inside the window', () => {
    expect(snapTo(1000, [{ start_ms: 500, end_ms: 1200 }], 600, 'end')).toBe(1200);
    expect(snapTo(1000, [{ start_ms: 1300, end_ms: 1800 }], 600, 'start')).toBe(1300);
  });

  it('leaves the point alone when nothing is near enough', () => {
    expect(snapTo(1000, [{ start_ms: 9000, end_ms: 9500 }], 600, 'end')).toBe(1000);
    expect(snapTo(1000, [], 600, 'end')).toBe(1000);
  });
});

describe('preferredDuration', () => {
  it('spends the ceiling on the best-ranked moments and the floor on the worst', () => {
    expect(preferredDuration(1500, 9000, 0)).toBe(1500);
    expect(preferredDuration(1500, 9000, 1)).toBe(9000);
    expect(preferredDuration(1500, 9000, 0.5)).toBe(5250);
  });

  it('clamps a score outside the unit range', () => {
    expect(preferredDuration(1500, 9000, -2)).toBe(1500);
    expect(preferredDuration(1500, 9000, 7)).toBe(9000);
  });
});
