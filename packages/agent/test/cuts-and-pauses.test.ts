import { describe, expect, it } from 'vitest';
import {
  FLASH_FRAME_MS,
  avoidWordSplit,
  chooseTrim,
  pausesToRemove,
  piecesAfterRemoving,
  type TrimRequest,
} from '../src/trim.js';

/**
 * Where a clip starts and stops when the source is itself an edit, and what is
 * left of it when its pauses come out.
 *
 * The edit points below are the probe's edited programme: 1.5 s title card,
 * then shots of 3, 2.5, 3.5, 2 and 4 seconds.
 */
const EDITS = [0, 1500, 4500, 7000, 10_500, 12_500, 16_500];

const base: TrimRequest = {
  range: { start_ms: 0, end_ms: 16_500 },
  speech: [],
  silences: [],
  desiredMs: 5000,
  minMs: 1500,
  maxMs: 8000,
  padInMs: 150,
  padOutMs: 250,
  snapToSilence: true,
  snapWindowMs: 600,
  preserveReaction: false,
};

/** How much of a neighbouring shot a clip carries at each edge. */
function remnants(inMs: number, outMs: number): { head?: number; tail?: number } {
  const inside = EDITS.filter((cut) => cut > inMs && cut < outMs);
  return inside.length === 0
    ? {}
    : { head: inside[0]! - inMs, tail: outMs - inside[inside.length - 1]! };
}

describe('cutting where the edit already cut', () => {
  it('moves an edge onto the programme’s own cut when one is within reach', () => {
    // Wordless, so it opens at the event and runs 5 s: out at 5.0 s, half a
    // second into the 4.5 s shot. The edit's cut is 500 ms away.
    const trimmed = chooseTrim({ ...base, settle: false, cuts: EDITS });
    expect(trimmed.in_ms).toBe(0);
    expect(trimmed.out_ms).toBe(4500);
    expect(trimmed.reason).toBe('cut');
  });

  it('leaves no flash of the neighbouring shot, however far the nearest cut is', () => {
    // A window too narrow to reach a cut: without the guard this ends 300 ms into
    // the next shot, a flash of it.
    const trimmed = chooseTrim({
      ...base,
      range: { start_ms: 4500, end_ms: 16_500 },
      desiredMs: 2800,
      snapWindowMs: 100,
      settle: false,
      cuts: EDITS,
    });
    const { head, tail } = remnants(trimmed.in_ms, trimmed.out_ms);
    for (const remnant of [head, tail]) {
      if (remnant !== undefined) expect(remnant).toBeGreaterThanOrEqual(FLASH_FRAME_MS);
    }
    expect(trimmed.out_ms).toBe(7000);
  });

  it('keeps a remnant long enough to be a shot of its own', () => {
    // 800 ms of the next shot is a short shot, not a flash, and the window cannot
    // reach the cut: it stays.
    const trimmed = chooseTrim({
      ...base,
      range: { start_ms: 4500, end_ms: 16_500 },
      desiredMs: 3300,
      snapWindowMs: 100,
      settle: false,
      cuts: EDITS,
    });
    expect(trimmed.out_ms).toBe(7800);
  });

  it('outranks a quiet moment: the edit’s cut is a decision, a silence a guess', () => {
    const trimmed = chooseTrim({
      ...base,
      settle: false,
      cuts: EDITS,
      // A silence ending 200 ms from where the clip would stop, and the edit's
      // cut 500 ms away.
      silences: [{ start_ms: 5200, end_ms: 6000 }],
    });
    expect(trimmed.out_ms).toBe(4500);
  });

  it('changes nothing for raw footage, whose cuts are camera moves', () => {
    const without = chooseTrim({ ...base });
    const withCuts = chooseTrim({ ...base, cuts: [] });
    expect(withCuts).toEqual(without);
  });

  it('never cuts into a word to reach a cut, and leaves the way out that flashes', () => {
    // A word runs across the 4.5 s cut, as dialogue does in an edited programme.
    // Keeping it means 200 ms of the next shot; dropping it means none.
    const word = { start_ms: 4400, end_ms: 4700 };
    const moved = avoidWordSplit(1500, 4600, {
      words: [word],
      range: base.range,
      minMs: 1500,
      maxMs: 8000,
      cuts: EDITS,
    });
    expect(moved.end).toBe(4400);
    // Without the edit's cuts, keeping the word is still the first choice.
    const plain = avoidWordSplit(1500, 4600, {
      words: [word],
      range: base.range,
      minMs: 1500,
      maxMs: 8000,
    });
    expect(plain.end).toBe(4700);
  });

  it('still puts the word first when the cut can only be had through it', () => {
    const word = { start_ms: 4300, end_ms: 4700 };
    const trimmed = chooseTrim({
      ...base,
      settle: false,
      cuts: EDITS,
      words: [word],
    });
    expect(trimmed.out_ms <= word.start_ms || trimmed.out_ms >= word.end_ms).toBe(true);
  });
});

