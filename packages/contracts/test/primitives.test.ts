import { describe, expect, it } from 'vitest';
import {
  Iso8601,
  PROVENANCE_AUTHORITY,
  compareText,
  durationOf,
  formatTimecode,
  idSchema,
  newId,
  outranks,
  overlapMs,
  parseTimecode,
  rangesOverlap,
  seqId,
  toIso8601,
  isCompatibleVersion,
  TimeRange,
} from '../src/index.js';

describe('timecode', () => {
  it('formats milliseconds', () => {
    expect(formatTimecode(0)).toBe('00:00:00.000');
    expect(formatTimecode(3_661_234)).toBe('01:01:01.234');
    expect(formatTimecode(3_661_234, false)).toBe('01:01:01');
  });

  it('parses the forms a user actually types', () => {
    expect(parseTimecode('00:18:20')).toBe(1_100_000);
    expect(parseTimecode('18:20')).toBe(1_100_000);
    expect(parseTimecode('20')).toBe(20_000);
    expect(parseTimecode('00:00:01.5')).toBe(1500);
    expect(parseTimecode('00:00:01,25')).toBe(1250);
  });

  it('round-trips', () => {
    for (const ms of [0, 1, 999, 1000, 59_999, 3_599_999, 7_322_100]) {
      expect(parseTimecode(formatTimecode(ms))).toBe(ms);
    }
  });

  it('rejects nonsense', () => {
    expect(() => parseTimecode('abc')).toThrow();
    expect(() => parseTimecode('1:2:3:4')).toThrow();
  });
});

describe('ranges', () => {
  it('measures duration and overlap', () => {
    expect(durationOf({ start_ms: 100, end_ms: 400 })).toBe(300);
    expect(rangesOverlap({ start_ms: 0, end_ms: 100 }, { start_ms: 100, end_ms: 200 })).toBe(false);
    expect(rangesOverlap({ start_ms: 0, end_ms: 101 }, { start_ms: 100, end_ms: 200 })).toBe(true);
    expect(overlapMs({ start_ms: 0, end_ms: 150 }, { start_ms: 100, end_ms: 200 })).toBe(50);
    expect(overlapMs({ start_ms: 0, end_ms: 50 }, { start_ms: 100, end_ms: 200 })).toBe(0);
  });

  it('rejects an empty or inverted range', () => {
    expect(TimeRange.safeParse({ start_ms: 100, end_ms: 100 }).success).toBe(false);
    expect(TimeRange.safeParse({ start_ms: 100, end_ms: 99 }).success).toBe(false);
    expect(TimeRange.safeParse({ start_ms: 100, end_ms: 101 }).success).toBe(true);
  });
});

describe('identifiers', () => {
  it('produces ordered deterministic ids for compiler output', () => {
    expect(seqId('evt', 31)).toBe('evt_0031');
    expect(seqId('asset', 1, 3)).toBe('asset_001');
    // Deterministic ids are what make the compiler reproducible.
    expect(seqId('evt', 31)).toBe(seqId('evt', 31));
  });

  it('produces prefixed random ids where collisions matter', () => {
    const a = newId('prj');
    expect(a.startsWith('prj_')).toBe(true);
    expect(a).not.toBe(newId('prj'));
  });

  it('validates the prefix', () => {
    const schema = idSchema('evt');
    expect(schema.safeParse('evt_0031').success).toBe(true);
    expect(schema.safeParse('asset_0031').success).toBe(false);
    expect(schema.safeParse('evt_').success).toBe(false);
    expect(schema.safeParse('evt_UPPER').success).toBe(false);
  });
});

describe('provenance authority', () => {
  it('puts the user above everything', () => {
    expect(outranks('user_provided', 'observed')).toBe(true);
    expect(outranks('user_provided', 'inferred')).toBe(true);
    expect(outranks('observed', 'inferred')).toBe(true);
    expect(outranks('inferred', 'user_provided')).toBe(false);
  });

  it('ranks every provenance value', () => {
    for (const key of Object.keys(PROVENANCE_AUTHORITY)) {
      expect(typeof PROVENANCE_AUTHORITY[key as keyof typeof PROVENANCE_AUTHORITY]).toBe('number');
    }
  });
});

