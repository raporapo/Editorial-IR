import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';
import { displayWidth, truncate } from '../src/ui.js';

/**
 * The CLI is tested by running it.
 *
 * Every command in the documented walkthrough is exercised here, in order,
 * against the worked example: a quick start that has quietly stopped working is
 * the fastest way to lose someone on their first attempt.
 */
let output: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  output = [];
  errors = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const stdout = () => output.join('');
const stderr = () => errors.join('');

describe('the walkthrough in the README', () => {
  it('runs from demo to an exported timeline', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');

    expect(await main(['demo', root])).toBe(0);
    // These four are quoted verbatim in the README, which is the first thing
    // anyone reads. A figure that has quietly moved makes the whole page look
    // like it is describing a different program.
    expect(stdout()).toContain('73 events');
    expect(stdout()).toContain('shots: 104');
    expect(stdout()).toContain('relations: 450');
    expect(stdout()).toContain('cost: nothing');

    output = [];
    expect(await main(['timeline', '--project', root])).toBe(0);
    expect(stdout()).toContain('evt_0001');

    output = [];
    expect(
      await main(['plan', '--project', root, '--skill', 'travel-vlog', '--duration', '180']),
    ).toBe(0);
    expect(stdout()).toContain('clips');
    expect(stdout()).toMatch(/00:0[23]:\d\d/);

    output = [];
    expect(await main(['apply', '--project', root, '--editor', 'otio'])).toBe(0);
    const timeline = join(root, 'output', 'timeline.otio');
    expect(existsSync(timeline)).toBe(true);
    expect(JSON.parse(readFileSync(timeline, 'utf8')).OTIO_SCHEMA).toBe('Timeline.1');
  }, 60_000);

  it('explains why a moment was kept or cut', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);
    await main(['plan', '--project', root, '--skill', 'travel-vlog', '--duration', '180']);

    output = [];
    expect(await main(['explain', 'evt_0002', '--project', root])).toBe(0);
    const text = stdout();
    expect(text).toContain('how it was judged');
    expect(text).toContain('story_importance');
    expect(text).toContain('in the latest plan');
  }, 60_000);

  it('records an annotation and honours it on the next plan', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);

    output = [];
    expect(await main(['annotate', 'evt_0005', 'essential', '--project', root])).toBe(0);
    expect(stdout()).toContain('essential on evt_0005');

    output = [];
    expect(
      await main([
        'analyze',
        '--project',
        root,
        '--perception',
        `fixture:${join(root, 'perception.fixture.json')}`,
      ]),
    ).toBe(0);
    output = [];
    expect(
      await main(['plan', '--project', root, '--skill', 'shorts', '--duration', '40', '--json']),
    ).toBe(0);

    const plan = JSON.parse(stdout());
    // A short has room for fourteen clips; this one is in because it was asked for.
    expect(plan.tracks.video.some((o: { event_id: string }) => o.event_id === 'evt_0005')).toBe(
      true,
    );
  }, 90_000);

  it('produces machine-readable output when asked', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);

    output = [];
    expect(await main(['timeline', '--project', root, '--json'])).toBe(0);
    expect(Array.isArray(JSON.parse(stdout()))).toBe(true);

    output = [];
    expect(await main(['context', '--project', root, '--json'])).toBe(0);
    expect(JSON.parse(stdout()).background.occasion).toBe('交際1周年旅行');
  }, 60_000);
});

describe('the commands that need no project', () => {
  it('lists the skills and explains one', async () => {
    expect(await main(['skills'])).toBe(0);
    expect(stdout()).toContain('travel-vlog');

    output = [];
    expect(await main(['skills', 'travel-vlog'])).toBe(0);
    expect(stdout()).toContain('what it weighs');
    expect(stdout()).toContain('story_importance');
  });

  it('lists the editors and what each can take', async () => {
    expect(await main(['editors'])).toBe(0);
    for (const id of ['otio', 'premiere', 'aviutl2']) expect(stdout()).toContain(id);
  });

  it('prints a schema', async () => {
    expect(await main(['schema', 'EditPlan'])).toBe(0);
    const schema = JSON.parse(stdout());
    expect(schema.$id).toContain('EditPlan');
  });

  it('reports what is installed', async () => {
    const code = await main(['doctor']);
    // Exits non-zero when something needs attention, which is the point.
    expect([0, 1]).toContain(code);
    expect(stdout()).toContain('what is configured');
  });

  it('shows help, and says so when a command does not exist', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(stdout()).toContain('oea init');

    errors = [];
    expect(await main(['frobnicate'])).toBe(2);
    expect(stderr()).toContain('no command called');
  });

  it('rejects an unknown flag rather than ignoring it', async () => {
    expect(await main(['timeline', '--colour'])).toBe(2);
    expect(stderr()).toContain('--colour');
  });
});

