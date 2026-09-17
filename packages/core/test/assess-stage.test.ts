import { describe, expect, it } from 'vitest';
import type { EditorialDecisionModel } from '@editorial-ir/decision';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { ProjectContext } from '@editorial-ir/contracts';
import { MemoryCache, ModelRunRecorder, assessEvents } from '../src/index.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * Running the decision layer, and saying honestly who answered.
 *
 * Two things here cost real money and real trust: an answer the expensive model
 * gave must be attributed to it, and it must not be bought twice.
 */
const ir = makeIR({
  events: Array.from({ length: 6 }, (_, i) => ({
    description: `出来事 ${i}`,
    speech: [`セリフ${i}`],
  })),
});

const context = ProjectContext.parse({
  project_id: ir.project.id,
  updated_at: '2026-05-17T09:00:00.000Z',
});

/** A second opinion that counts how often it is actually asked. */
function countingBackend(): EditorialDecisionModel & { calls: number } {
  const inner = new HeuristicDecisionBackend();
  const backend: EditorialDecisionModel & { calls: number } = {
    calls: 0,
    identity: { ...inner.identity, backend: 'expensive', baseConfidence: 0.9 },
    choice: (state, request) => {
      backend.calls++;
      return inner.choice(state, request);
    },
    score: (state, request) => {
      backend.calls++;
      return inner.score(state, request);
    },
    booleanProbability: (state, request) => {
      backend.calls++;
      return inner.booleanProbability(state, request);
    },
  };
  return backend;
}

async function assess(cache: MemoryCache, escalationModel: EditorialDecisionModel) {
  const runs = new ModelRunRecorder();
  const result = await assessEvents(ir.events, {
    context,
    runs,
    baseModel: new HeuristicDecisionBackend(),
    escalationModel,
    escalation: { maxItems: 2, minValue: 0 },
    cache,
  });
  return { ...result, runs: runs.all() };
}

describe('who answered', () => {
  it('attributes an escalated judgement to the model that made it', async () => {
    // It recorded the base model's run id for every event, so the IR told a
    // reader — and the next run's escalation policy — that a rule-based judge at
    // confidence 0.4 had said what a hosted model said.
    const { editorial, escalated, runs } = await assess(new MemoryCache(), countingBackend());
    expect(escalated.length).toBeGreaterThan(0);

    const expensive = runs.find((run) => run.backend === 'expensive')!;
    const cheap = runs.find((run) => run.backend !== 'expensive')!;
    expect(expensive.id).not.toBe(cheap.id);

    for (const entry of editorial) {
      const expected = escalated.includes(entry.event_id) ? expensive.id : cheap.id;
      expect(entry.current.model_run_id).toBe(expected);
    }
  });
});

describe('what it costs the second time', () => {
  it('does not buy the same second opinion twice', async () => {
    // The escalation loop called the model directly rather than through the
    // cache, so every re-analysis asked the hosted backend the same nineteen
    // questions about the same unchanged events, and was charged again.
    const cache = new MemoryCache();

    const first = countingBackend();
    await assess(cache, first);
    expect(first.calls).toBeGreaterThan(0);

    const second = countingBackend();
    const { escalated } = await assess(cache, second);
    expect(escalated.length).toBeGreaterThan(0);
    expect(second.calls).toBe(0);
  });

  it('still attributes a cached answer to the model that originally gave it', async () => {
    const cache = new MemoryCache();
    await assess(cache, countingBackend());

    const { editorial, escalated, runs } = await assess(cache, countingBackend());
    const expensive = runs.find((run) => run.backend === 'expensive')!;
    for (const eventId of escalated) {
      const entry = editorial.find((e) => e.event_id === eventId)!;
      expect(entry.current.model_run_id).toBe(expensive.id);
    }
  });
});
