import { describe, expect, it } from 'vitest';
import {
  EDITORIAL_FLAGS,
  EDITORIAL_METRICS,
  NARRATIVE_ROLES,
  expectedUnitValue,
  type EventState,
} from '@editorial-ir/contracts';
import {
  FLAG_QUESTIONS,
  HeuristicDecisionBackend,
  METRIC_QUESTIONS,
  NARRATIVE_ROLE_QUESTION,
  argmax,
  assessEvent,
  normalise,
  prune,
  scoreFromUnit,
  unitToDistribution,
  unitToLevel,
} from '../src/index.js';

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
      description: '',
      event_type: 'moment',
      entities: { people: [], places: [], topics: [] },
      affect: {},
    },
    user_context: { tone: [], notes: [], essential: false },
    ...overrides,
  } as EventState;
}

describe('the question registry', () => {
  it('covers every metric, flag and role in the contract', () => {
    for (const metric of EDITORIAL_METRICS) {
      expect(METRIC_QUESTIONS[metric]?.question_id).toBe(metric);
      expect(METRIC_QUESTIONS[metric]!.levels.length).toBeGreaterThanOrEqual(2);
    }
    for (const flag of EDITORIAL_FLAGS) {
      expect(FLAG_QUESTIONS[flag]?.question_id).toBe(flag);
    }
    expect(NARRATIVE_ROLE_QUESTION.options.map((o) => o.value).sort()).toEqual([...NARRATIVE_ROLES].sort());
  });

  it('writes a description for every level, which is the whole point', () => {
    for (const question of Object.values(METRIC_QUESTIONS)) {
      for (const level of question.levels) {
        expect(level.description.length).toBeGreaterThan(10);
        expect(level.label.length).toBeGreaterThan(0);
      }
      // Levels must be a clean ascending run, or the expectation is meaningless.
      expect(question.levels.map((l) => l.level)).toEqual(question.levels.map((_, i) => i));
    }
  });
});

describe('distributions', () => {
  it('round-trips a unit value through a distribution', () => {
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      const result = scoreFromUnit(value, 5);
      expect(result.value).toBeCloseTo(value, 1);
      expect(result.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    }
  });

  it('keeps the stored value and the stored distribution consistent', () => {
    const result = scoreFromUnit(0.63, 5);
    expect(result.value).toBeCloseTo(expectedUnitValue(result.probabilities, 5), 4);
  });

  it('spreads mass when unsure and concentrates it when sure', () => {
    const vague = unitToDistribution(0.5, 5, 0);
    const sharp = unitToDistribution(0.5, 5, 0.95);
    expect(Math.max(...sharp)).toBeGreaterThan(Math.max(...vague));
  });

  it('maps a value to its nearest level', () => {
    expect(unitToLevel(0, 5)).toBe(0);
    expect(unitToLevel(1, 5)).toBe(4);
    expect(unitToLevel(0.5, 5)).toBe(2);
  });

  it('normalises and prunes without losing total mass', () => {
    const normalised = normalise({ a: 2, b: 2 });
    expect(normalised.a).toBeCloseTo(0.5, 4);
    const pruned = prune({ a: 0.97, b: 0.02, c: 0.01 }, 0.05);
    expect(Object.keys(pruned)).toEqual(['a']);
    expect(pruned.a).toBeCloseTo(1, 4);
  });

  it('breaks argmax ties by name so runs are reproducible', () => {
    expect(argmax({ zebra: 0.5, apple: 0.5 })).toBe('apple');
  });

  it('survives a distribution with no mass at all', () => {
    expect(normalise({ a: 0, b: 0 }).a).toBeCloseTo(0.5, 4);
  });
});

