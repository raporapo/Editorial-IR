import { describe, expect, it } from 'vitest';
import type { UserAnnotation } from '@editorial-ir/contracts';
import {
  annotationsFor,
  applyAnnotations,
  continuityOverrides,
  withOverrides,
} from '../src/index.js';
import { makeEvent } from '../../../tests/support/ir.js';

/**
 * What the user said, and the rule that it outranks everything.
 *
 * Overrides are applied beside model output rather than over it, so removing one
 * restores the model's opinion instead of losing it, and a real disagreement is
 * recorded rather than resolved by deleting a side.
 */
const event = makeEvent(
  { id: 'evt_0002', start_ms: 10_000, duration_ms: 8000, affect: { calm: 0.6 } },
  1,
);

const now = () => '2026-05-17T09:00:00.000Z';
const base = { priority: 0, created_at: now() };

function annotation(partial: Partial<UserAnnotation> & { type: string }): UserAnnotation {
  return { id: `ann_${partial.type}`, ...base, ...partial } as UserAnnotation;
}

describe('annotationsFor', () => {
  it('matches an annotation aimed at this event', () => {
    const list = [
      annotation({ type: 'essential', target: { kind: 'event', event_id: 'evt_0002' } }),
    ];
    expect(annotationsFor(event, list)).toHaveLength(1);
  });

  it('ignores one aimed at a different event', () => {
    const list = [
      annotation({ type: 'essential', target: { kind: 'event', event_id: 'evt_0009' } }),
    ];
    expect(annotationsFor(event, list)).toHaveLength(0);
  });

  it('matches a time range that covers most of the event', () => {
    const list = [
      annotation({
        type: 'essential',
        target: { kind: 'time_range', start_ms: 9000, end_ms: 20_000 },
      }),
    ];
    expect(annotationsFor(event, list)).toHaveLength(1);
  });

  it('matches a short selection inside the event, because that is what it means', () => {
    // Someone selecting one second inside an eight-second event means that
    // event; the rule is half of the shorter of the two, not half of the event.
    const list = [
      annotation({
        type: 'essential',
        target: { kind: 'time_range', start_ms: 17_000, end_ms: 18_000 },
      }),
    ];
    expect(annotationsFor(event, list)).toHaveLength(1);
  });

  it('ignores a long range that only clips the edge of the event', () => {
    // A loosely drawn selection over the previous event must not mark this one
    // essential as well.
    const list = [
      annotation({
        type: 'essential',
        target: { kind: 'time_range', start_ms: 0, end_ms: 10_500 },
      }),
    ];
    expect(annotationsFor(event, list)).toHaveLength(0);
  });

  it('matches an annotation on the whole asset, or the whole project', () => {
    expect(
      annotationsFor(event, [
        annotation({ type: 'note', text: 'x', target: { kind: 'asset', asset_id: 'asset_001' } }),
      ]),
    ).toHaveLength(1);
    expect(
      annotationsFor(event, [annotation({ type: 'note', text: 'x', target: { kind: 'project' } })]),
    ).toHaveLength(1);
  });

  it('applies the highest priority last, so it wins', () => {
    const list = [
      annotation({
        id: 'ann_low',
        type: 'rename',
        title: 'low',
        priority: 0,
        target: { kind: 'event', event_id: 'evt_0002' },
      }),
      annotation({
        id: 'ann_high',
        type: 'rename',
        title: 'high',
        priority: 5,
        target: { kind: 'event', event_id: 'evt_0002' },
      }),
    ];
    const applied = applyAnnotations(event, annotationsFor(event, list), undefined, now);
    expect(applied.overrides.title).toBe('high');
  });
});

describe('applyAnnotations', () => {
  it('records essential, exclusion, importance and notes', () => {
    const applied = applyAnnotations(
      event,
      [
        annotation({ type: 'essential', target: { kind: 'event', event_id: 'evt_0002' } }),
        annotation({
          type: 'importance',
          value: 0.95,
          target: { kind: 'event', event_id: 'evt_0002' },
        }),
        annotation({
          type: 'note',
          text: 'this is the anniversary bit',
          target: { kind: 'event', event_id: 'evt_0002' },
        }),
      ],
      '交際1周年旅行',
      now,
    );

    expect(applied.knowledge.essential).toBe(true);
    expect(applied.knowledge.importance_override).toBe(0.95);
    expect(applied.knowledge.notes).toEqual(['this is the anniversary bit']);
    expect(applied.knowledge.occasion).toBe('交際1周年旅行');
    expect(applied.knowledge.annotation_refs).toHaveLength(3);
  });

  it('excludes when the user asked for both, and says so', () => {
    const applied = applyAnnotations(
      event,
      [
        annotation({
          id: 'ann_a',
          type: 'essential',
          target: { kind: 'event', event_id: 'evt_0002' },
        }),
        annotation({
          id: 'ann_b',
          type: 'exclude',
          target: { kind: 'event', event_id: 'evt_0002' },
        }),
      ],
      undefined,
      now,
    );

    // Including something they asked to remove is the worse of the two errors.
    expect(applied.knowledge.excluded).toBe(true);
    expect(applied.knowledge.essential).toBe(false);
    expect(applied.conflicts.some((conflict) => conflict.note?.includes('both'))).toBe(true);
  });

  it('records a conflict when the user corrects the model’s reading of a mood', () => {
    const applied = applyAnnotations(
      event,
      [
        annotation({
          type: 'mood',
          mood: { sadness: 0.8 },
          target: { kind: 'event', event_id: 'evt_0002' },
        }),
      ],
      undefined,
      now,
    );

    const conflict = applied.conflicts[0]!;
    expect(conflict.resolved_with).toBe('user_provided');
    // The model's opinion is kept, not deleted.
    expect(conflict.inferred_value).toEqual({ calm: 0.6 });
  });
});

describe('withOverrides', () => {
  it('marks an overridden field as the user’s, not the model’s', () => {
    const applied = applyAnnotations(
      event,
      [
        annotation({
          type: 'rename',
          title: '夜景',
          target: { kind: 'event', event_id: 'evt_0002' },
        }),
        annotation({
          type: 'person',
          people: ['me', 'partner'],
          target: { kind: 'event', event_id: 'evt_0002' },
        }),
        annotation({
          type: 'label',
          labels: ['night_view'],
          target: { kind: 'event', event_id: 'evt_0002' },
        }),
      ],
      undefined,
      now,
    );
    const updated = withOverrides(event, applied);

    expect(updated.title?.value).toBe('夜景');
    expect(updated.title?.provenance).toBe('user_provided');
    expect(updated.entities.provenance).toBe('user_provided');
    expect(updated.observed.visual_labels).toContain('night_view');
  });

  it('leaves everything else alone', () => {
    const applied = applyAnnotations(event, [], undefined, now);
    const updated = withOverrides(event, applied);
    expect(updated.description).toEqual(event.description);
    expect(updated.affect).toEqual(event.affect);
  });
});

describe('continuityOverrides', () => {
  it('collects the strengths the user set between pairs', () => {
    const overrides = continuityOverrides([
      annotation({
        type: 'continuity',
        strength: 0.95,
        target: { kind: 'event_pair', event_a: 'evt_0007', event_b: 'evt_0008' },
      }),
    ]);
    expect(overrides.get('evt_0007->evt_0008')).toBe(0.95);
  });
});
