import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProjectStore } from '../src/store.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * Never write something that cannot be read back.
 *
 * `readIr` has always validated, and that was the wrong half of the pair. A
 * decision model returning a narrative role outside the closed set produced a
 * file that wrote cleanly and then failed its own schema the next time anything
 * opened it: the analysis gone, the project unusable, and the first the user
 * heard of it was the next command.
 */
function store() {
  const root = mkdtempSync(join(tmpdir(), 'oea-write-'));
  return new FileProjectStore(root);
}

describe('writing the analysis', () => {
  it('writes a valid one', () => {
    const project = store();
    const ir = makeIR({ events: [{ description: '出発' }] });
    project.writeIr(ir);
    expect(project.readIr()?.events).toHaveLength(1);
  });

  it('refuses one the next command could not read', () => {
    const project = store();
    const ir = makeIR({ events: [{ description: '出発' }] });
    // Cast through `unknown` on purpose: the type system already refuses this
    // value, which is the point — the run that produced it came from a model at
    // runtime, where no type was standing in the way.
    const broken = {
      ...ir,
      editorial: ir.editorial.map((entry) => ({
        ...entry,
        current: {
          ...entry.current,
          narrative_role: { ...entry.current.narrative_role, selected: 'opening_candidate' },
        },
      })),
    } as unknown as typeof ir;

    expect(() => project.writeIr(broken)).toThrow(/narrative_role/);
    // And nothing was left behind for the next command to trip over.
    expect(project.readIr()).toBeUndefined();
  });

  it('says what it was writing, so the stack still names the cause', () => {
    const project = store();
    const ir = makeIR({ events: [{ description: '出発' }] });
    const broken = { ...ir, stats: { ...ir.stats, event_count: -1 } };
    expect(() => project.writeIr(broken)).toThrow(/the analysis being written/);
  });
});
