import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOLDEN_PATH, buildGolden, type Golden } from '../scripts/make-golden.js';

/**
 * The cut is the cut.
 *
 * Determinism is only useful if somebody looks at it. This freezes what the
 * worked example compiles and plans to, so a change to segmentation, scoring,
 * skills or planning shows up as a reviewable diff rather than as a number
 * nobody compared.
 *
 * When this fails, read the diff. Sometimes the answer is that the change is an
 * improvement and the file should be regenerated with `pnpm golden:update`. The
 * point is that the decision gets made, rather than being made by nobody.
 */
describe('the worked example, frozen', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;

  it('compiles to the same analysis', async () => {
    const current = await buildGolden();
    expect(current.analysis).toEqual(golden.analysis);
  }, 60_000);

  it('produces the same cuts', async () => {
    const current = await buildGolden();
    for (const skill of Object.keys(golden.cuts)) {
      expect(current.cuts[skill], `the ${skill} cut changed`).toEqual(golden.cuts[skill]);
    }
  }, 60_000);

  it('holds a cut that a person would recognise as one', () => {
    const travel = golden.cuts['travel-vlog']!;

    // Selective: a cut that keeps everything is not a cut.
    expect(travel.events_selected).toBeLessThan(travel.events_available * 0.8);
    // Varied: uniform clip lengths mean the planner ignored how good things were.
    expect(travel.mean_clip_seconds).toBeGreaterThan(3);
    expect(travel.mean_clip_seconds).toBeLessThan(9);
    // On target, and with nothing the reviewer objects to.
    expect(Math.abs(travel.duration_error_seconds)).toBeLessThan(15);
    expect(travel.review_observations).toBe(0);
  });

  it('cuts a short faster and shorter than a travel vlog', () => {
    const travel = golden.cuts['travel-vlog']!;
    const short = golden.cuts.shorts!;
    expect(short.clips).toBeLessThan(travel.clips);
    expect(short.mean_clip_seconds).toBeLessThan(travel.mean_clip_seconds);
  });

  it('gives a memory film more room than a travel vlog', () => {
    const travel = golden.cuts['travel-vlog']!;
    const memory = golden.cuts['memory-film']!;
    expect(memory.mean_clip_seconds).toBeGreaterThanOrEqual(travel.mean_clip_seconds);
  });
});
