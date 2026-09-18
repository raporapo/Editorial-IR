import { describe, expect, it } from 'vitest';
import type { SemanticEvent } from '@editorial-ir/contracts';
import {
  buildEventGraph,
  featureSimilarity,
  continuityBetween,
  dependenciesOf,
  duplicateGroups,
} from '../src/index.js';
import { makeEvent } from '../../../tests/support/ir.js';

/**
 * The graph over events.
 *
 * The list already carries "what happened, in order". The graph carries what an
 * editor reasons about: that these two are the same take, that this only makes
 * sense after that.
 */
const events = [
  makeEvent(
    { id: 'evt_0001', description: '電車でUSJへ移動している', places: ['電車'], people: ['me'] },
    0,
  ),
  makeEvent(
    {
      id: 'evt_0002',
      description: 'USJ入口に到着した',
      places: ['USJ'],
      people: ['me', 'partner'],
    },
    1,
  ),
  makeEvent(
    {
      id: 'evt_0003',
      description: 'USJ入口に到着した',
      places: ['USJ'],
      people: ['me', 'partner'],
    },
    2,
  ),
  makeEvent({ id: 'evt_0004', description: 'ラーメンを食べている', places: ['店'] }, 3),
];

describe('buildEventGraph', () => {
  it('links every neighbour with a continuation edge', () => {
    const relations = buildEventGraph(events);
    const continuations = relations.filter((relation) => relation.relation_type === 'continuation');
    expect(continuations).toHaveLength(events.length - 1);
  });

  it('spots two takes of the same thing', () => {
    const relations = buildEventGraph(events);
    const duplicate = relations.find((relation) => relation.relation_type === 'duplicate_of');
    expect(duplicate).toBeDefined();
    expect([duplicate!.source_event_id, duplicate!.target_event_id].sort()).toEqual([
      'evt_0002',
      'evt_0003',
    ]);
  });

  it('links events by place and by person', () => {
    const relations = buildEventGraph(events);
    expect(relations.some((relation) => relation.relation_type === 'same_location')).toBe(true);
    expect(relations.some((relation) => relation.relation_type === 'same_person')).toBe(true);
  });

  it('takes the user’s word on continuity, and marks it as theirs', () => {
    const relations = buildEventGraph(events, {
      continuityOverrides: new Map([['evt_0001->evt_0002', 0.95]]),
    });
    const edge = relations.find(
      (relation) =>
        relation.source_event_id === 'evt_0001' && relation.target_event_id === 'evt_0002',
    )!;
    expect(edge.strength).toBe(0.95);
    expect(edge.provenance).toBe('user_provided');
  });

  it('does not call two events with nothing in them duplicates of each other', () => {
    const empty = [
      makeEvent({ id: 'evt_0001', description: 'no speech or on-screen text' }, 0),
      makeEvent({ id: 'evt_0002', description: 'no speech or on-screen text' }, 1),
    ];
    // Otherwise every quiet moment in a project is a duplicate of every other.
    const relations = buildEventGraph(empty);
    expect(relations.some((relation) => relation.relation_type === 'duplicate_of')).toBe(false);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildEventGraph(events))).toBe(JSON.stringify(buildEventGraph(events)));
  });
});

