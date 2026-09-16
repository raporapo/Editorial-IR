import { describe, expect, it } from 'vitest';
import type { SemanticEvent } from '@editorial-ir/contracts';
import {
  buildEventGraph,
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
