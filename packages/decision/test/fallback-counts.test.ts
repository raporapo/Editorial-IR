import { describe, expect, it } from 'vitest';
import type { EventState } from '@editorial-ir/contracts';
import { FallbackDecisionBackend, HeuristicDecisionBackend } from '../src/index.js';
import type { EditorialDecisionModel } from '../src/types.js';

/**
 * Counting which side answered, which is what decides the analysis tier.
 *
 * The `degraded` flag was not enough and a real run proved it: a server that
 * rejected every request answered entirely from the rules while `degraded` was
 * still false, because the give-up counter had not been reached. The IR was
 * stamped as a full-strength analysis on the strength of a model that never
 * answered once.
 */
const state: EventState = {
  event_id: 'evt_0001',
  duration_ms: 8000,
  relative_position: 0.5,
  observed: {
    speech: [],
    visual_labels: [],
    ocr: [],
    audio: [],
    shot_count: 1,
    speech_ratio: 0,
    silence_ratio: 0,
  },
  semantic: {
    description: 'a moment',
    event_type: 'arrival',
    entities: { people: [], places: [], topics: [] },
    affect: {},
  },
  user_context: { tone: [], notes: [], essential: false },
};

const question = { question_id: 'preserve', statement: 'worth keeping?' };

class AlwaysFails implements EditorialDecisionModel {
  readonly identity = {
    backend: 'openai-compatible',
    model: 'a-server-that-says-no',
    locality: 'local' as const,
    mediaLeavesDevice: false,
    baseConfidence: 0.8,
    costPerEventUsd: 0,
  };
  async choice(): Promise<never> {
    throw new Error('400 unsupported');
  }
  async score(): Promise<never> {
    throw new Error('400 unsupported');
  }
  async booleanProbability(): Promise<never> {
    throw new Error('400 unsupported');
  }
}

describe('who actually answered', () => {
  it('starts with nothing counted', () => {
    const backend = new FallbackDecisionBackend(new AlwaysFails(), new HeuristicDecisionBackend());
    expect(backend.answers).toEqual({ primary: 0, fallback: 0 });
  });

  it('counts an answer that came from the rules', async () => {
    const backend = new FallbackDecisionBackend(new AlwaysFails(), new HeuristicDecisionBackend());
    await backend.booleanProbability(state, question);
    expect(backend.answers).toEqual({ primary: 0, fallback: 1 });
  });

  it('counts the fallbacks that happen after it has given up, too', async () => {
    // The give-up path returns early, and returning early without counting is
    // how a fully-degraded run looked like a partly-degraded one.
    const backend = new FallbackDecisionBackend(new AlwaysFails(), new HeuristicDecisionBackend(), {
      giveUpAfter: 2,
    });
    for (let i = 0; i < 6; i++) await backend.booleanProbability(state, question);
    expect(backend.degraded).toBe(true);
    expect(backend.answers.fallback).toBe(6);
    expect(backend.answers.primary).toBe(0);
  });

  it('counts a working primary as the primary', async () => {
    const backend = new FallbackDecisionBackend(
      new HeuristicDecisionBackend(),
      new HeuristicDecisionBackend(),
    );
    await backend.booleanProbability(state, question);
    expect(backend.answers).toEqual({ primary: 1, fallback: 0 });
  });

  it('is not degraded before the limit, which is why the count is needed', async () => {
    // The exact shape of the bug: every answer came from the rules, and the
    // flag the compiler used to read still said everything was fine.
    const backend = new FallbackDecisionBackend(new AlwaysFails(), new HeuristicDecisionBackend(), {
      giveUpAfter: 0,
    });
    for (let i = 0; i < 4; i++) await backend.booleanProbability(state, question);
    expect(backend.degraded).toBe(false);
    expect(backend.answers).toEqual({ primary: 0, fallback: 4 });
  });
});