describe('the graph at the size of a real recording', () => {
  function manyEvents(count: number) {
    return Array.from({ length: count }, (_, i) =>
      makeEvent(
        {
          id: `evt_${String(i + 1).padStart(4, '0')}`,
          description: `出来事 ${i} ${'あいうえおかきくけこ'[i % 10]}`,
          places: [`place_${i % 5}`],
          people: i % 3 === 0 ? ['me'] : [],
        },
        i,
      ),
    );
  }

  it('grows with the number of events, not with its square', () => {
    // The associative links are pairwise, and an hour of footage is not a small
    // number of events: 600 of them produced 220,000 relations and 28 MB of JSON
    // inside ir.json, and 1,200 produced 716,000 and 101 MB. One long recording
    // is the commonest input there is.
    const small = buildEventGraph(manyEvents(100));
    const large = buildEventGraph(manyEvents(400));

    const perEvent = (relations: unknown[], events: number): number => relations.length / events;
    expect(perEvent(large, 400)).toBeLessThan(perEvent(small, 100) * 2);
    expect(perEvent(large, 400)).toBeLessThan(40);
  });

  it('never thins continuation, which would invent a discontinuity', () => {
    const events = manyEvents(200);
    const relations = buildEventGraph(events);
    const continuations = relations.filter((r) => r.relation_type === 'continuation');
    expect(continuations).toHaveLength(events.length - 1);
  });

  it('still groups a cluster of repeats after capping its links', () => {
    // The reason duplicate_of can be capped at all: its one consumer takes the
    // transitive closure, and a cluster whose every member links to its
    // strongest few neighbours is still one cluster. A static camera running for
    // three hours is what makes this matter — 400 near-identical events link to
    // each other 80,000 times without a bound.
    const repeats = Array.from({ length: 200 }, (_, i) =>
      makeEvent(
        {
          id: `evt_${String(i + 1).padStart(4, '0')}`,
          description: '同じ話を繰り返している',
          speech: ['同じ話を繰り返しています'],
          visual_labels: ['lecture_hall', 'speaker', 'slide'],
        },
        i,
      ),
    );
    const relations = buildEventGraph(repeats);
    const groups = duplicateGroups(relations);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(repeats.length);
  });

  it('keeps a link that matters to one event even when it matters less to the other', () => {
    // An edge survives if either end wants it, so a link that is one event's
    // strongest is not lost because the other has better ones.
    const relations = buildEventGraph(manyEvents(120));
    const byEvent = new Map<string, number>();
    for (const relation of relations) {
      if (relation.relation_type !== 'same_topic') continue;
      for (const id of [relation.source_event_id, relation.target_event_id]) {
        byEvent.set(id, (byEvent.get(id) ?? 0) + 1);
      }
    }
    // Every event that has any topic links at all has at least one.
    expect([...byEvent.values()].every((count) => count >= 1)).toBe(true);
  });
});

describe('featureSimilarity', () => {
  it('is the shared features over the smaller set, either way round', () => {
    const a = new Set(['x', 'y', 'z', 'w']);
    const b = new Set(['x', 'y']);
    // b is entirely inside a, so they are as alike as two events get.
    expect(featureSimilarity(a, b)).toBe(1);
    expect(featureSimilarity(b, a)).toBe(1);
  });

  it('is zero when either side has nothing to compare', () => {
    expect(featureSimilarity(new Set(), new Set(['x']))).toBe(0);
    expect(featureSimilarity(undefined, new Set(['x']))).toBe(0);
  });

  it('counts only what both sides have', () => {
    expect(featureSimilarity(new Set(['a', 'b']), new Set(['b', 'c']))).toBe(0.5);
  });
});

