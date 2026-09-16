import { describe, expect, it } from 'vitest';
import { HashingTextEmbedding, fnv1a, l2normalize, normalizeText } from '../src/index.js';

const model = new HashingTextEmbedding();

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

describe('normalizeText', () => {
  it('folds width, case and punctuation', () => {
    expect(normalizeText('Hello, World!')).toBe('hello world');
    expect(normalizeText('ＵＳＪ')).toBe('usj');
    expect(normalizeText('  spaced   out  ')).toBe('spaced out');
  });

  it('leaves Japanese text intact apart from punctuation', () => {
    expect(normalizeText('やっと着いた！')).toBe('やっと着いた');
  });
});

describe('fnv1a', () => {
  it('is stable across calls and sensitive to small changes', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });

  it('handles non-ASCII without collapsing it', () => {
    expect(fnv1a('夜景')).not.toBe(fnv1a('夜'));
    expect(fnv1a('夜景')).toBeGreaterThanOrEqual(0);
  });
});

describe('l2normalize', () => {
  it('produces a unit vector', () => {
    const v = l2normalize([3, 4]);
    expect(cosine(v, v)).toBeCloseTo(1, 10);
  });

  it('leaves a zero vector alone rather than dividing by zero', () => {
    expect(l2normalize([0, 0])).toEqual([0, 0]);
  });
});

describe('HashingTextEmbedding', () => {
  it('is deterministic, which is what makes the compiler reproducible', async () => {
    const [a] = await model.embed(['USJの入口に到着した']);
    const [b] = await model.embed(['USJの入口に到着した']);
    expect(a).toEqual(b);
  });

  it('produces unit vectors of the declared width', async () => {
    const [v] = await model.embed(['hello world']);
    expect(v).toHaveLength(model.dim);
    expect(cosine(v!, v!)).toBeCloseTo(1, 10);
  });

  it('scores related Japanese text above unrelated text', async () => {
    const [query, related, unrelated] = await model.embed([
      '夜景がきれい',
      '夜景を見ている',
      '朝ごはんを食べている',
    ]);
    expect(cosine(query!, related!)).toBeGreaterThan(cosine(query!, unrelated!));
  });

  it('scores related English text above unrelated text', async () => {
    const [query, related, unrelated] = await model.embed([
      'walking up to the entrance gate',
      'they walk toward the gate',
      'eating ramen at the counter',
    ]);
    expect(cosine(query!, related!)).toBeGreaterThan(cosine(query!, unrelated!));
  });

  it('finds a substring query inside a longer passage', async () => {
    const [query, passage, other] = await model.embed([
      'ユニバーサルスタジオ',
      'ユニバーサルスタジオジャパンの入口に着いた',
      '電車に乗って移動している',
    ]);
    expect(cosine(query!, passage!)).toBeGreaterThan(cosine(query!, other!));
  });

  it('gives an empty string a zero vector rather than failing', async () => {
    const [v] = await model.embed(['']);
    expect(v!.every((x) => x === 0)).toBe(true);
  });

  it('honours a configured width', async () => {
    const wide = new HashingTextEmbedding({ dim: 64 });
    const [v] = await wide.embed(['test']);
    expect(v).toHaveLength(64);
  });

  it('declares itself local, so the privacy report is accurate', () => {
    expect(model.identity.locality).toBe('local');
    expect(model.identity.mediaLeavesDevice).toBe(false);
  });
});
