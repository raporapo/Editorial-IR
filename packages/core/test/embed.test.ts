import { describe, expect, it } from 'vitest';
import { ProjectContext } from '@editorial-ir/contracts';
import { buildEmbeddings } from '../src/index.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * One index, one vector space.
 *
 * A frame vector and an embedding of the words attached to a frame are points
 * in two unrelated spaces. Storing some of each under the same `visual` kind
 * produces an index whose scores cannot be compared, and nothing downstream can
 * tell: the vector index refuses vectors of different widths, which catches it
 * only when the two models happen to disagree about how wide a vector is.
 */
const ir = makeIR({
  events: [
    { id: 'evt_seen', description: '観覧車', visual_labels: ['ferris_wheel'] },
    { id: 'evt_unseen', description: '夜景', visual_labels: ['night_view'] },
  ],
});

const context = ProjectContext.parse({
  project_id: ir.project.id,
  updated_at: '2026-05-17T09:00:00.000Z',
});

/** Text vectors of a width no vision model would produce, so a mix is visible. */
const encoder = {
  identity: { backend: 'test' as const, locality: 'local' as const, mediaLeavesDevice: false },
  dim: 3,
  embed: (texts: string[]) => Promise.resolve(texts.map(() => [1, 0, 0])),
};

function visualRecords(frameVectors: Map<string, number[]>) {
  return buildEmbeddings(ir.events, context, encoder, { frameVectors }).then(({ records }) =>
    records.filter((record) => record.kind === 'visual'),
  );
}

describe('the visual aspect', () => {
  it('uses the pictures when a vision model saw them', async () => {
    const seen = new Map([['asset_001:1000', [0, 1, 0, 0, 0, 0, 0, 0]]]);
    const records = await visualRecords(seen);
    expect(records).toHaveLength(1);
    expect(records[0]!.owner_id).toBe('evt_seen');
    expect(records[0]!.dim).toBe(8);
  });

  it('gives an event the vision model missed no visual vector at all', async () => {
    // It used to fall back to embedding the event's labels as text — so one
    // index held frame vectors for the events a vision model reached and text
    // vectors for the rest, under the same name.
    const seen = new Map([['asset_001:1000', [0, 1, 0, 0, 0, 0, 0, 0]]]);
    const records = await visualRecords(seen);
    expect(records.map((record) => record.owner_id)).not.toContain('evt_unseen');
  });

  it('falls back to the words for every event when there was no vision model', async () => {
    const records = await visualRecords(new Map());
    expect(records.map((record) => record.owner_id).sort()).toEqual(['evt_seen', 'evt_unseen']);
    expect(new Set(records.map((record) => record.dim))).toEqual(new Set([3]));
  });
});
