import { describe, expect, it } from 'vitest';
import type { EditorialIR, EmbeddingRecord } from '@editorial-ir/contracts';
import { FlatVectorIndex } from '../src/vector.js';
import { SemanticIndex, looksEnglishEnough } from '../src/search.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * Searching the frames a vision model looked at.
 *
 * This is the half of retrieval that has never worked. Frame vectors go into the
 * `visual` aspect; a query encoded by the sentence encoder is a different width;
 * the index refuses to compare them, correctly; and the aspect falls back to
 * matching its labels as words. Every frame embedded, none of it reachable — and
 * the only sign was a diagnostic that read like a design note.
 *
 * So what is tested here is not "does cosine work". It is that the query goes to
 * the right model, that a query the model cannot read is declined rather than
 * answered, and that the caller is told which of those happened.
 */

const VISUAL_DIM = 8;

const irFixture = (): EditorialIR =>
  makeIR({
    occasion: '交際1周年旅行',
    events: [
      { description: '電車でUSJへ移動している', event_type: 'travel', visual_labels: ['train'] },
      {
        description: '二人がUSJ入口に到着し喜んでいる',
        event_type: 'arrival',
        visual_labels: ['theme_park_gate'],
      },
      {
        description: '夜景を見ながら静かに話している',
        event_type: 'moment',
        visual_labels: ['night_view'],
      },
    ],
  });

/** A unit vector pointing at one axis, so "same axis" means "same content". */
function axis(index: number, dim = VISUAL_DIM): number[] {
  return Array.from({ length: dim }, (_, i) => (i === index ? 1 : 0));
}

function indexWith(
  ir: EditorialIR,
  records: EmbeddingRecord[],
  visualEncoder?: {
    embedQuery(texts: string[]): Promise<number[][]>;
    queryLanguage?: string;
  },
): SemanticIndex {
  const vectors = new FlatVectorIndex();
  vectors.add(records);
  // A text encoder of a deliberately different width, which is the real
  // situation: the sentence encoder and the vision model are different models.
  const text = {
    embed: async (texts: string[]): Promise<number[][]> =>
      texts.map(() => Array.from({ length: 16 }, () => 0)),
  };
  return new SemanticIndex(ir, vectors, text, visualEncoder);
}

function frameVectors(ir: EditorialIR): EmbeddingRecord[] {
  return ir.events.map((event, position) => ({
    id: `${event.id}:visual`,
    owner_id: event.id,
    kind: 'visual' as const,
    dim: VISUAL_DIM,
    vector: axis(position),
  }));
}

describe('looksEnglishEnough', () => {
  it('accepts the scripts an English text tower can rank', () => {
    expect(looksEnglishEnough('a night view of the city')).toBe(true);
    expect(looksEnglishEnough('coucher de soleil')).toBe(true);
    expect(looksEnglishEnough('a café at 3pm — 100% full')).toBe(true);
  });

  it('rejects the ones it cannot', () => {
    // The measured failure. Against CLIP's tower this scores at noise level and
    // returns a confident ranking, which is worse than returning nothing.
    expect(looksEnglishEnough('夜景が映っているところ')).toBe(false);
    expect(looksEnglishEnough('한국어')).toBe(false);
    expect(looksEnglishEnough('Русский')).toBe(false);
  });

  it('rejects a query that is mostly English with one CJK word in it', () => {
    // Mixed input is the common case for these users, and the tower cannot read
    // the part that carries the meaning.
    expect(looksEnglishEnough('the shot of 道頓堀 at night')).toBe(false);
  });
});

describe('searching the visual aspect', () => {
  it('finds the event whose frames match, using the vision model for the query', async () => {
    const ir = irFixture();
    const target = ir.events[1]!;
    const index = indexWith(ir, frameVectors(ir), {
      embedQuery: async () => [axis(1)],
      queryLanguage: 'en',
    });

    const hits = await index.search('anything at all', { kinds: ['visual'], limit: 5 });
    expect(hits[0]?.event_id).toBe(target.id);
    expect(hits[0]?.vector_score).toBeGreaterThan(0.9);
    expect(index.lastDiagnostics.unsearchableKinds).not.toContain('visual');
  });

  it('never sends the visual query to the text encoder', async () => {
    // The bug this whole path exists to prevent. If the sentence encoder's
    // vector reached the visual index they would be different widths and score
    // nothing — but a model that happened to agree on width would produce a
    // confident ranking out of two unrelated spaces, undetectably.
    const ir = irFixture();
    const asked: string[][] = [];
    const index = indexWith(ir, frameVectors(ir), {
      embedQuery: async (texts) => {
        asked.push(texts);
        return [axis(0)];
      },
      queryLanguage: 'en',
    });
    await index.search('the opening shot', { kinds: ['visual'] });
    expect(asked).toEqual([['the opening shot']]);
  });

  it('says it could not search when there is no vision model to ask', async () => {
    const ir = irFixture();
    const index = indexWith(ir, frameVectors(ir));
    await index.search('a night view', { kinds: ['visual'] });
    expect(index.lastDiagnostics.unsearchableKinds).toContain('visual');
    expect(index.lastDiagnostics.visualFallback).toBe('no_query_encoder');
  });

  it('declines a Japanese query against an English-only tower, and says why', async () => {
    const ir = irFixture();
    let called = false;
    const index = indexWith(ir, frameVectors(ir), {
      embedQuery: async () => {
        called = true;
        return [axis(1)];
      },
      queryLanguage: 'en',
    });

    await index.search('夜景が映っているところ', { kinds: ['visual'] });
    expect(called).toBe(false);
    expect(index.lastDiagnostics.visualFallback).toBe('query_language');
  });

  it('sends a Japanese query to a multilingual tower', async () => {
    const ir = irFixture();
    let called = false;
    const index = indexWith(ir, frameVectors(ir), {
      embedQuery: async () => {
        called = true;
        return [axis(1)];
      },
      queryLanguage: 'multi',
    });

    await index.search('夜景が映っているところ', { kinds: ['visual'] });
    expect(called).toBe(true);
    expect(index.lastDiagnostics.visualFallback).toBeUndefined();
  });

  it('keeps answering when the vision model throws', async () => {
    // A search is not worth failing over a model that went away mid-session.
    const ir = irFixture();
    const index = indexWith(ir, frameVectors(ir), {
      embedQuery: async () => {
        throw new Error('the worker died');
      },
      queryLanguage: 'en',
    });

    await expect(index.search('a night view', { kinds: ['visual'] })).resolves.toBeInstanceOf(
      Array,
    );
    expect(index.lastDiagnostics.visualFallback).toBe('encoder_failed');
  });

  it('reports an aspect it could not search even when no query vector was made at all', async () => {
    // This check used to sit inside `if (queryVector)`, so an aspect with no
    // query vector — exactly what `visual` has with no text tower — was skipped
    // without ever being reported. Silence is the one outcome that is not
    // allowed here.
    const ir = irFixture();
    const index = indexWith(ir, frameVectors(ir));
    await index.search('anything', { kinds: ['visual'] });
    expect(index.lastDiagnostics.unsearchableKinds).toEqual(['visual']);
  });
});
