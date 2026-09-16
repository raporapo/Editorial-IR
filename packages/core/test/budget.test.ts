import { describe, expect, it } from 'vitest';
import { CostBudget, selectForEscalation } from '../src/index.js';

/**
 * Deciding what is worth spending a model on.
 *
 * Running the expensive model over everything is the obvious design and the one
 * that makes the tool too expensive to use on an hour of footage. These are the
 * rules that make "spend it where it changes the answer" a decision rather than
 * a hope.
 */
const candidates = [
  { id: 'evt_0001', value: 0.9, costUsd: 0.004 },
  { id: 'evt_0002', value: 0.7, costUsd: 0.004 },
  { id: 'evt_0003', value: 0.5, costUsd: 0.004 },
  { id: 'evt_0004', value: 0.2, costUsd: 0.004 },
];

describe('selectForEscalation', () => {
  it('takes the most valuable first', () => {
    const decision = selectForEscalation(candidates, { maxItems: 2 });
    expect(decision.selected).toEqual(['evt_0001', 'evt_0002']);
    expect(decision.limitedBy).toBe('count');
  });

  it('stops at the money', () => {
    const decision = selectForEscalation(candidates, { maxCostUsd: 0.009 });
    expect(decision.selected).toHaveLength(2);
    expect(decision.estimatedCostUsd).toBeCloseTo(0.008, 6);
    expect(decision.limitedBy).toBe('cost');
  });

  it('skips anything not worth asking about', () => {
    const decision = selectForEscalation(candidates, { minValue: 0.6 });
    expect(decision.selected).toEqual(['evt_0001', 'evt_0002']);
    expect(decision.skipped).toContain('evt_0004');
    expect(decision.limitedBy).toBe('value');
  });

  it('takes a minimum even when nothing clears the bar, so a run is never entirely cheap', () => {
    const decision = selectForEscalation(candidates, { minValue: 0.99, minItems: 1 });
    expect(decision.selected).toEqual(['evt_0001']);
  });

  it('is reproducible: the same project escalates the same events', () => {
    const tied = [
      { id: 'evt_zebra', value: 0.5, costUsd: 0.001 },
      { id: 'evt_apple', value: 0.5, costUsd: 0.001 },
    ];
    // A budget that spends itself somewhere different each run makes a
    // regression impossible to reproduce.
    expect(selectForEscalation(tied, { maxItems: 1 }).selected).toEqual(['evt_apple']);
    expect(selectForEscalation(tied, { maxItems: 1 }).selected).toEqual(['evt_apple']);
  });

  it('takes everything when nothing constrains it', () => {
    const decision = selectForEscalation(candidates);
    expect(decision.selected).toHaveLength(4);
    expect(decision.limitedBy).toBe('nothing');
  });

  it('handles an empty field', () => {
    expect(selectForEscalation([], { maxItems: 5 }).selected).toEqual([]);
  });
});

describe('CostBudget', () => {
  it('tracks what has been spent', () => {
    const budget = new CostBudget(1);
    budget.spend(0.25, 'a closer look');
    expect(budget.spentUsd).toBeCloseTo(0.25, 6);
    expect(budget.remainingUsd).toBeCloseTo(0.75, 6);
  });

  it('refuses to exceed the limit, and says what would have', () => {
    const budget = new CostBudget(0.1);
    budget.spend(0.09, 'one event');
    expect(() => budget.spend(0.02, 'another event')).toThrow(/cost limit/);
    // Discovering a limit on an invoice is not an acceptable way to learn it.
    expect(budget.spentUsd).toBeCloseTo(0.09, 6);
  });

  it('is unlimited by default', () => {
    const budget = new CostBudget();
    budget.spend(1000, 'a great deal');
    expect(budget.remainingUsd).toBe(Infinity);
    expect(budget.canAfford(1_000_000)).toBe(true);
  });
});
