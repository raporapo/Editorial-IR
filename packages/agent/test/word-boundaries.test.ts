import { describe, expect, it } from 'vitest';
import { avoidWordSplit, chooseTrim, type TrimRequest, type TrimWindow } from '../src/trim.js';

/**
 * Not cutting through a word, which `trim.ts` calls rule 1 and did not do.
 *
 * "Do not start or stop in the middle of a word. A cut through speech sounds
 * like a fault rather than a choice" has been the first line of that file's
 * header since it was written. `Utterance.words` has said "enables cutting on
 * word boundaries" for as long, `observe` asks faster-whisper for word
 * timestamps and pays for them on every run — and nothing read them.
 *
 * What actually happened: `end = start + desired` put the out point wherever the
 * duration budget landed, and the only thing that ever pulled it back was a
 * whole-utterance boundary falling inside the snap window. In a long take with
 * no sentence ending nearby — which is most of one — the cut went through
 * whatever syllable was there.
 */

/** Words at a steady pace, so a chosen moment can be predicted exactly. */
function words(count: number, from = 0, spanMs = 400, gapMs = 100): TrimWindow[] {
  return Array.from({ length: count }, (_, i) => ({
    start_ms: from + i * (spanMs + gapMs),
    end_ms: from + i * (spanMs + gapMs) + spanMs,
  }));
}

const RANGE = { start_ms: 0, end_ms: 60_000 };

function request(overrides: Partial<TrimRequest> = {}): TrimRequest {
  return {
    range: RANGE,
    speech: [],
    silences: [],
    desiredMs: 5_000,
    minMs: 1_000,
    maxMs: 30_000,
    padInMs: 0,
    padOutMs: 0,
    snapToSilence: false,
    snapWindowMs: 500,
    preserveReaction: false,
    ...overrides,
  };
}

describe('avoidWordSplit', () => {
  it('leaves a cut that is already between words exactly where it is', () => {
    // The common case, and it must not move: a point in a gap is already
    // correct, and nudging it would undo the silence snap for nothing.
    const spoken = words(5);
    const moved = avoidWordSplit(450, 950, { ...request({ words: spoken }) });
    expect(moved).toEqual({ start: 450, end: 950 });
  });

  it('pulls an in point back to the start of the word it landed inside', () => {
    // Keeping the word whole is the first choice: the clip opens on a whole
    // syllable rather than half of one.
    const spoken = words(5); // 0-400, 500-900, 1000-1400, …
    const moved = avoidWordSplit(1_200, 5_000, { ...request({ words: spoken }) });
    expect(moved.start).toBe(1_000);
  });

  it('pushes an out point forward to finish the word it landed inside', () => {
    const spoken = words(5);
    const moved = avoidWordSplit(0, 1_200, { ...request({ words: spoken }) });
    expect(moved.end).toBe(1_400);
  });

  it('drops the word instead when finishing it would overrun the maximum', () => {
    // The other way out. Both silence the fault; the choice is made on length.
    const spoken = words(5);
    const moved = avoidWordSplit(0, 1_200, {
      ...request({ words: spoken, minMs: 100, maxMs: 1_300 }),
    });
    expect(moved.end).toBe(1_000);
  });

  it('drops a word at the head when keeping it would overrun the maximum', () => {
    const spoken = words(5);
    const moved = avoidWordSplit(1_200, 1_500, {
      ...request({ words: spoken, minMs: 100, maxMs: 400 }),
    });
    expect(moved.start).toBe(1_400);
  });

  it('never moves a cut outside the event it belongs to', () => {
    // A word that starts before the event does must not drag the in point with
    // it: the clip cannot begin before its own material.
    const moved = avoidWordSplit(1_050, 4_000, {
      ...request({
        words: [{ start_ms: 200, end_ms: 1_400 }],
        range: { start_ms: 1_000, end_ms: 5_000 },
      }),
    });
    expect(moved.start).toBeGreaterThanOrEqual(1_000);
  });

  it('does nothing at all without word timings', () => {
    // Which is what makes the rule degrade rather than fail: a transcriber that
    // gives no word timings leaves the trimmer exactly as it was.
    expect(avoidWordSplit(1_200, 5_000, { ...request() })).toEqual({ start: 1_200, end: 5_000 });
  });
});