describe('terminal widths', () => {
  it('counts Japanese as full width, or every table would misalign', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('やっと')).toBe(6);
    expect(displayWidth('aあ')).toBe(3);
  });

  it('truncates on column width rather than code points', () => {
    expect(displayWidth(truncate('ややややややや', 8))).toBeLessThanOrEqual(8);
    expect(truncate('short', 20)).toBe('short');
  });
});

describe('reviewing a cut', () => {
  it('reads the latest plan back and reports on it', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);
    await main([
      'plan',
      '--project',
      root,
      '--skill',
      'travel-vlog',
      '--duration',
      '180',
      '--quiet',
    ]);

    output = [];
    expect(await main(['review', '--project', root])).toBe(0);
    const text = stdout();
    expect(text).toContain('validity');
    expect(text).toContain('how it reads');
  }, 60_000);

  it('says what to do when there is no plan', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);
    await expect(main(['review', '--project', root])).rejects.toThrow(/no plan yet/);
  }, 60_000);
});

describe('the agent command', () => {
  it('says how to configure a model, and that it is not required', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);

    const saved = {
      base: process.env.OEA_AGENT_BASE_URL,
      decision: process.env.OEA_DECISION_BASE_URL,
    };
    delete process.env.OEA_AGENT_BASE_URL;
    delete process.env.OEA_DECISION_BASE_URL;
    try {
      await expect(main(['agent', 'three minutes', '--project', root])).rejects.toThrow(
        /needs a model/,
      );
    } finally {
      if (saved.base) process.env.OEA_AGENT_BASE_URL = saved.base;
      if (saved.decision) process.env.OEA_DECISION_BASE_URL = saved.decision;
    }
  }, 60_000);
});

/** An IR read back from disk, as far as the comparisons below look into it. */
interface StoredIr {
  project: { perception?: string } & Record<string, unknown>;
  model_runs: Record<string, unknown>[];
  editorial: ({ current: Record<string, unknown> } & Record<string, unknown>)[];
  stats: Record<string, unknown>;
  [key: string]: unknown;
}

