import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '@editorial-ir/cli';
import type { EditPlan } from '@editorial-ir/contracts';
import { applyOptions } from '../apps/cli/src/commands/apply.js';

/**
 * `oea apply` to the targets that are not editing applications: caption files,
 * a chapter list, an edit list — on the worked example, through the command a
 * user types.
 *
 * The adapters may not read the transcript (an adapter that planned captions
 * would be a second planner), so the command has to work them out before it
 * calls one. That hand-off is what these tests are about.
 */

let output: string[] = [];
beforeEach(() => {
  output = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

let root = '';
beforeAll(async () => {
  root = join(mkdtempSync(join(tmpdir(), 'oea-apply-')), 'demo');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await main(['demo', root])).toBe(0);
  expect(
    await main(['plan', '--project', root, '--skill', 'travel-vlog', '--duration', '180']),
  ).toBe(0);
  vi.restoreAllMocks();
}, 120_000);

function latestPlan(): EditPlan {
  const dir = join(root, '.oea', 'plans');
  const newest = readdirSync(dir)
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
  return JSON.parse(readFileSync(newest, 'utf8')) as EditPlan;
}

describe('oea apply, to captions', () => {
  it('works captions out for a subtitle file when the plan has none, without changing the plan', async () => {
    const before = latestPlan();
    expect(before.tracks.text.filter((t) => t.kind === 'caption')).toHaveLength(0);

    const out = join(root, 'srt-out');
    expect(await main(['apply', '--project', root, '--editor', 'srt', '--out', out])).toBe(0);
    const srt = readFileSync(join(out, 'timeline.srt'), 'utf8');
    expect(srt.startsWith('1\n00:00:00,')).toBe(true);
    // The worked example's first line, said as the first clip plays.
    expect(srt).toContain('そろそろ出発しよう');
    expect(output.join('')).toMatch(/worked out \d+ caption\(s\) from the transcript/);

    // The plan file is what a later apply reads, and it is left as it was.
    expect(latestPlan()).toEqual(before);
  }, 60_000);

  it('stores captions in the plan with plan --captions, and every caption target reads the same ones', async () => {
    expect(
      await main([
        'plan',
        '--project',
        root,
        '--skill',
        'travel-vlog',
        '--duration',
        '180',
        '--captions',
      ]),
    ).toBe(0);
    const plan = latestPlan();
    const captions = plan.tracks.text.filter((t) => t.kind === 'caption');
    expect(captions.length).toBeGreaterThan(10);

    const out = join(root, 'vtt-out');
    output = [];
    expect(await main(['apply', '--project', root, '--editor', 'vtt', '--out', out])).toBe(0);
    const vtt = readFileSync(join(out, 'timeline.vtt'), 'utf8');
    expect(vtt.match(/-->/g)).toHaveLength(captions.length);
    // Nothing had to be worked out: the plan already had them.
    expect(output.join('')).not.toMatch(/worked out/);
  }, 60_000);
});

describe('oea apply, with settings', () => {
  it('reads --option key=value as what each value looks like', () => {
    expect(
      applyOptions({
        options: ['burn_captions=false', 'width=320', 'record_start=01:00:00:00', 'jobs=2'],
      }),
    ).toEqual({ burn_captions: false, width: 320, record_start: '01:00:00:00', jobs: 2 });
    // --width is the same setting, spelled as a flag.
    expect(applyOptions({ width: 480 })).toEqual({ width: 480 });
  });

  it('refuses an option that is not key=value, rather than ignoring it', () => {
    expect(() => applyOptions({ options: ['width'] })).toThrow(/key=value/);
  });

  it('passes settings through to the adapter', async () => {
    const out = join(root, 'edl-out');
    expect(
      await main([
        'apply',
        '--project',
        root,
        '--editor',
        'edl',
        '--out',
        out,
        '--option',
        'record_start=01:00:00:00',
      ]),
    ).toBe(0);
    const edl = readFileSync(join(out, 'timeline.edl'), 'utf8');
    const first = edl.split('\n').find((line) => /^001 /.test(line))!;
    // The record side starts an hour in, as a broadcast master does.
    expect(first).toMatch(/01:00:00;00 \d\d:\d\d:\d\d;\d\d$/);
  }, 60_000);

  it('fails, and says why, when a target has nothing to write', async () => {
    // The worked example's plan has no chapter markers.
    const out = join(root, 'chapters-out');
    output = [];
    expect(
      await main(['apply', '--project', root, '--editor', 'youtube-chapters', '--out', out]),
    ).toBe(1);
    expect(output.join('')).toMatch(/nothing was written/);
  }, 60_000);
});
