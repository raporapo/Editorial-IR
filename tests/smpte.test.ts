import { describe, expect, it } from 'vitest';
import {
  framesToSmpte,
  isNtscRate,
  smpteToFrames,
  supportsDropFrame,
} from '@editorial-ir/contracts';

/**
 * SMPTE timecode: the one clock an edit list and the media agree on.
 *
 * A 29.97 camera writes drop-frame timecode, and a list counted without it
 * disagrees with the file's own clock by 3.6 seconds an hour — a conform by
 * timecode then picks the wrong frames, everywhere after the first minute.
 */
describe('drop-frame timecode', () => {
  it('makes an hour of labels an hour of time at 29.97', () => {
    // 107892 frames at 30000/1001 is 3599.9964 s; the labels read one hour.
    expect(framesToSmpte(107_892, 30_000, 1001)).toBe('01:00:00;00');
    expect(smpteToFrames('01:00:00;00', 30_000, 1001)).toBe(107_892);
  });

  it('skips :00 and :01 at every minute but each tenth', () => {
    expect(framesToSmpte(1799, 30_000, 1001)).toBe('00:00:59;29');
    expect(framesToSmpte(1800, 30_000, 1001)).toBe('00:01:00;02');
    expect(framesToSmpte(17_982, 30_000, 1001)).toBe('00:10:00;00');
  });

  it('skips four labels a minute at 59.94', () => {
    expect(framesToSmpte(3600, 60_000, 1001)).toBe('00:01:00;04');
    expect(smpteToFrames('00:01:00;04', 60_000, 1001)).toBe(3600);
  });

  it('reads back every frame it writes, at every rate that drops', () => {
    for (const num of [30_000, 60_000]) {
      for (let frames = 0; frames < 400_000; frames += 997) {
        expect(smpteToFrames(framesToSmpte(frames, num, 1001), num, 1001)).toBe(frames);
      }
    }
  });

  it('never drops frames where drop-frame is not defined', () => {
    // 23.976 has no drop-frame form; a `;` there is a mistake to ignore, not a
    // rule to follow.
    expect(supportsDropFrame(24_000, 1001)).toBe(false);
    expect(framesToSmpte(1800, 24_000, 1001)).toBe('00:01:15:00');
    expect(smpteToFrames('00:01:15;00', 24_000, 1001)).toBe(1800);
    expect(framesToSmpte(90_000, 25, 1)).toBe('01:00:00:00');
  });

  it('reads a label in the counting it is known to use, whatever its separator', () => {
    // A record start typed as 01:00:00:00 for a drop-frame list is the label
    // 01:00:00;00, which is 107892 frames — not the 108000 a non-drop reading
    // gives, which prints as 01:00:03;18.
    expect(smpteToFrames('01:00:00:00', 30_000, 1001, true)).toBe(107_892);
    expect(framesToSmpte(107_892, 30_000, 1001)).toBe('01:00:00;00');
    expect(smpteToFrames('01:00:00:00', 30_000, 1001)).toBe(108_000);
    // Where drop-frame is not defined, asking for it changes nothing.
    expect(smpteToFrames('01:00:00:00', 25, 1, true)).toBe(90_000);
  });

  it('reads the tag ffprobe reports, and refuses what is not a timecode', () => {
    expect(smpteToFrames('10:00:00:00', 25, 1)).toBe(900_000);
    expect(smpteToFrames('00:00:01:30', 30, 1)).toBeUndefined();
    expect(smpteToFrames('yesterday', 30, 1)).toBeUndefined();
    expect(smpteToFrames('', 30, 1)).toBeUndefined();
  });
});

describe('isNtscRate', () => {
  it('is true only for a whole rate slowed by 1000/1001', () => {
    // A VFR phone clip's measured average, 2500/101, is not NTSC anything.
    expect(isNtscRate(2500, 101)).toBe(false);
    expect(isNtscRate(30_000, 1001)).toBe(true);
    expect(isNtscRate(24_000, 1001)).toBe(true);
    expect(isNtscRate(30, 1)).toBe(false);
    expect(isNtscRate(29_970, 1000)).toBe(false);
  });
});