describe('where a wordless clip starts', () => {
  it('skips the first moments of a raw camera take, while the camera settles', () => {
    expect(chooseTrim({ ...base, snapToSilence: false }).in_ms).toBeGreaterThan(0);
  });

  it('starts where the event starts for anything a camera did not just start recording', () => {
    // An edited programme's shot, a clip the user trimmed, a screen recording, a
    // sound file: the probe's edited cut opened 1.2 s into every event.
    expect(chooseTrim({ ...base, snapToSilence: false, settle: false }).in_ms).toBe(0);
  });
});

describe('taking pauses out', () => {
  const words = [
    { start_ms: 1000, end_ms: 1400 },
    { start_ms: 1450, end_ms: 2000 },
    // a 1.5 s pause
    { start_ms: 3500, end_ms: 4000 },
    // a 400 ms breath, left alone
    { start_ms: 4400, end_ms: 5000 },
  ];
  const window = { start_ms: 800, end_ms: 5200 };
  const request = { window, silences: [], words, minPauseMs: 700, handleMs: 120 };

  it('takes out a pause between words, less a handle each side', () => {
    expect(pausesToRemove(request)).toEqual([{ start_ms: 2120, end_ms: 3380 }]);
  });

  it('leaves a pause shorter than the skill’s minimum', () => {
    expect(pausesToRemove({ ...request, minPauseMs: 1600 })).toEqual([]);
  });

  it('never reaches into a word, even where the level meter says silence', () => {
    // A silence that overlaps the start of a word: the word is not silent.
    const removed = pausesToRemove({
      ...request,
      silences: [{ start_ms: 2000, end_ms: 3700 }],
    });
    for (const span of removed) {
      for (const word of words) {
        expect(span.end_ms <= word.start_ms || span.start_ms >= word.end_ms).toBe(true);
      }
    }
  });

  it('takes dead air at the edge of a clip out to the edge, keeping the handle by the words', () => {
    // The screen-recording probe: each slide opened on two seconds of an
    // unchanged screen before the voice-over, and closed on five.
    const removed = pausesToRemove({
      ...request,
      window: { start_ms: 0, end_ms: 10_000 },
      words: [],
      silences: [
        { start_ms: 0, end_ms: 2000 },
        { start_ms: 5000, end_ms: 10_000 },
      ],
    });
    expect(removed).toEqual([
      { start_ms: 0, end_ms: 1880 },
      { start_ms: 5120, end_ms: 10_000 },
    ]);
  });

  it('never takes a clip out entirely', () => {
    expect(
      pausesToRemove({
        ...request,
        words: [],
        silences: [{ start_ms: 0, end_ms: 6000 }],
      }),
    ).toEqual([]);
  });

  it('does not treat a gap between words over music as a pause', () => {
    // Under a music bed the words stop and the music does not; cutting there
    // chops the music.
    expect(pausesToRemove({ ...request, music: [{ start_ms: 0, end_ms: 6000 }] })).toEqual([]);
  });

  it('takes a wordless sliver between two pauses out with them', () => {
    // A cough between two long pauses would otherwise be a clip of its own.
    const removed = pausesToRemove({
      window: { start_ms: 0, end_ms: 10_000 },
      words: [
        { start_ms: 500, end_ms: 1000 },
        { start_ms: 8000, end_ms: 8500 },
      ],
      silences: [
        { start_ms: 1000, end_ms: 4000 },
        { start_ms: 4300, end_ms: 8000 },
      ],
      minPauseMs: 700,
      handleMs: 120,
    });
    expect(removed).toEqual([{ start_ms: 1120, end_ms: 7880 }]);
  });

  it('leaves pieces that together are the clip less what was removed', () => {
    const removed = pausesToRemove(request);
    const pieces = piecesAfterRemoving(window, removed);
    expect(pieces).toEqual([
      { start_ms: 800, end_ms: 2120 },
      { start_ms: 3380, end_ms: 5200 },
    ]);
    const kept = pieces.reduce((sum, p) => sum + p.end_ms - p.start_ms, 0);
    const taken = removed.reduce((sum, p) => sum + p.end_ms - p.start_ms, 0);
    expect(kept + taken).toBe(window.end_ms - window.start_ms);
  });
});