describe('HeuristicDecisionBackend', () => {
  const backend = new HeuristicDecisionBackend();

  it('declares itself a weak backend, which is what drives escalation', () => {
    expect(backend.identity.baseConfidence).toBeLessThan(0.6);
    expect(backend.identity.costPerEventUsd).toBe(0);
    expect(backend.identity.locality).toBe('local');
  });

  it('is deterministic', async () => {
    const s = state({ observed: { ...state().observed, speech: ['やっと着いた'] } });
    const a = await assessEvent(backend, s);
    const b = await assessEvent(backend, s);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never contradicts a user who said an event is essential', async () => {
    const essential = state({ user_context: { tone: [], notes: [], essential: true } });
    const result = await assessEvent(backend, essential);
    expect(result.metrics.story_importance).toBeGreaterThan(0.9);
    expect(result.flags.preserve).toBe(1);
  });

  it('ranks a moment with speech and feeling above an empty one', async () => {
    const lively = await assessEvent(
      backend,
      state({
        observed: { ...state().observed, speech: ['やっと着いたね、ここまで長かった'], audio: ['laughter'], speech_ratio: 0.8 },
        semantic: { ...state().semantic, affect: { happiness: 0.8 }, description: '二人が到着して喜んでいる' },
      }),
    );
    const empty = await assessEvent(backend, state());
    expect(lively.metrics.story_importance).toBeGreaterThan(empty.metrics.story_importance);
    expect(lively.metrics.emotional_intensity).toBeGreaterThan(empty.metrics.emotional_intensity);
  });

  it('treats similarity as redundancy only once it is high', async () => {
    const somewhat = await assessEvent(backend, state({ max_similarity_to_others: 0.6 }));
    const very = await assessEvent(backend, state({ max_similarity_to_others: 0.95 }));
    expect(somewhat.metrics.redundancy).toBeLessThan(0.2);
    expect(very.metrics.redundancy).toBeGreaterThan(0.7);
    // Uniqueness is the complement, and must stay consistent with it.
    expect(very.metrics.uniqueness).toBeCloseTo(1 - very.metrics.redundancy, 1);
  });

  it('scores relevance against what the user actually said the piece is for', async () => {
    const context = { tone: [], notes: [], essential: false, occasion: '交際1周年旅行', goal: '夜景で感動的に終わる' };
    const onPoint = await assessEvent(
      backend,
      state({
        user_context: context,
        semantic: { ...state().semantic, description: '夜景を見ている二人', entities: { people: [], places: ['夜景'], topics: [] } },
      }),
    );
    const offPoint = await assessEvent(
      backend,
      state({ user_context: context, semantic: { ...state().semantic, description: '駐車場で車を探している' } }),
    );
    expect(onPoint.metrics.context_relevance).toBeGreaterThan(offPoint.metrics.context_relevance);
  });

  it('stays neutral on relevance when the user said nothing', async () => {
    const result = await assessEvent(backend, state());
    expect(result.metrics.context_relevance).toBeCloseTo(0.5, 1);
  });

  it('calls a silent, flat, textless moment filler', async () => {
    const result = await assessEvent(backend, state({ semantic: { ...state().semantic, event_type: 'b_roll' } }));
    expect(result.narrative_role.probabilities.filler ?? 0).toBeGreaterThan(0);
  });

  it('reads a farewell near the end as an ending', async () => {
    const result = await assessEvent(
      backend,
      state({ relative_position: 0.95, semantic: { ...state().semantic, event_type: 'farewell' } }),
    );
    expect(result.narrative_role.selected).toBe('ending');
    expect(result.flags.ending_candidate).toBeGreaterThan(0.5);
  });

  it('notices a sentence that cannot stand on its own', async () => {
    const dependent = await assessEvent(
      backend,
      state({ observed: { ...state().observed, speech: ['それで、こうなったわけ'] } }),
    );
    const standalone = await assessEvent(
      backend,
      state({ observed: { ...state().observed, speech: ['大阪に着きました'] } }),
    );
    expect(dependent.flags.requires_previous_context).toBeGreaterThan(
      standalone.flags.requires_previous_context,
    );
  });

  it('answers every metric and every flag', async () => {
    const result = await assessEvent(backend, state());
    for (const metric of EDITORIAL_METRICS) {
      expect(result.metrics[metric]).toBeGreaterThanOrEqual(0);
      expect(result.metrics[metric]).toBeLessThanOrEqual(1);
    }
    for (const flag of EDITORIAL_FLAGS) {
      expect(result.flags[flag]).toBeGreaterThanOrEqual(0);
      expect(result.flags[flag]).toBeLessThanOrEqual(1);
    }
    expect(NARRATIVE_ROLES).toContain(result.narrative_role.selected);
  });
});
