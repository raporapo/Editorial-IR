import { describe, expect, it } from 'vitest';
import { compileProject } from '@editorial-ir/core';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { HeuristicContextModel, type ContextModel } from '@editorial-ir/perception';
import type { DescribeParams, DescribeResult } from '@editorial-ir/contracts';
import { exampleSuite, makeExampleProject } from './support/project.js';

/**
 * What a second run costs.
 *
 * The expensive stages are understanding and judgement, and both are keyed on
 * what they actually depend on. Editing an annotation or changing the target
 * duration must not re-run a vision-language model over three hundred events —
 * that is the difference between a tool someone uses daily and one they run
 * once.
 */
class CountingContextModel implements ContextModel {
  readonly identity;
  calls = 0;

  constructor(private readonly inner = new HeuristicContextModel()) {
    this.identity = { ...inner.identity, backend: 'counting' };
  }

  async describe(params: DescribeParams): Promise<DescribeResult> {
    this.calls++;
    return this.inner.describe(params);
  }
}

class CountingDecision extends HeuristicDecisionBackend {
  calls = 0;

  override async score(...args: Parameters<HeuristicDecisionBackend['score']>) {
    this.calls++;
    return super.score(...args);
  }
}

async function project() {
  const store = await makeExampleProject();
  const context = new CountingContextModel();
  const decision = new CountingDecision();
  const suite = { ...exampleSuite(), context };
  const compile = () => compileProject({ store, suite, decision });
  return { store, context, decision, compile };
}

describe('running it again', () => {
  it('costs nothing when nothing changed', async () => {
    const { context, decision, compile } = await project();

    await compile();
    const understood = context.calls;
    const judged = decision.calls;
    expect(understood).toBeGreaterThan(50);
    expect(judged).toBeGreaterThan(50);

    await compile();
    // Not one call to either. With a hosted model this is the difference
    // between free and a full pass.
    expect(context.calls).toBe(understood);
    expect(decision.calls).toBe(judged);
  }, 60_000);

  it('costs nothing when only the target duration changed', async () => {
    const { store, context, decision, compile } = await project();
    await compile();
    const before = { understood: context.calls, judged: decision.calls };

    const projectContext = store.readContext();
    store.writeContext({
      ...projectContext,
      editing_goal: { ...projectContext.editing_goal, target_duration_ms: 40_000 },
    });

    await compile();
    // How long the piece should be has nothing to do with what happened in it,
    // or with what any of it is worth.
    expect(context.calls).toBe(before.understood);
    expect(decision.calls).toBe(before.judged);
  }, 60_000);

  it('re-understands everything when the occasion changed, because it should', async () => {
    const { store, context, compile } = await project();
    await compile();
    const before = context.calls;

    const projectContext = store.readContext();
    store.writeContext({
      ...projectContext,
      background: { ...projectContext.background, occasion: '友人との旅行' },
    });

    await compile();
    // The occasion is shown to the model and changes what the events mean, so
    // caching it would be wrong rather than clever.
    expect(context.calls).toBeGreaterThan(before);
  }, 60_000);

  it('re-judges an event whose annotation changed, and no others', async () => {
    const { store, decision, compile } = await project();
    const first = await compile();
    const before = decision.calls;

    const target = first.ir.events[5]!.id;
    store.writeAnnotations([
      {
        id: 'ann_0001',
        type: 'essential',
        target: { kind: 'event', event_id: target },
        priority: 0,
        created_at: '2026-05-17T09:00:00.000Z',
      },
    ]);

    await compile();
    const spent = decision.calls - before;
    // One event's state changed, so one event is re-judged. Ten questions,
    // asked one at a time by the rule-based backend.
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(before / 4);
  }, 60_000);

  it('serves perception from the cache even before anything is persisted', async () => {
    const { store, compile } = await project();
    await compile();
    const hitsAfterFirst = store.cache.hits;

    const second = await compile();
    // Nothing was written to the project between the two runs, so the
    // observation document is reassembled — but every model call behind it is a
    // cache hit, which is where the time and the money are.
    expect(second.report.reusedObservations).toBe(false);
    expect(store.cache.hits).toBeGreaterThan(hitsAfterFirst);
  }, 60_000);

  it('skips reassembly entirely once the observations are stored', async () => {
    const { store, compile } = await project();
    const first = await compile();
    // What `oea analyze` does at the end of a run.
    store.writeObservations(first.observations);

    const second = await compile();
    expect(second.report.reusedObservations).toBe(true);
  }, 60_000);
});