describe('re-analysing a project', () => {
  it('uses the perception it was analysed with the first time', async () => {
    // `oea annotate` ends by telling you to run `oea analyze`, and following
    // that advice used to destroy the project: the demo is compiled from a
    // recorded fixture passed as a flag, the flag was never stored, and a plain
    // re-analysis silently fell back to local perception. Seventy-three events
    // became three, and nothing said why.
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);

    const before = JSON.parse(readFileSync(join(root, '.oea', 'ir.json'), 'utf8'));
    expect(before.events.length).toBeGreaterThan(50);

    output = [];
    expect(await main(['analyze', '--project', root])).toBe(0);

    const after = JSON.parse(readFileSync(join(root, '.oea', 'ir.json'), 'utf8'));
    expect(after.events).toHaveLength(before.events.length);
  }, 60_000);

  it('records what it used, so the choice survives the command line', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);

    const project = JSON.parse(readFileSync(join(root, '.oea', 'project.json'), 'utf8'));
    expect(project.perception).toMatch(/^fixture:/);
  }, 60_000);

  it('compiles an unchanged project to the same IR the second time', async () => {
    // The IR carries the project record, and the perception this command stores
    // used to be written only after the compile had read that record. The first
    // IR of every project had no `perception` and every later one had it, so two
    // analyses of the same footage with the same models were different IRs.
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);
    const read = (): StoredIr =>
      JSON.parse(readFileSync(join(root, '.oea', 'ir.json'), 'utf8')) as StoredIr;
    // The values tests/compile.test.ts documents as belonging to one run.
    const stable = (ir: StoredIr) =>
      JSON.stringify({
        ...ir,
        generated_at: null,
        project: { ...ir.project, updated_at: null },
        model_runs: ir.model_runs.map((r) => ({
          ...r,
          id: null,
          created_at: null,
          latency_ms: null,
        })),
        editorial: ir.editorial.map((e) => ({
          ...e,
          current: { ...e.current, model_run_id: null },
        })),
        stats: { ...ir.stats, compile_ms: null },
      });

    const first = read();
    expect(first.project.perception).toMatch(/^fixture:/);
    output = [];
    expect(await main(['analyze', '--project', root])).toBe(0);
    expect(stable(read())).toBe(stable(first));
  }, 60_000);

  it('names the perception that made the IR, not the one before it', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);
    // The same recording at another path: a different perception by name, and
    // nothing else changed.
    const again = join(root, 'again.fixture.json');
    writeFileSync(again, readFileSync(join(root, 'perception.fixture.json')));

    output = [];
    expect(await main(['analyze', '--project', root, '--perception', `fixture:${again}`])).toBe(0);
    const ir = JSON.parse(readFileSync(join(root, '.oea', 'ir.json'), 'utf8'));
    const project = JSON.parse(readFileSync(join(root, '.oea', 'project.json'), 'utf8'));
    expect(ir.project.perception).toBe(`fixture:${again}`);
    expect(ir.project).toEqual(project);
  }, 60_000);

  it('folds a correction in without losing the analysis', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);

    output = [];
    expect(await main(['annotate', 'evt_0055', 'role', 'ending', '--project', root])).toBe(0);
    expect(await main(['analyze', '--project', root])).toBe(0);

    const ir = JSON.parse(readFileSync(join(root, '.oea', 'ir.json'), 'utf8'));
    const entry = ir.editorial.find((e: { event_id: string }) => e.event_id === 'evt_0055');
    expect(entry.current.narrative_role.selected).toBe('ending');
  }, 60_000);

  it('refuses a narrative role that does not exist', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);

    // Stored-and-ignored is the failure this replaced.
    await expect(
      main(['annotate', 'evt_0055', 'role', 'endin', '--project', root]),
    ).rejects.toThrow(/not a narrative role/);
  }, 60_000);

  it('wants a pair of events for continuity, which is about two of them', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);

    await expect(
      main(['annotate', 'evt_0031', 'continuity', '0.9', '--project', root]),
    ).rejects.toThrow(/pair/);
    expect(
      await main(['annotate', 'evt_0031..evt_0032', 'continuity', '0.9', '--project', root]),
    ).toBe(0);
  }, 60_000);
});

describe('the first five minutes', () => {
  it('says a file could not be read as a failure, not as "ok 0 added"', async () => {
    // This is the first command anyone runs on their own footage, and on a
    // machine without ffmpeg every file fails. It used to print "ok 0 added"
    // above a list of errors: a headline contradicting its own body.
    const root = mkdtempSync(join(tmpdir(), 'oea-cli-'));
    await main(['init', root, '--title', 'test']);

    // A real file ffprobe cannot read, which is what a machine with no ffmpeg
    // sees for every file it is given.
    const media = join(root, 'clip.mov');
    writeFileSync(media, 'not really a movie');

    output = [];
    errors = [];
    const code = await main(['ingest', media, '--project', root]);

    expect(code).toBe(1);
    expect(stdout() + stderr()).not.toContain('ok 0 added');
    expect(stdout() + stderr()).toContain('could not read');
  }, 60_000);

  it('says a path that is not there is not there, rather than throwing ENOENT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oea-cli-'));
    await main(['init', root, '--title', 'test']);

    // A typo used to surface a Node stack trace through statSync.
    await expect(
      main(['ingest', join(root, 'nothing-here.mov'), '--project', root]),
    ).rejects.toThrow(/there is nothing at/);
  }, 60_000);

  it('lists the skills it does have when asked for one it does not', async () => {
    output = [];
    errors = [];
    expect(await main(['skills', 'travelvlog'])).toBe(1);
    // Every other command that takes a name does this. For a typo it is the
    // difference between a dead end and an answer.
    expect(stdout() + stderr()).toContain('travel-vlog');
  }, 60_000);
});

