import { describe, expect, it } from 'vitest';
import { FULL_STRENGTH_Z, MIN_SAMPLES, calibrationOf, strengthOf } from '../src/calibrate.js';

/**
 * Making one number mean the same thing for every model.
 *
 * The measurements these tests stand on: two unrelated things score 0.00 with
 * the lexical vectoriser, 0.184 ± 0.024 with CLIP ViT-B/32, and **0.722** ±
 * 0.027 with multilingual-e5-large. Every threshold in the project was written
 * against the first of those. Against the third, `minScore: 0.15` admitted the
 * entire corpus and `(similarity - 0.6) / 0.4` called the least similar pair of
 * events in a real project 0.368 redundant.
 */

/** A corpus of unrelated things, plus however many real matches. */
function corpus(floor: number, spread: number, matches: number[] = []): number[] {
  const bulk = Array.from({ length: 40 }, (_, i) => floor + spread * Math.sin(i * 2.399963));
  return [...bulk, ...matches];
}

describe('calibrationOf', () => {
  it('finds the floor of a set of scores wherever the model put it', () => {
    // The same shape of distribution at both models' scales.
    const clip = calibrationOf(corpus(0.184, 0.024));
    const e5 = calibrationOf(corpus(0.722, 0.027));
    expect(clip?.centre).toBeCloseTo(0.184, 1);
    expect(e5?.centre).toBeCloseTo(0.722, 1);
  });

  it('declines when there are too few numbers to describe a distribution', () => {
    // Not hypothetical: on a three-event project the three pairwise
    // similarities put the closest pair at z = 34.5. A confident number from
    // three samples is worse than no number.
    expect(calibrationOf([0.75, 0.76, 0.74])).toBeUndefined();
    expect(
      calibrationOf(Array.from({ length: MIN_SAMPLES - 1 }, () => Math.random())),
    ).toBeUndefined();
  });

  it('declines when every score is the same', () => {
    // The lexical vectoriser scores most pairs exactly zero, so its median and
    // MAD are both zero — and zero already means "nothing in common", so
    // calibrating it would be wrong as well as impossible.
    expect(calibrationOf(Array.from({ length: 40 }, () => 0))).toBeUndefined();
  });

  it('is barely moved by the matches it is meant to measure against', () => {
    // A handful of real matches are exactly the outliers whose distance is the
    // thing being measured, so the spread they are compared to must not include
    // them. Stated against the alternative rather than against a tolerance:
    // whatever the median does here, the mean must do more.
    const plain = corpus(0.72, 0.027);
    const withMatches = corpus(0.72, 0.027, [0.95, 0.94, 0.93, 0.92]);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

    const medianShift = Math.abs(
      (calibrationOf(withMatches)?.centre ?? 0) - (calibrationOf(plain)?.centre ?? 0),
    );
    const meanShift = Math.abs(mean(withMatches) - mean(plain));
    expect(medianShift).toBeLessThan(meanShift / 3);

    // And the spread stays the same order of magnitude, so a real match keeps
    // its distance instead of being normalised away by its own presence.
    const spreadRatio =
      (calibrationOf(withMatches)?.spread ?? 0) / (calibrationOf(plain)?.spread ?? 1);
    expect(spreadRatio).toBeGreaterThan(0.8);
    expect(spreadRatio).toBeLessThan(1.25);
  });
});

describe('strengthOf', () => {
  it('is the identity with nothing to calibrate against', () => {
    // Which is what keeps the lexical encoder and every small project behaving
    // exactly as they did.
    expect(strengthOf(0.42, undefined)).toBe(0.42);
  });

  it('puts two models on the same footing', () => {
    // The whole point. Before this, a good CLIP match (0.25) and an e5 score
    // for two unrelated sentences (0.72) were compared as though the second
    // were three times better.
    const clip = calibrationOf(corpus(0.184, 0.024))!;
    const e5 = calibrationOf(corpus(0.722, 0.027))!;
    const clipMatch = strengthOf(0.184 + 2.75 * clip.spread, clip);
    const e5Match = strengthOf(0.722 + 3.7 * e5.spread, e5);
    expect(clipMatch).toBeGreaterThan(0.5);
    expect(e5Match).toBeGreaterThan(0.5);
    // Comparable, rather than one of them three times the other.
    expect(Math.abs(clipMatch - e5Match)).toBeLessThan(0.35);
  });

  it('gives a score that is no better than chance exactly nothing', () => {
    const e5 = calibrationOf(corpus(0.722, 0.027))!;
    expect(strengthOf(e5.centre, e5)).toBe(0);
    expect(strengthOf(0.5, e5)).toBe(0);
  });

  it('lets a threshold written once mean something for both', () => {
    // Measured: "a rocket launching into space" against a harbour project
    // returned all eleven events between 0.486 and 0.517, every one of them
    // above minScore 0.15. Calibrated, that whole band is at or near zero.
    const e5 = calibrationOf(corpus(0.722, 0.027))!;
    for (const raw of [0.486, 0.5, 0.517, 0.72]) {
      expect(strengthOf(raw, e5)).toBeLessThan(0.15);
    }
  });

  it('never exceeds one, however far out a score sits', () => {
    const e5 = calibrationOf(corpus(0.722, 0.027))!;
    expect(strengthOf(0.999, e5)).toBeLessThanOrEqual(1);
    expect(strengthOf(50, e5)).toBe(1);
  });

  it('reaches full strength at the distance it says it does', () => {
    const e5 = calibrationOf(corpus(0.722, 0.027))!;
    expect(strengthOf(e5.centre + FULL_STRENGTH_Z * e5.spread, e5)).toBeCloseTo(1, 6);
  });

  it('cannot reorder anything, because it is monotone', () => {
    // Load-bearing. Calibration changes what a number means and what passes a
    // threshold; it must not change which of two results is better, or it would
    // be a ranking change disguised as a units change.
    const e5 = calibrationOf(corpus(0.722, 0.027))!;
    const raws = [0.6, 0.7, 0.722, 0.75, 0.8, 0.85, 0.9, 0.95];
    const strengths = raws.map((raw) => strengthOf(raw, e5));
    for (let i = 1; i < strengths.length; i++) {
      expect(strengths[i]!).toBeGreaterThanOrEqual(strengths[i - 1]!);
    }
  });
});
