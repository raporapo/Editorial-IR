import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditPlan, ValidationReport } from '@editorial-ir/contracts';
import { main } from '../src/index.js';
import { skillOfPlan } from '../src/commands/plan.js';

/**
 * `oea review` checks a stored plan against the skill it was made with.
 *
 * It validated without one, so everything only the skill knows — the speech
 * share a talking-head cut promises, the limit that explains why a cut came in
 * short — was checked by `oea plan` once and never again.
 */
let output: string[] = [];

beforeEach(() => {
  output = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const stub = (name: string, version = '0.1.0') => ({ skill: { name, version } }) as EditPlan;

describe('the skill a plan was made with', () => {
  it('is found again by its name and version', () => {
    expect(skillOfPlan(stub('talking-head'))?.name).toBe('talking-head');
  });

  it('is found in the user’s own skills directory when told where it is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oea-skills-'));
    mkdirSync(join(dir, 'wedding'));
    writeFileSync(
      join(dir, 'wedding', 'skill.yaml'),
      'name: wedding\nversion: 0.2.0\nextends: [memory-film]\n',
    );
    expect(skillOfPlan(stub('wedding', '0.2.0'))).toBeUndefined();
    expect(skillOfPlan(stub('wedding', '0.2.0'), dir)?.extends).toEqual(['memory-film']);
  });

  it('is not guessed at when the name or the version no longer match', () => {
    expect(skillOfPlan(stub('wedding'))).toBeUndefined();
    expect(skillOfPlan(stub('talking-head', '9.9.9'))).toBeUndefined();
  });

  it('is what `oea review` validates against', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'oea-review-')), 'demo');
    expect(await main(['demo', root])).toBe(0);
    // Two minutes of talking-head from a travel day comes in at 100 s: four
    // moments at 25 s each, and only the skill can say that is why.
    expect(
      await main(['plan', '--project', root, '--skill', 'talking-head', '--duration', '120']),
    ).toBe(0);

    output = [];
    await main(['review', '--project', root, '--json']);
    const { validation } = JSON.parse(output.join('')) as { validation: ValidationReport };
    const short = validation.issues.find((i) => i.code === 'duration_out_of_tolerance');
    expect(short?.details).toHaveProperty('longest_possible_ms');
  }, 60_000);
});
