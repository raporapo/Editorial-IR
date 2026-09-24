import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlanMarker } from '@editorial-ir/contracts';
import {
  YoutubeChaptersAdapter,
  buildYoutubeChapters,
  formatChapterTime,
  youtubeChapters,
} from '../src/index.js';
import { makePlan, requestFor } from '../../../tests/support/plan.js';

/**
 * YouTube chapters: `00:00 Title` lines for a video description.
 *
 * YouTube shows chapters only when the list obeys its rules — the first at
 * 00:00, at least three, each at least ten seconds — and otherwise shows none
 * and says nothing. Every rule is tested with the list that breaks it, because
 * that is the list a real cut produces.
 */

/** A two-minute cut of one clip, with chapters at the given seconds. */
function planWith(chapters: [number, string][], seconds = 120) {
  const markers: PlanMarker[] = chapters.map(([at, name]) => ({
    timeline_ms: at * 1000,
    name,
    kind: 'chapter',
  }));
  return makePlan(
    [
      {
        source_asset_id: 'asset_001',
        source_in_ms: 0,
        source_out_ms: seconds * 1000,
        timeline_start_ms: 0,
      },
    ],
    { markers },
  );
}

describe('YouTube chapters', () => {
  it('writes one line per chapter from 00:00', () => {
    const notes: string[] = [];
    const text = buildYoutubeChapters(
      planWith([
        [0, 'Morning'],
        [40, 'The harbour'],
        [80, 'Night'],
      ]),
      notes,
    );
    expect(text).toBe('00:00 Morning\n00:40 The harbour\n01:20 Night\n');
    expect(notes).toEqual([]);
  });

  it('moves the first chapter to 00:00, and says so', () => {
    // A hook-first cut opens on a moment before the first chapter marker.
    const notes: string[] = [];
    const lines = youtubeChapters(
      planWith([
        [4, 'Morning'],
        [40, 'The harbour'],
        [80, 'Night'],
      ]),
      notes,
    )!;
    expect(lines[0]).toEqual({ seconds: 0, title: 'Morning' });
    expect(notes.join(' ')).toMatch(/moved from 00:04 to 00:00/);
  });

  it('merges a chapter shorter than ten seconds into the one before it, and names it', () => {
    const notes: string[] = [];
    const lines = youtubeChapters(
      planWith([
        [0, 'Morning'],
        [30, 'Train'],
        [36, 'The harbour'],
        [70, 'Night'],
      ]),
      notes,
    )!;
    expect(lines.map((l) => l.title)).toEqual(['Morning', 'The harbour', 'Night']);
    // "Train" ran 6 s; its content is still there, under the previous title,
    // and the chapter after it starts where it always did.
    expect(lines.map((l) => l.seconds)).toEqual([0, 36, 70]);
    expect(notes.join(' ')).toMatch(/“Train” \(00:30\) was 6 s/);
  });

  it('lets a short first chapter absorb the next, since nothing comes before 00:00', () => {
    const notes: string[] = [];
    const lines = youtubeChapters(
      planWith([
        [0, 'Cold open'],
        [5, 'Morning'],
        [40, 'The harbour'],
        [80, 'Night'],
      ]),
      notes,
    )!;
    expect(lines.map((l) => `${l.seconds} ${l.title}`)).toEqual([
      '0 Cold open',
      '40 The harbour',
      '80 Night',
    ]);
    expect(notes.join(' ')).toMatch(/“Morning” \(00:05\) was merged into it/);
  });

  it('checks the last chapter against the end of the cut', () => {
    const lines = youtubeChapters(
      planWith([
        [0, 'Morning'],
        [40, 'The harbour'],
        [80, 'Night'],
        [115, 'Credits'],
      ]),
    )!;
    // "Credits" runs 5 s to the end of a 120 s cut.
    expect(lines.map((l) => l.title)).toEqual(['Morning', 'The harbour', 'Night']);
  });

  it('writes none when fewer than three would be left, and says why', async () => {
    const notes: string[] = [];
    const plan = planWith([
      [0, 'Morning'],
      [60, 'Night'],
    ]);
    expect(youtubeChapters(plan, notes)).toBeUndefined();
    expect(notes.join(' ')).toMatch(/at least 3/);

    const result = await new YoutubeChaptersAdapter().apply(requestFor(plan));
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/at least 3/);
  });

  it('merges a chapter that continues the one before it under the same name', () => {
    // Two IR chapters named alike become two markers in a row.
    const notes: string[] = [];
    const lines = youtubeChapters(
      planWith([
        [0, 'USJ'],
        [20, 'USJ'],
        [40, 'Ride'],
        [80, 'Night'],
      ]),
      notes,
    )!;
    expect(lines.map((l) => l.title)).toEqual(['USJ', 'Ride', 'Night']);
    expect(notes.join(' ')).toMatch(/continues the chapter before it/);
  });

  it('ignores notes: only chapters become chapters', () => {
    const plan = planWith([
      [0, 'Morning'],
      [40, 'The harbour'],
      [80, 'Night'],
    ]);
    plan.markers.push({ timeline_ms: 60_000, name: 'check the audio here', kind: 'note' });
    expect(youtubeChapters(plan)!.map((l) => l.title)).toEqual(['Morning', 'The harbour', 'Night']);
  });

  it('writes hours as H:MM:SS for a video an hour or longer', () => {
    expect(formatChapterTime(3725, 4000)).toBe('1:02:05');
    expect(formatChapterTime(65, 4000)).toBe('0:01:05');
    expect(formatChapterTime(65, 600)).toBe('01:05');
  });

  it('writes the description block to a file', async () => {
    const plan = planWith([
      [0, 'Morning'],
      [40, 'The harbour'],
      [80, 'Night'],
    ]);
    const result = await new YoutubeChaptersAdapter().apply(requestFor(plan));
    expect(result.artifacts[0]!.kind).toBe('chapters');
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe(
      '00:00 Morning\n00:40 The harbour\n01:20 Night\n',
    );
  });
});