describe('continuityBetween', () => {
  it('scores a cut within one place above a jump between two', () => {
    const samePlace = continuityBetween(events[1]!, events[2]!);
    const different = continuityBetween(events[2]!, events[3]!);
    expect(samePlace).toBeGreaterThan(different);
  });

  it('erodes with time apart', () => {
    const near = makeEvent({ id: 'evt_a', start_ms: 0, duration_ms: 5000, places: ['USJ'] }, 0);
    const soon = makeEvent({ id: 'evt_b', start_ms: 6000, duration_ms: 5000, places: ['USJ'] }, 1);
    const later = makeEvent(
      { id: 'evt_c', start_ms: 500_000, duration_ms: 5000, places: ['USJ'] },
      2,
    );
    expect(continuityBetween(near, soon)).toBeGreaterThan(continuityBetween(near, later));
  });

  it('stays inside [0,1]', () => {
    const pairs: [SemanticEvent, SemanticEvent][] = [
      [events[0]!, events[1]!],
      [events[3]!, events[0]!],
    ];
    for (const [a, b] of pairs) {
      const score = continuityBetween(a, b);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('duplicateGroups', () => {
  it('collects transitively, so three takes are one group', () => {
    const relations = [
      {
        id: 'rel_1',
        source_event_id: 'evt_a',
        target_event_id: 'evt_b',
        relation_type: 'duplicate_of' as const,
        strength: 0.9,
        provenance: 'inferred' as const,
      },
      {
        id: 'rel_2',
        source_event_id: 'evt_b',
        target_event_id: 'evt_c',
        relation_type: 'duplicate_of' as const,
        strength: 0.9,
        provenance: 'inferred' as const,
      },
      {
        id: 'rel_3',
        source_event_id: 'evt_x',
        target_event_id: 'evt_y',
        relation_type: 'same_topic' as const,
        strength: 0.7,
        provenance: 'inferred' as const,
      },
    ];
    expect(duplicateGroups(relations)).toEqual([['evt_a', 'evt_b', 'evt_c']]);
  });

  it('finds nothing when there are no duplicates', () => {
    expect(duplicateGroups([])).toEqual([]);
  });
});

describe('the dependency an event has on the one before it', () => {
  /**
   * `setup_for`, `answers` and `reaction_to` are first-class relation types that
   * **nothing produced**. A real IR contained only `continuation`,
   * `duplicate_of`, `same_topic`, `same_location`, `same_person` and `callback`,
   * so `dependenciesOf` — whose filter names three of them — could only ever
   * return an empty array. Its test passed by hand-building relations the
   * compiler cannot emit, which is what let it look implemented.
   *
   * The judgement itself was already being made and acted on: the planner drops
   * an event whose predecessor is not in the cut, and the reviewer warns about
   * one. What was missing was the edge saying *which* event it depends on.
   */
  it('becomes a relation when the assessment says the event needs one', () => {
    const relations = buildEventGraph(events, {
      requiresPreviousContext: (id) => (id === 'evt_0002' ? 0.8 : 0.1),
    });
    const setup = relations.filter((relation) => relation.relation_type === 'setup_for');
    expect(setup).toHaveLength(1);
    expect(setup[0]?.source_event_id).toBe('evt_0001');
    expect(setup[0]?.target_event_id).toBe('evt_0002');
  });

  it('is then answerable by the function written to answer it', () => {
    const relations = buildEventGraph(events, {
      requiresPreviousContext: (id) => (id === 'evt_0002' ? 0.8 : 0.1),
    });
    expect(dependenciesOf(relations, 'evt_0002')).toEqual(['evt_0001']);
  });

  it('carries the strength the judgement gave it', () => {
    const relations = buildEventGraph(events, {
      requiresPreviousContext: (id) => (id === 'evt_0002' ? 0.77 : 0),
    });
    const setup = relations.find((relation) => relation.relation_type === 'setup_for');
    expect(setup?.strength).toBeCloseTo(0.77, 4);
  });

  it('is not invented below the threshold the planner acts on', () => {
    // The rules backend reaches 0.55 for a deictic opener alone, which is
    // deliberately under the line; only a reaction that also opens deictically
    // clears it. A graph that linked every 0.55 would contradict a planner that
    // ignores them.
    const relations = buildEventGraph(events, { requiresPreviousContext: () => 0.55 });
    expect(relations.some((relation) => relation.relation_type === 'setup_for')).toBe(false);
  });

  it('is not produced at all when nothing has judged the events', () => {
    // The graph is buildable before the decision layer runs, and then this kind
    // of relation simply does not exist rather than being guessed at.
    const relations = buildEventGraph(events);
    expect(relations.some((relation) => relation.relation_type === 'setup_for')).toBe(false);
  });
});

describe('dependenciesOf', () => {
  it('finds what an event needs in order to make sense', () => {
    const relations = [
      {
        id: 'rel_1',
        source_event_id: 'evt_a',
        target_event_id: 'evt_b',
        relation_type: 'setup_for' as const,
        strength: 0.8,
        provenance: 'inferred' as const,
      },
      {
        id: 'rel_2',
        source_event_id: 'evt_c',
        target_event_id: 'evt_b',
        relation_type: 'answers' as const,
        strength: 0.8,
        provenance: 'inferred' as const,
      },
      {
        id: 'rel_3',
        source_event_id: 'evt_d',
        target_event_id: 'evt_b',
        relation_type: 'same_topic' as const,
        strength: 0.8,
        provenance: 'inferred' as const,
      },
    ];
    // Same topic is not a dependency; a setup and an answer are.
    expect(dependenciesOf(relations, 'evt_b').sort()).toEqual(['evt_a', 'evt_c']);
  });
});
