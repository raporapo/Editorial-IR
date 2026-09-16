import { describe, expect, it } from 'vitest';
import { EMBEDDING_KINDS, embeddingRefFor, type EmbeddingRecord } from '@editorial-ir/contracts';
import { HashingTextEmbedding } from '@editorial-ir/perception';
import {
  FlatVectorIndex,
  SemanticIndex,
  aspectText,
  cosine,
  populatedAspects,
} from '../src/index.js';
import { makeIR } from '../../../tests/support/ir.js';

const encoder = new HashingTextEmbedding();

const ir = makeIR({
  occasion: '交際1周年旅行',
  events: [
    {
      description: '電車でUSJへ移動している',
      event_type: 'travel',
      speech: ['もうすぐ着くね'],
      visual_labels: ['train', 'window'],
      places: ['電車'],
    },
    {
      description: '二人がUSJ入口に到着し喜んでいる',
      event_type: 'arrival',
      speech: ['やっと着いた！'],
      visual_labels: ['two_people', 'theme_park_gate'],
      ocr: ['UNIVERSAL STUDIOS JAPAN'],
      audio: ['crowd', 'laughter'],
      places: ['USJ'],
      affect: { excitement: 0.88, happiness: 0.83 },
    },
    {
      description: '夜景を見ながら静かに話している',
      event_type: 'moment',
      speech: ['また来ようね'],
      visual_labels: ['night_view', 'city_lights'],
      places: ['展望台'],
      affect: { intimacy: 0.8, calm: 0.7 },
    },
    {
      description: 'ラーメンを食べている',
      event_type: 'meal',
      speech: ['このラーメン美味しい'],
      visual_labels: ['ramen', 'restaurant'],
    },
  ],
});

async function buildIndex(): Promise<SemanticIndex> {
  const vectors = new FlatVectorIndex();
  const records: EmbeddingRecord[] = [];
  for (const event of ir.events) {
    for (const kind of populatedAspects(event, ir.context)) {
      const [vector] = await encoder.embed([aspectText(event, kind, ir.context)]);
      records.push({
        id: embeddingRefFor(event.id, kind),
        owner_id: event.id,
        kind,
        dim: encoder.dim,
        vector: vector ?? [],
      });
    }
  }
  vectors.add(records);
  return new SemanticIndex(ir, vectors, encoder);
}

describe('aspectText', () => {
  it('sends each kind of query to the fields that can answer it', () => {
    const arrival = ir.events[1]!;
    expect(aspectText(arrival, 'visual', ir.context)).toContain('theme_park_gate');
    expect(aspectText(arrival, 'speech', ir.context)).toBe('やっと着いた！');
    expect(aspectText(arrival, 'event', ir.context)).toContain('arrival');
    expect(aspectText(arrival, 'audio', ir.context)).toContain('laughter');
  });

  it('puts the occasion in the context aspect, and only there', () => {
    const arrival = ir.events[1]!;
    expect(aspectText(arrival, 'context', ir.context)).toContain('交際1周年旅行');
    expect(aspectText(arrival, 'visual', ir.context)).not.toContain('交際1周年旅行');
  });

  it('repeats an affect word in proportion to its intensity', () => {
    const strong = aspectText(ir.events[1]!, 'mood', ir.context);
    expect(strong.split(' ').filter((w) => w === 'excitement').length).toBeGreaterThan(1);
  });

  it('reports only the aspects that actually have text', () => {
    const noAudio = ir.events[0]!;
    expect(populatedAspects(noAudio, ir.context)).not.toContain('audio');
    expect(populatedAspects(ir.events[1]!, ir.context)).toContain('audio');
  });
});

