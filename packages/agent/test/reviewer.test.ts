import { describe, expect, it } from 'vitest';
import type { EditPlan, EditorialIR } from '@editorial-ir/contracts';
import { SkillRegistry } from '@editorial-ir/skills';
import { buildEventGraph } from '@editorial-ir/core';
import { planEdit, recordRevision, reviewPlan, suggestRevisions } from '../src/index.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * Reading a cut back and saying what is wrong with it.
 *
 * Every failure it looks for is recognisable — a jump between two places with
 * nothing in between, a reply to a question the viewer never heard, the same
 * thing twice, a clip too short to register — and none of them happen on good
 * material, which is why they need constructing. A reviewer whose detections are
 * never exercised is a reviewer that reports "nothing jumped out" forever.
 */
const ir = makeIR({
  events: [
    {
      id: 'evt_0001',
      description: 'ホテルで準備している',
      places: ['ホテル'],
      speech: ['そろそろ行こう'],
      start_ms: 0,
      duration_ms: 20_000,
    },
    {
      id: 'evt_0002',
      description: '電車に乗っている',
      places: ['電車'],
      start_ms: 20_000,
      duration_ms: 20_000,
    },
    {
      id: 'evt_0003',
      description: '公園に着いた',
      places: ['公園'],
      speech: ['着いたね'],
      start_ms: 40_000,
      duration_ms: 20_000,
    },
    {
      id: 'evt_0004',
      description: '公園に着いた',
      places: ['公園'],
      speech: ['着いたね'],
      start_ms: 60_000,
      duration_ms: 20_000,
    },
  ],
});

const withRelations: EditorialIR = { ...ir, relations: buildEventGraph(ir.events) };

const skill = SkillRegistry.withBuiltIns().resolve('travel-vlog');

/**
 * A real plan, cut down to the events a case needs.
 *
 * Built by the planner rather than by hand: a hand-written operation is missing
 * fields nobody remembers (the first draft of this file left out `speed`, so
 * every duration came out NaN and no length check could fire), and a reviewer
 * tested against an artefact the planner would never produce is testing nothing.
 */
function planOf(eventIds: string[], durationMs?: number): EditPlan {
  // Exactly these events, in order, produced by the planner rather than by hand.
  // A hand-written operation is missing fields nobody remembers — the first
  // draft of this file left out `speed`, so every duration came out NaN and no
  // length check could fire — and a reviewer tested against an artefact the
  // planner would never produce is testing nothing.
  const full = planEdit({
    ir: withRelations,
    skill,
    targetDurationMs: 60_000,
    overrides: {
      require: eventIds,
      drop: withRelations.events.map((event) => event.id).filter((id) => !eventIds.includes(id)),
    },
  });

  let at = 0;
  const video = full.tracks.video.map((operation, index) => {
    const length = durationMs ?? operation.source_out_ms - operation.source_in_ms;
    const next = {
      ...operation,
      operation_id: `op_${index + 1}`,
      timeline_start_ms: at,
      source_out_ms: operation.source_in_ms + length,
    };
    at += length;
    return next;
  });

  return { ...full, tracks: { ...full.tracks, video } };
}

