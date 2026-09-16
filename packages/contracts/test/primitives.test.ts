import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_AUTHORITY,
  durationOf,
  formatTimecode,
  idSchema,
  newId,
  outranks,
  overlapMs,
  parseTimecode,
  rangesOverlap,
  seqId,
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
