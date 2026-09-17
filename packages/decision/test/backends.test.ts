import { describe, expect, it, vi } from 'vitest';
import { expectedUnitValue, type EventState } from '@editorial-ir/contracts';
import {
  FallbackDecisionBackend,
  HeuristicDecisionBackend,
  JevBackend,
  LocalSystemOneBackend,
  assessEvent,
  batchSchema,
  buildBatchPrompt,
  maximumEntropyDistribution,
  twoPointDistribution,
  unitToDistribution,
} from '../src/index.js';
import { METRIC_QUESTIONS, NARRATIVE_ROLE_QUESTION, FLAG_QUESTIONS } from '../src/questions.js';

function state(overrides: Partial<EventState> = {}): EventState {
  return {
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
      event_type: 'moment',
      entities: { people: [], places: [], topics: [] },
      affect: {},
    },
    user_context: { tone: [], notes: [], essential: false },
    ...overrides,
  };
}

describe('mean-preserving distributions', () => {
  it('recovers the requested value exactly, at every concentration', () => {
    for (const value of [0, 0.01, 0.25, 0.5, 0.63, 0.99, 1]) {
      for (const concentration of [0, 0.25, 0.5, 0.75, 1]) {
        const probabilities = unitToDistribution(value, 5, concentration);
        expect(expectedUnitValue(probabilities, 5)).toBeCloseTo(value, 3);
        expect(probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
      }
    }
  });

  it('collapses to a spike at the ends of the scale, because nothing else can average there', () => {
    expect(unitToDistribution(0, 5, 0)).toEqual([1, 0, 0, 0, 0]);
    expect(unitToDistribution(1, 5, 0)).toEqual([0, 0, 0, 0, 1]);
  });

  it('is uniform at the centre when nothing beyond the mean is claimed', () => {
    const middle = maximumEntropyDistribution(2, 5);
    for (const p of middle) expect(p).toBeCloseTo(0.2, 3);
  });

  it('puts mass only on the bracketing levels when fully concentrated', () => {
    const two = twoPointDistribution(2.25, 5);
    expect(two[2]).toBeCloseTo(0.75, 6);
    expect(two[3]).toBeCloseTo(0.25, 6);
    expect(two[0]).toBe(0);
  });

  it('survives a steep solution without overflowing to NaN', () => {
    for (const p of maximumEntropyDistribution(0.001, 5)) expect(Number.isFinite(p)).toBe(true);
    for (const p of maximumEntropyDistribution(3.999, 5)) expect(Number.isFinite(p)).toBe(true);
  });

  it('handles a degenerate single-level scale', () => {
    expect(unitToDistribution(0.5, 1)).toEqual([1]);
  });
});

describe('LocalSystemOneBackend', () => {
  function fakeFetch(answer: Record<string, unknown>) {
    return vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(answer) } }],
            usage: { prompt_tokens: 800, completion_tokens: 60 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
  }

  it('asks every question in a single call', async () => {
    const answer: Record<string, unknown> = { rationale: 'clear payoff', narrative_role: 'payoff' };
    for (const key of Object.keys(METRIC_QUESTIONS)) answer[key] = 3;
    for (const key of Object.keys(FLAG_QUESTIONS)) answer[key] = 0.7;

    const fetchImpl = fakeFetch(answer);
    const backend = new LocalSystemOneBackend({
      baseUrl: 'http://localhost:11434/v1',
      model: 'small',
      fetchImpl: fetchImpl,
    });

    const result = await assessEvent(backend, state());
    // Nineteen questions, one round trip.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.metrics.story_importance).toBeCloseTo(0.75, 2);
    expect(result.flags.preserve).toBeCloseTo(0.7, 4);
    expect(result.narrative_role.selected).toBe('payoff');
    expect(result.rationale).toBe('clear payoff');
  });

  it('reports a local endpoint as local, so the privacy report is accurate', () => {
    const local = new LocalSystemOneBackend({ baseUrl: 'http://localhost:11434/v1', model: 'm' });
    const hosted = new LocalSystemOneBackend({ baseUrl: 'https://api.example.com/v1', model: 'm' });
    expect(local.identity.locality).toBe('local');
    expect(hosted.identity.locality).toBe('remote_api');
    // Neither sends frames or audio: only the structured event state goes out.
    expect(hosted.identity.mediaLeavesDevice).toBe(false);
  });

  it('rejects a reply that is not JSON rather than guessing', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'sure, here you go!' } }] }),
          {
            status: 200,
          },
        ),
    );
    const backend = new LocalSystemOneBackend({
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
      fetchImpl: fetchImpl,
    });
    await expect(backend.score(state(), METRIC_QUESTIONS.story_importance)).rejects.toThrow(
      /did not return JSON/,
    );
  });

  it('leaves a skipped question at its neutral value instead of inventing one', async () => {
    const fetchImpl = fakeFetch({ story_importance: 4, rationale: 'partial' });
    const backend = new LocalSystemOneBackend({
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
      fetchImpl: fetchImpl,
    });
    const result = await assessEvent(backend, state());
    expect(result.metrics.story_importance).toBe(1);
    expect(result.metrics.visual_quality).toBe(0.5);
  });

  it('estimates cost only when pricing is configured', () => {
    const free = new LocalSystemOneBackend({ baseUrl: 'http://localhost:1/v1', model: 'm' });
    expect(free.estimateCost(1_000_000, 1_000_000)).toBe(0);
    const priced = new LocalSystemOneBackend({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2 },
    });
    expect(priced.estimateCost(1_000_000, 1_000_000)).toBeCloseTo(1.5, 6);
  });
});