describe('what a review finds', () => {
  it('spots a jump between two places that were never adjacent', () => {
    // The cut a viewer notices: the hotel, then the park, with the train that
    // joined them left on the floor.
    const observations = reviewPlan(planOf(['evt_0001', 'evt_0003']), withRelations);
    expect(observations.some((o) => o.observation_type === 'abrupt_location_change')).toBe(true);
  });

  it('does not call it a jump when the two really were adjacent', () => {
    const observations = reviewPlan(planOf(['evt_0001', 'evt_0002']), withRelations);
    expect(observations.some((o) => o.observation_type === 'abrupt_location_change')).toBe(false);
  });

  it('spots the same thing shown twice in a row', () => {
    const observations = reviewPlan(planOf(['evt_0003', 'evt_0004']), withRelations);
    expect(observations.some((o) => o.observation_type === 'repetition')).toBe(true);
  });

  it('spots a clip too short to register, and one that outstays its welcome', () => {
    const short = reviewPlan(planOf(['evt_0001'], 200), withRelations);
    expect(short.some((o) => o.observation_type === 'too_short')).toBe(true);

    const long = reviewPlan(planOf(['evt_0001'], 40_000), withRelations);
    expect(long.some((o) => o.observation_type === 'too_long')).toBe(true);
  });

  it('says nothing about a cut with nothing wrong with it', () => {
    // A reviewer that always finds something is as useless as one that never
    // does; silence has to be a real answer.
    expect(reviewPlan(planOf(['evt_0001', 'evt_0002']), withRelations)).toEqual([]);
  });

  it('reports in timeline order, so the list reads like the cut', () => {
    const observations = reviewPlan(planOf(['evt_0003', 'evt_0004'], 200), withRelations);
    const times = observations.map((o) => o.timeline_ms);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('is deterministic', () => {
    const plan = planOf(['evt_0001', 'evt_0003']);
    expect(JSON.stringify(reviewPlan(plan, withRelations))).toBe(
      JSON.stringify(reviewPlan(plan, withRelations)),
    );
  });
});

describe('what a review suggests doing about it', () => {
  it('offers the shot that was between the two, for a jump', () => {
    // The fix for "this jumps" is usually a shot the planner already rejected,
    // and it is offered rather than applied: the piece gets longer, and that is
    // a decision with a cost.
    const plan = planOf(['evt_0001', 'evt_0003']);
    const suggestions = suggestRevisions(reviewPlan(plan, withRelations), plan, withRelations);
    const bridge = suggestions.find((s) => s.action === 'insert_bridge');

    expect(bridge).toBeDefined();
    expect(bridge!.candidate_event_id).toBe('evt_0002');
  });

  it('says there is nothing to bridge with when there is not', () => {
    const narrow = makeIR({
      events: [
        {
          id: 'evt_0001',
          description: 'ホテル',
          places: ['ホテル'],
          start_ms: 0,
          duration_ms: 20_000,
        },
        {
          id: 'evt_0002',
          description: '公園',
          places: ['公園'],
          start_ms: 20_000,
          duration_ms: 20_000,
        },
      ],
    });
    const plan = planOf(['evt_0001', 'evt_0002']);
    const suggestions = suggestRevisions(reviewPlan(plan, narrow), plan, narrow);
    for (const suggestion of suggestions.filter((s) => s.action === 'insert_bridge')) {
      expect(suggestion.candidate_event_id).toBeUndefined();
      expect(suggestion.reason).toMatch(/nothing/);
    }
  });

  it('offers to lengthen a clip too short to register', () => {
    const plan = planOf(['evt_0001'], 200);
    const suggestions = suggestRevisions(reviewPlan(plan, withRelations), plan, withRelations);
    expect(suggestions.some((s) => s.action === 'extend_operation')).toBe(true);
  });

  it('offers to drop the second of two clips showing the same thing', () => {
    const plan = planOf(['evt_0003', 'evt_0004']);
    const suggestions = suggestRevisions(reviewPlan(plan, withRelations), plan, withRelations);
    expect(suggestions.some((s) => s.action === 'drop_operation')).toBe(true);
  });

  it('suggests nothing for a cut it found nothing wrong with', () => {
    const plan = planOf(['evt_0001', 'evt_0002']);
    expect(suggestRevisions(reviewPlan(plan, withRelations), plan, withRelations)).toEqual([]);
  });
});

describe('recordRevision', () => {
  it('keeps what was found, and why the round happened', () => {
    const plan = planOf(['evt_0001', 'evt_0003']);
    const observations = reviewPlan(plan, withRelations);
    const revision = recordRevision(
      plan,
      2,
      observations,
      'the first cut jumped',
      () => '2026-05-17T09:00:00.000Z',
    );

    expect(revision.plan_id).toBe(plan.id);
    expect(revision.revision_number).toBe(2);
    expect(revision.reason).toBe('the first cut jumped');
    expect(revision.observations).toHaveLength(observations.length);
  });
});