describe('FlatVectorIndex', () => {
  it('ranks by cosine similarity and breaks ties by id', async () => {
    const index = new FlatVectorIndex();
    index.add([
      { id: 'a:event', owner_id: 'evt_b', kind: 'event', dim: 2, vector: [1, 0] },
      { id: 'b:event', owner_id: 'evt_a', kind: 'event', dim: 2, vector: [1, 0] },
      { id: 'c:event', owner_id: 'evt_c', kind: 'event', dim: 2, vector: [0, 1] },
    ]);
    const hits = index.search({ vector: [1, 0], kind: 'event' });
    expect(hits.map((h) => h.ownerId)).toEqual(['evt_a', 'evt_b', 'evt_c']);
    expect(hits[0]!.score).toBeCloseTo(1, 6);
  });

  it('normalises on the way in, so an unnormalised query still works', () => {
    const index = new FlatVectorIndex();
    index.add([{ id: 'a:event', owner_id: 'evt_a', kind: 'event', dim: 2, vector: [3, 4] }]);
    expect(index.search({ vector: [30, 40], kind: 'event' })[0]!.score).toBeCloseTo(1, 6);
  });

  it('keeps aspects apart', () => {
    const index = new FlatVectorIndex();
    index.add([
      { id: 'a:event', owner_id: 'evt_a', kind: 'event', dim: 2, vector: [1, 0] },
      { id: 'a:visual', owner_id: 'evt_a', kind: 'visual', dim: 2, vector: [0, 1] },
    ]);
    expect(index.search({ vector: [1, 0], kind: 'visual' })[0]!.score).toBeCloseTo(0, 6);
    expect(index.owners('visual')).toEqual(['evt_a']);
    expect(index.size).toBe(2);
  });

  it('finds the most similar pair, which is how redundancy is spotted', () => {
    const index = new FlatVectorIndex();
    index.add([
      { id: '1', owner_id: 'evt_a', kind: 'event', dim: 2, vector: [1, 0] },
      { id: '2', owner_id: 'evt_b', kind: 'event', dim: 2, vector: [0.99, 0.14] },
      { id: '3', owner_id: 'evt_c', kind: 'event', dim: 2, vector: [0, 1] },
    ]);
    const pairs = index.pairsAbove('event', 0.9);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.a, pairs[0]!.b].sort()).toEqual(['evt_a', 'evt_b']);

    const maxima = index.maxSimilarities('event');
    expect(maxima.get('evt_a')).toBeGreaterThan(0.9);
    expect(maxima.get('evt_c')).toBeLessThan(0.3);
  });

  it('reports no similarity when there is nothing to compare against', () => {
    const index = new FlatVectorIndex();
    index.add([{ id: '1', owner_id: 'evt_a', kind: 'event', dim: 2, vector: [1, 0] }]);
    expect(index.maxSimilarities('event').size).toBe(0);
  });

  it('computes cosine for unnormalised input', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 0])).toBe(0);
  });
});

describe('SemanticIndex', () => {
  it('finds the night view by what is visible', async () => {
    const index = await buildIndex();
    const hits = await index.search('夜景', { limit: 3 });
    expect(hits[0]!.event_id).toBe('evt_0003');
  });

  it('finds a line by what was said', async () => {
    const index = await buildIndex();
    const hits = await index.search('また来ようと言っているところ', {
      kinds: ['speech'],
      limit: 3,
    });
    expect(hits[0]!.event_id).toBe('evt_0003');
  });

  it('finds the arrival by what kind of event it is', async () => {
    const index = await buildIndex();
    const hits = await index.search('到着した場面', { kinds: ['event'], limit: 3 });
    expect(hits[0]!.event_id).toBe('evt_0002');
  });

  it('finds a proper noun that only appears in on-screen text', async () => {
    const index = await buildIndex();
    const hits = await index.search('UNIVERSAL STUDIOS', { limit: 3 });
    expect(hits[0]!.event_id).toBe('evt_0002');
  });

  it('says which aspect matched and why', async () => {
    const index = await buildIndex();
    const [hit] = await index.search('ラーメン', { limit: 1 });
    expect(hit!.event_id).toBe('evt_0004');
    expect(hit!.snippet.length).toBeGreaterThan(0);
    expect(EMBEDDING_KINDS).toContain(hit!.kind);
  });

  it('honours a time window', async () => {
    const index = await buildIndex();
    const hits = await index.search('夜景', { timeRange: { start_ms: 0, end_ms: 15_000 } });
    expect(hits.every((h) => ['evt_0001', 'evt_0002'].includes(h.event_id))).toBe(true);
  });

  it('returns nothing for an empty query rather than everything', async () => {
    const index = await buildIndex();
    expect(await index.search('   ')).toEqual([]);
  });

  it('finds the most similar other event', async () => {
    const index = await buildIndex();
    const similar = index.similarTo('evt_0002', 'event', 2);
    expect(similar.every((h) => h.event_id !== 'evt_0002')).toBe(true);
    expect(similar.length).toBeLessThanOrEqual(2);
  });

  it('still finds a literal match when the vector misses it', async () => {
    const index = await buildIndex();
    // Leaning entirely on vectors is how a search misses the one clip the user
    // is certain exists, so literal overlap always contributes.
    const hits = await index.search('UNIVERSAL', { vectorWeight: 0, limit: 1 });
    expect(hits[0]!.event_id).toBe('evt_0002');
    expect(hits[0]!.lexical_score).toBeGreaterThan(0);
  });
});