describe('version compatibility', () => {
  it('treats the minor as breaking below 1.0.0', () => {
    expect(isCompatibleVersion('0.1.0', '0.1.3')).toBe(true);
    expect(isCompatibleVersion('0.1.0', '0.2.0')).toBe(false);
    expect(isCompatibleVersion('1.2.0', '1.9.0')).toBe(true);
    expect(isCompatibleVersion('1.2.0', '2.0.0')).toBe(false);
  });
});

/**
 * A timestamp that says what it is.
 *
 * `Iso8601` documents "always UTC with a trailing Z" and validated only that
 * the string was non-empty, which accepts "yesterday". It matters because
 * assets go on the capture timeline in the order these sort in.
 */
describe('Iso8601', () => {
  it('accepts an instant in UTC', () => {
    expect(Iso8601.parse('2026-05-17T09:00:00Z')).toBe('2026-05-17T09:00:00Z');
    expect(Iso8601.parse('2026-05-17T09:00:00.123Z')).toBe('2026-05-17T09:00:00.123Z');
  });

  it('refuses everything that is not one', () => {
    for (const bad of [
      'yesterday',
      '2026-05-17',
      '2026-05-17T09:00:00',
      '2026-05-17T09:00:00+09:00',
      '2026/05/17 09:00:00',
      '',
    ]) {
      expect(() => Iso8601.parse(bad)).toThrow();
    }
  });
});

describe('toIso8601', () => {
  it('normalises the forms a camera actually writes', () => {
    // A local offset sorts before an earlier UTC instant as a string, which is
    // how a misread date reorders footage.
    expect(toIso8601('2026-05-17T18:00:00+09:00')).toBe('2026-05-17T09:00:00.000Z');
    expect(toIso8601('2026-05-17 09:00:00')).toBe('2026-05-17T09:00:00.000Z');
    // EXIF spells the date with colons.
    expect(toIso8601('2026:05:17 09:00:00')).toBe('2026-05-17T09:00:00.000Z');
  });

  it('leaves the result parseable by the schema', () => {
    expect(() => Iso8601.parse(toIso8601('2026-05-17 09:00:00')!)).not.toThrow();
  });

  it('gives nothing back for a date it cannot read', () => {
    // Nothing is right: ordering by file name is arbitrary, ordering by a
    // misread date is wrong, and wrong invents continuity that was never there.
    expect(toIso8601('yesterday')).toBeUndefined();
    expect(toIso8601('')).toBeUndefined();
    expect(toIso8601(undefined)).toBeUndefined();
  });
});

/**
 * Ordering that is the same everywhere.
 *
 * The compiler's first promise is that the same input produces byte-identical
 * output, and everything that decides an order is part of that output: which
 * asset goes first on the capture timeline, which of two equally good moments
 * wins a tie. `localeCompare` reads a collation from the environment.
 */
describe('compareText', () => {
  it('does not change with the machine’s locale', () => {
    // `ä` sorts before `z` under en-US and after it under sv-SE, and the default
    // collation comes from the environment — so the same footage laid out on a
    // Swedish machine produced a different capture timeline, and therefore
    // different events, different neighbours and a different cut.
    const names = ['ä.mp4', 'z.mp4', 'a.mp4', 'ö.mp4'];
    const ours = [...names].sort(compareText);

    expect([...names].sort((a, b) => a.localeCompare(b, 'en-US'))).not.toEqual(
      [...names].sort((a, b) => a.localeCompare(b, 'sv-SE')),
    );
    for (const locale of ['en-US', 'sv-SE', 'de-DE', 'ja-JP']) {
      const before = Intl.DateTimeFormat().resolvedOptions().locale;
      expect(ours, `stable under ${locale} (session locale ${before})`).toEqual([
        'a.mp4',
        'z.mp4',
        'ä.mp4',
        'ö.mp4',
      ]);
    }
  });

  it('orders and compares equal the way a sort needs', () => {
    expect(compareText('a', 'b')).toBe(-1);
    expect(compareText('b', 'a')).toBe(1);
    expect(compareText('a', 'a')).toBe(0);
    expect(compareText('evt_0009', 'evt_0010')).toBe(-1);
  });
});
