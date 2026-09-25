import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '@editorial-ir/skills';
import { planEdit } from '../src/index.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * Why an event was left out, said once.
 *
 * Duplicate groups overlap — every relation opens one keyed by its source — and
 * each group that dropped an event wrote its own line for it.
 */
const registry = SkillRegistry.withBuiltIns();

describe('a take dropped for another take', () => {
  it('is explained once, however many duplicates it belonged to', () => {
    const built = makeIR({
      events: Array.from({ length: 4 }, (_, i) => ({
        description: `the same view ${i}`,
        metrics: { redundancy: 0.9, story_importance: [0.6, 0.5, 0.4, 0.9][i]! },
      })),
      relations: [
        ['evt_0001', 'duplicate_of', 'evt_0002'],
        ['evt_0001', 'duplicate_of', 'evt_0003'],
        ['evt_0002', 'duplicate_of', 'evt_0003'],
        ['evt_0003', 'duplicate_of', 'evt_0004'],
      ],
    });
    const plan = planEdit({
      ir: built,
      skill: registry.resolve('base-editor'),
      targetDurationMs: 30_000,
    });
    const lines = new Map<string, number>();
    for (const entry of plan.rationale) {
      lines.set(entry.event_id, (lines.get(entry.event_id) ?? 0) + 1);
    }
    // Measured on the probe's folder of clips: one event listed four times.
    expect([...lines.values()].every((count) => count === 1)).toBe(true);
    expect(plan.rationale.filter((r) => r.reason.startsWith('another take')).length).toBe(
      new Set(
        plan.rationale.filter((r) => r.reason.startsWith('another take')).map((r) => r.event_id),
      ).size,
    );
  });
});