describe('the batch prompt and schema', () => {
  const request = {
    scores: [METRIC_QUESTIONS.story_importance],
    booleans: [FLAG_QUESTIONS.preserve],
    choice: NARRATIVE_ROLE_QUESTION,
  };

  it('spells out every level, rather than asking for a number', () => {
    const prompt = buildBatchPrompt(state(), request);
    for (const level of METRIC_QUESTIONS.story_importance.levels) {
      expect(prompt).toContain(level.description);
    }
  });

  it('passes user background through and marks it as the user speaking', () => {
    const prompt = buildBatchPrompt(
      state({ user_context: { tone: [], notes: [], essential: true, occasion: '交際1周年旅行' } }),
      request,
    );
    expect(prompt).toContain('交際1周年旅行');
    expect(prompt).toContain('the_user_marked_this_essential');
  });

  it('leaves out fields that are empty, so a small model is not reading blanks', () => {
    const prompt = buildBatchPrompt(state(), request);
    expect(prompt).not.toContain('"speech"');
    expect(prompt).not.toContain('"places"');
  });

  it('constrains the answer to the levels and options that were offered', () => {
    const schema = batchSchema(request) as {
      properties: Record<string, { maximum?: number; enum?: string[] }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.properties.story_importance?.maximum).toBe(4);
    expect(schema.properties.narrative_role?.enum).toEqual(
      NARRATIVE_ROLE_QUESTION.options.map((o) => o.value),
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('preserve');
  });
});

describe('FallbackDecisionBackend', () => {
  const failing = {
    identity: {
      backend: 'failing',
      locality: 'remote_api' as const,
      mediaLeavesDevice: false,
      baseConfidence: 0.9,
    },
    choice: async () => {
      throw new Error('connection reset');
    },
    score: async () => {
      throw new Error('connection reset');
    },
    booleanProbability: async () => {
      throw new Error('connection reset');
    },
  };

  it('degrades instead of losing an hour of work to one restart', async () => {
    const seen: string[] = [];
    const backend = new FallbackDecisionBackend(failing, new HeuristicDecisionBackend(), {
      onFallback: (_error, questionId) => void seen.push(questionId),
    });
    const result = await assessEvent(backend, state());
    expect(result.metrics.story_importance).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('offers a batch path only when the backend it wraps has one', () => {
    // Callers check for the method to decide how to ask, so a wrapper that
    // always had it would route every backend down a path half of them cannot
    // serve.
    const withoutBatch = new FallbackDecisionBackend(failing, new HeuristicDecisionBackend());
    expect(withoutBatch.assessAll).toBeUndefined();

    const batching = {
      ...failing,
      assessAll: async () => {
        throw new Error('connection reset');
      },
    };
    expect(
      new FallbackDecisionBackend(batching, new HeuristicDecisionBackend()).assessAll,
    ).toBeTypeOf('function');
  });

  it('answers a whole batch from the fallback when the batch call fails', async () => {
    // Nineteen questions in one call is how a hosted backend is affordable. When
    // that call fails the run must still produce answers for all nineteen, not
    // lose the event.
    const batching = {
      ...failing,
      assessAll: async () => {
        throw new Error('connection reset');
      },
    };
    const backend = new FallbackDecisionBackend(batching, new HeuristicDecisionBackend());

    const answers = await backend.assessAll!(state(), {
      scores: Object.values(METRIC_QUESTIONS).slice(0, 3),
      booleans: Object.values(FLAG_QUESTIONS).slice(0, 2),
      choice: NARRATIVE_ROLE_QUESTION,
    });

    expect(Object.keys(answers.scores)).toHaveLength(3);
    expect(Object.keys(answers.booleans)).toHaveLength(2);
    expect(answers.choice).toBeDefined();
    // The fallback's own confidence, so the IR does not claim the good model
    // answered.
    expect(answers.confidence).toBe(new HeuristicDecisionBackend().identity.baseConfidence);
  });

  it('prefers the fallback’s own batch path to asking it one at a time', async () => {
    let batched = 0;
    const cheap = new HeuristicDecisionBackend();
    const fallback = {
      ...cheap,
      identity: cheap.identity,
      assessAll: async () => {
        batched++;
        return { scores: {}, booleans: {}, confidence: 0.4 };
      },
    } as unknown as HeuristicDecisionBackend;

    const backend = new FallbackDecisionBackend(
      {
        ...failing,
        assessAll: async () => {
          throw new Error('down');
        },
      },
      fallback,
    );
    await backend.assessAll!(state(), { scores: [], booleans: [] });
    expect(batched).toBe(1);
  });

  it('stops retrying a backend that is plainly down', async () => {
    let attempts = 0;
    const counting = {
      ...failing,
      score: async () => {
        attempts++;
        throw new Error('down');
      },
    };
    const backend = new FallbackDecisionBackend(counting, new HeuristicDecisionBackend(), {
      giveUpAfter: 3,
    });
    // Serially, so the count is exactly the give-up threshold rather than the
    // threshold plus however many questions were already in flight.
    await assessEvent(backend, state(), { concurrency: 1 });
    expect(attempts).toBe(3);
    expect(backend.degraded).toBe(true);
  });
});

describe('JevBackend', () => {
  it('is never required, and reports itself as an optional remote backend', () => {
    const backend = new JevBackend({ baseUrl: 'https://decisions.example.com' });
    expect(backend.identity.backend).toBe('jev');
    expect(backend.identity.locality).toBe('remote_api');
    expect(backend.identity.mediaLeavesDevice).toBe(false);
  });

  it('recomputes the score from the distribution it was given', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ probabilities: [0, 0, 0, 1, 0] }), { status: 200 }),
    );
    const backend = new JevBackend({
      baseUrl: 'https://decisions.example.com',
      fetchImpl: fetchImpl,
    });
    const result = await backend.score(state(), METRIC_QUESTIONS.story_importance);
    expect(result.level).toBe(3);
    expect(result.value).toBeCloseTo(0.75, 4);
  });

  it('refuses an option that was never offered', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ selected: 'montage' }), { status: 200 }),
    );
    const backend = new JevBackend({
      baseUrl: 'https://decisions.example.com',
      fetchImpl: fetchImpl,
    });
    await expect(backend.choice(state(), NARRATIVE_ROLE_QUESTION)).rejects.toThrow(/not offered/);
  });
});