describe('oea search', () => {
  // The command had no test at all, on a feature whose ranking had a real bug
  // in it: unrelated events were being returned as confident-looking matches.
  async function searchable(): Promise<string> {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);
    output = [];
    errors = [];
    return root;
  }

  it('finds the moment a word actually appears in', async () => {
    const root = await searchable();
    expect(await main(['search', 'ラーメン', '--project', root])).toBe(0);
    expect(stdout()).toContain('result');
    expect(stdout()).toMatch(/evt_\d+/);
  }, 60_000);

  it('says why it found nothing, rather than only that it found nothing', async () => {
    // The default index is lexical, and somebody searching in the wrong language
    // needs to know that is what happened rather than that their footage is
    // missing.
    const root = await searchable();
    expect(await main(['search', 'zzzznotathing', '--project', root])).toBe(0);
    expect(stdout() + stderr()).toContain('lexical');
  }, 60_000);

  it('searches one aspect when asked', async () => {
    const root = await searchable();
    expect(await main(['search', 'night_view', '--aspect', 'visual', '--project', root])).toBe(0);
    expect(stdout()).toMatch(/evt_\d+/);
  }, 60_000);

  it('answers as JSON with the scores that produced the ranking', async () => {
    const root = await searchable();
    expect(await main(['search', 'ラーメン', '--project', root, '--json'])).toBe(0);
    const hits = JSON.parse(stdout()) as { lexical_score: number; vector_score: number }[];
    expect(hits.length).toBeGreaterThan(0);
    // Every hit under the default encoder shares a word with the query; a score
    // without one is a hash collision.
    for (const hit of hits) expect(hit.lexical_score).toBeGreaterThan(0);
  }, 60_000);

  it('honours a limit', async () => {
    const root = await searchable();
    expect(await main(['search', 'night_view', '--project', root, '--limit', '2', '--json'])).toBe(
      0,
    );
    expect((JSON.parse(stdout()) as unknown[]).length).toBeLessThanOrEqual(2);
  }, 60_000);

  it('needs something to look for', async () => {
    const root = await searchable();
    expect(await main(['search', '--project', root])).toBe(2);
  }, 60_000);
});

describe('oea explain', () => {
  it('says when a decision was the user’s rather than the model’s', async () => {
    // A correction that applied silently looks exactly like one that did not,
    // and "because you told me" is the most important answer this command has.
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);
    await main(['annotate', 'evt_0031', 'mood', 'excitement=0.9, sadness=0', '--project', root]);
    await main(['annotate', 'evt_0055', 'role', 'ending', '--project', root]);
    await main(['analyze', '--project', root]);

    output = [];
    expect(await main(['explain', 'evt_0031', '--project', root])).toBe(0);
    expect(stdout()).toContain('what you said');
    expect(stdout()).toContain('excitement 0.9');

    output = [];
    expect(await main(['explain', 'evt_0055', '--project', root])).toBe(0);
    expect(stdout()).toContain('role');
    expect(stdout()).toContain('comes back');
  }, 60_000);
});

describe('oea inspect', () => {
  it('shows what an event is actually made of', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);
    output = [];

    expect(await main(['inspect', 'evt_0014', '--project', root])).toBe(0);
    expect(stdout()).toContain('shots');
    expect(stdout()).toMatch(/sht_|shot_/);
  }, 60_000);

  it('explains an empty result instead of printing nothing', async () => {
    // The worked example replays a recorded analysis, so it genuinely has no
    // frames. "frames (0)" on its own reads as a broken tool.
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);
    output = [];

    expect(await main(['inspect', 'evt_0014', '--project', root, '--frames'])).toBe(0);
    expect(stdout()).toContain('no sampled frames');
    expect(stdout()).toContain('oea ingest');
  }, 60_000);

  it('names the event it cannot find', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-cli-')), 'demo');
    await main(['demo', root]);
    output = [];

    expect(await main(['inspect', 'evt_9999', '--project', root])).toBe(1);
    expect(stderr() + stdout()).toContain('evt_9999');
  }, 60_000);
});

describe('the binary itself', () => {
  /**
   * Everything else in this file calls `main()` directly, which is the right
   * way to test the commands and the wrong way to test the process: the entry
   * point installs the handler that keeps a closed pipe from looking like a
   * crash, and only a real process has a real pipe to close.
   */
  const entry = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

  function runPipedToHead(args: string[]): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      // Read one chunk and slam the pipe shut, which is what `| head -1` does.
      child.stdout.once('data', () => child.stdout.destroy());
      child.stdout.on('error', () => undefined);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
  }

  it('does not crash when its output is piped into something that stops reading', async () => {
    // `oea timeline | head` and quitting `less` halfway are both normal. Node's
    // default for either is an unhandled EPIPE and a stack trace, which reads
    // as a crash caused by doing nothing wrong.
    const { code, stderr } = await runPipedToHead(['skills']);
    expect(stderr).not.toContain('EPIPE');
    expect(stderr).not.toContain('Unhandled');
    expect(code).toBe(0);
  }, 60_000);
});