describe('chooseTrim with word timings', () => {
  it('does not stop in the middle of a word', () => {
    // The end-to-end version of the bug. Desired length puts the out point at
    // 1,200ms, which is inside the third word; there is no utterance boundary
    // anywhere near it, so nothing used to pull it out.
    const spoken = words(10);
    const trim = chooseTrim(
      request({
        words: spoken,
        speech: [{ start_ms: 0, end_ms: 4_500 }],
        desiredMs: 1_200,
        minMs: 500,
        maxMs: 3_000,
      }),
    );
    const split = spoken.find((w) => trim.out_ms > w.start_ms && trim.out_ms < w.end_ms);
    expect(split).toBeUndefined();
  });

  it('does not start in the middle of a word either', () => {
    const spoken = words(10, 2_000);
    const trim = chooseTrim(
      request({
        words: spoken,
        speech: [{ start_ms: 2_000, end_ms: 6_500 }],
        range: { start_ms: 0, end_ms: 20_000 },
        desiredMs: 2_000,
        minMs: 500,
        maxMs: 6_000,
        padInMs: 150,
      }),
    );
    const split = spoken.find((w) => trim.in_ms > w.start_ms && trim.in_ms < w.end_ms);
    expect(split).toBeUndefined();
  });

  it('still respects the clip bounds it was given', () => {
    const spoken = words(20);
    const trim = chooseTrim(
      request({
        words: spoken,
        speech: [{ start_ms: 0, end_ms: 9_500 }],
        desiredMs: 3_000,
        minMs: 2_000,
        maxMs: 4_000,
      }),
    );
    const length = trim.out_ms - trim.in_ms;
    expect(length).toBeGreaterThanOrEqual(2_000);
    expect(length).toBeLessThanOrEqual(4_000);
  });

  it('changes nothing for a clip with no words in it', () => {
    // The wordless path has to be untouched, because most footage is wordless
    // and this must not move a single frame of it.
    const silent = request({ speech: [], desiredMs: 4_000 });
    expect(chooseTrim({ ...silent, words: [] })).toEqual(chooseTrim(silent));
  });

  it('applies even on the wordless path, when there are words after all', () => {
    // `speech` is utterance-level and `words` is word-level, and the second can
    // be populated where the first is thin. The centre path picks a start by
    // skipping the first fraction of the take, and that guess lands wherever it
    // lands — including inside a word.
    const spoken = words(10);
    const trim = chooseTrim(request({ speech: [], words: spoken, desiredMs: 4_000 }));
    const split = spoken.find((w) => trim.in_ms > w.start_ms && trim.in_ms < w.end_ms);
    expect(split).toBeUndefined();
  });

  it('outranks the silence snap when the two disagree', () => {
    // Rule 1 is applied after rule 2 on purpose. A silence boundary is not
    // normally inside a word; when the detector says otherwise, the more
    // important rule is the one that wins.
    const spoken = [{ start_ms: 1_000, end_ms: 1_800 }];
    const trim = chooseTrim(
      request({
        words: spoken,
        speech: [{ start_ms: 1_000, end_ms: 1_800 }],
        // A "silence" starting mid-word, which is what an imprecise detector
        // hands over.
        silences: [{ start_ms: 1_400, end_ms: 2_000 }],
        snapToSilence: true,
        snapWindowMs: 800,
        desiredMs: 1_500,
        minMs: 400,
        maxMs: 3_000,
      }),
    );
    expect(trim.out_ms === 1_000 || trim.out_ms === 1_800 || trim.out_ms >= 1_800).toBe(true);
    expect(trim.out_ms > 1_000 && trim.out_ms < 1_800).toBe(false);
  });
});
