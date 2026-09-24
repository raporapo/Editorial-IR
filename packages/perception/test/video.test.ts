import { describe, expect, it } from 'vitest';
import { AnalyzeVideoParams } from '@editorial-ir/contracts';
import {
  MOTION_HEIGHT,
  MOTION_WIDTH,
  analyseSamples,
  cellMaxDifference,
  motionArgs,
} from '../src/ffmpeg/video.js';

/**
 * The picture's envelope, on synthetic frames.
 *
 * What matters is which way it fails: grain must read as still, a person in one
 * corner must read as moving, and a dark frame with a few lit windows must not
 * read as black.
 */

const SIZE = MOTION_WIDTH * MOTION_HEIGHT;
const params = AnalyzeVideoParams.parse({ path: 'x.mp4' });

/** Deterministic noise in [-amplitude, amplitude]. */
function noise(seed: number, amplitude: number): (i: number) => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.round(((state / 2_147_483_648) * 2 - 1) * amplitude);
  };
}

function frame(fill: number | ((i: number) => number)): Uint8Array {
  const out = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    const v = typeof fill === 'number' ? fill : fill(i);
    out[i] = Math.max(0, Math.min(255, v));
  }
  return out;
}

function concat(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.length * SIZE);
  frames.forEach((f, i) => out.set(f, i * SIZE));
  return out;
}

describe('cellMaxDifference', () => {
  it('is zero for identical frames', () => {
    expect(cellMaxDifference(frame(100), frame(100))).toBe(0);
  });

  it('sees a change confined to one corner', () => {
    // The whole-frame mean would dilute this twelvefold.
    const before = frame(100);
    const after = frame((i) =>
      i % MOTION_WIDTH < 16 && Math.floor(i / MOTION_WIDTH) < 12 ? 140 : 100,
    );
    expect(cellMaxDifference(before, after)).toBe(40);
  });
});

describe('analyseSamples', () => {
  it('calls a held frame with light grain static', () => {
    // Grain after the downscale is a grey level or less per pixel, and the cell
    // mean of that sits well below the threshold.
    const frames = Array.from({ length: 50 }, (_, k) => {
      const n = noise(k + 1, 0.6);
      return frame((i) => 120 + n(i));
    });
    const result = analyseSamples(concat(frames), params);
    expect(result.hop_ms).toBe(200);
    expect(result.motion.length).toBe(50);
    const statics = result.events.filter((e) => e.event_type === 'static');
    expect(statics).toHaveLength(1);
    expect(statics[0]!.start_ms).toBe(0);
    expect(statics[0]!.end_ms).toBe(10_000);
  });

  it('calls a moving picture moving', () => {
    const frames = Array.from({ length: 50 }, (_, k) => frame((i) => ((i + k * 7) % 64) * 3));
    const result = analyseSamples(concat(frames), params);
    expect(result.events.filter((e) => e.event_type === 'static')).toEqual([]);
  });

  it('ignores stillness shorter than the minimum', () => {
    const moving = Array.from({ length: 10 }, (_, k) => frame((i) => ((i + k * 7) % 64) * 3));
    const still = Array.from({ length: 10 }, () => frame(80)); // two seconds
    const result = analyseSamples(concat([...moving, ...still, ...moving]), params);
    expect(result.events.filter((e) => e.event_type === 'static')).toEqual([]);
  });

  it('finds black, and does not call a night scene with lit windows black', () => {
    const black = Array.from({ length: 10 }, () => frame(16));
    const night = Array.from({ length: 10 }, () =>
      // Dark, with about 5% of the frame lit: the mean is under the black line,
      // the brightest few percent are not.
      frame((i) => (i % 20 === 0 ? 200 : 12)),
    );
    const result = analyseSamples(concat([...black, ...night]), params);
    const blacks = result.events.filter((e) => e.event_type === 'black');
    expect(blacks).toEqual([{ start_ms: 0, end_ms: 2_000, event_type: 'black', confidence: 0.9 }]);
    expect(result.luma[15]!).toBeLessThan(params.black_luma);
  });

  it('never opens a file with a moment of stillness it did not measure', () => {
    const frames = Array.from({ length: 5 }, (_, k) => frame((i) => ((i + k * 7) % 64) * 3));
    const result = analyseSamples(concat(frames), params);
    expect(result.motion[0]).toBe(result.motion[1]);
  });

  it('reports nothing for no picture', () => {
    const result = analyseSamples(new Uint8Array(0), params);
    expect(result).toEqual({
      model: 'cell-max-64x36',
      hop_ms: 200,
      motion: [],
      luma: [],
      events: [],
    });
  });
});

describe('motionArgs', () => {
  it('decodes a small greyscale picture with an averaging downscale', () => {
    const args = motionArgs('in.mp4', 5, 'out.gray');
    expect(args.join(' ')).toContain('fps=5,scale=64:36:flags=area,format=gray');
    expect(args).toContain('rawvideo');
    expect(args).toContain('-an');
  });
});
