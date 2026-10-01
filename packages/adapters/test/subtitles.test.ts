import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TextOperation } from '@editorial-ir/contracts';
import { SrtAdapter, VttAdapter, buildSrt, buildVtt, cueTime } from '../src/index.js';
import { mixedPlan, requestFor } from '../../../tests/support/plan.js';

/**
 * SubRip and WebVTT: the plan's captions, and nothing else.
 *
 * Both formats are simple enough to get subtly wrong — a comma where a dot
 * belongs, cues numbered from zero, a blank line inside a caption — and every
 * one of those is silently accepted by some players and refused by others.
 */

function caption(id: number, start: number, end: number, text: string): TextOperation {
  return {
    operation_id: `op_cap_${String(id).padStart(4, '0')}`,
    timeline_start_ms: start,
    timeline_end_ms: end,
    text,
    kind: 'caption',
    provenance: 'agent_derived',
  };
}

const CAPTIONED = mixedPlan({
  text: [
    // Out of order on purpose: files are written in the order they are shown.
    caption(2, 3_723_004, 3_725_000, 'R&D <3 --> later'),
    caption(1, 500, 2250, 'やっと\n着いた'),
    { ...caption(3, 4000, 6000, 'Harbour Days'), kind: 'title' },
  ],
});

describe('SubRip', () => {
  it('numbers cues from one, with comma milliseconds and hours', () => {
    expect(buildSrt(CAPTIONED)).toBe(
      [
        '1',
        '00:00:00,500 --> 00:00:02,250',
        'やっと',
        '着いた',
        '',
        '2',
        '01:02:03,004 --> 01:02:05,000',
        'R&D <3 --> later',
        '',
      ].join('\n'),
    );
  });

  it('never lets a blank line end a cue early', () => {
    const plan = mixedPlan({ text: [caption(1, 0, 1000, 'first\n\nsecond')] });
    expect(buildSrt(plan)).toBe('1\n00:00:00,000 --> 00:00:01,000\nfirst\nsecond\n');
  });

  it('writes the file, and says what it left out', async () => {
    const result = await new SrtAdapter().apply(requestFor(CAPTIONED));
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.kind).toBe('subtitles');
    expect(result.artifacts[0]!.path.endsWith('cut.srt')).toBe(true);
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe(buildSrt(CAPTIONED));
    expect(result.warnings.join(' ')).toMatch(/1 title/);
  });

  it('writes nothing for a plan with no captions, and says how to get some', async () => {
    const result = await new SrtAdapter().apply(requestFor(mixedPlan()));
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/oea plan --captions/);
  });
});

describe('WebVTT', () => {
  it('starts with the header and uses dot milliseconds', () => {
    const text = buildVtt(CAPTIONED);
    expect(text.startsWith('WEBVTT\n\n')).toBe(true);
    expect(text).toContain('00:00:00.500 --> 00:00:02.250\nやっと\n着いた');
    expect(text).not.toMatch(/\d,\d{3}/);
  });

  it('escapes what WebVTT reads as markup, and an arrow that would start a timing line', () => {
    const text = buildVtt(CAPTIONED);
    expect(text).toContain('R&amp;D &lt;3 → later');
    // Exactly one arrow per cue: its timing line.
    expect(text.match(/-->/g)).toHaveLength(2);
  });

  it('writes a .vtt beside the cut', async () => {
    const result = await new VttAdapter().apply(requestFor(CAPTIONED));
    expect(result.artifacts[0]!.path.endsWith('cut.vtt')).toBe(true);
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toBe(buildVtt(CAPTIONED));
  });
});

describe('cue times', () => {
  it('rounds to the millisecond and never goes negative', () => {
    expect(cueTime(1234.6, ',')).toBe('00:00:01,235');
    expect(cueTime(-5, '.')).toBe('00:00:00.000');
    expect(cueTime(36_000_000, '.')).toBe('10:00:00.000');
  });
});
