import type { ModelIdentity, TextEmbeddingModel } from '../types.js';

/**
 * A text embedding that needs no model, no download and no network.
 *
 * It is a signed hashing vectoriser over character n-grams and word tokens.
 * Character n-grams matter here because the first users of this project write in
 * Japanese, where whitespace tokenisation finds nothing.
 *
 * Be clear about what this is: lexical retrieval, not semantic retrieval. It
 * finds 夜景 when you search for 夜景, and it will not find "night view" for you.
 * Its job is to make search, redundancy detection and the whole pipeline work on
 * a laptop with no GPU and no API key, and to be swapped for a real embedding
 * model the moment one is configured. Everything downstream reads
 * {@link TextEmbeddingModel}, so that swap is one line of configuration.
 */
export interface HashingTextEmbeddingOptions {
  /** Vector width. 256 is ample for a few thousand events and keeps files small. */
  dim?: number;
  /** Character n-gram sizes. 2 and 3 cover CJK and latin reasonably. */
  charNgrams?: number[];
  /** Include whitespace-delimited word tokens as features. */
  includeWords?: boolean;
}

const DEFAULT_DIM = 256;
const DEFAULT_NGRAMS = [2, 3];

export class HashingTextEmbedding implements TextEmbeddingModel {
  readonly dim: number;
  readonly identity: ModelIdentity;
  private readonly charNgrams: number[];
  private readonly includeWords: boolean;

  constructor(options: HashingTextEmbeddingOptions = {}) {
    this.dim = options.dim ?? DEFAULT_DIM;
    this.charNgrams = options.charNgrams ?? [...DEFAULT_NGRAMS];
    this.includeWords = options.includeWords ?? true;
    this.identity = {
      backend: 'hashing',
      model: `hashing-${this.dim}`,
      modelVersion: '1',
      locality: 'local',
      mediaLeavesDevice: false,
      parameters: { dim: this.dim, char_ngrams: this.charNgrams, words: this.includeWords },
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): number[] {
    const vector = new Array<number>(this.dim).fill(0);
    const counts = new Map<string, number>();

    for (const feature of this.features(text)) {
      counts.set(feature, (counts.get(feature) ?? 0) + 1);
    }

    for (const [feature, count] of counts) {
      // Sublinear term frequency: a word said ten times is not ten times more
      // about the topic than a word said once.
      const weight = 1 + Math.log(count);
      const index = fnv1a(feature) % this.dim;
      // Signed hashing, so collisions cancel instead of always adding up.
      const sign = (fnv1a(`${feature}#sign`) & 1) === 0 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign * weight;
    }

    return l2normalize(vector);
  }

  private *features(text: string): Generator<string> {
    const normalized = normalizeText(text);
    if (normalized.length === 0) return;

    if (this.includeWords) {
      for (const word of normalized.split(' ')) {
        if (word.length > 0) yield `w:${word}`;
      }
    }

    const compact = normalized.replace(/ /g, '');
    for (const n of this.charNgrams) {
      if (compact.length < n) continue;
      for (let i = 0; i + n <= compact.length; i++) {
        yield `c${n}:${compact.slice(i, i + n)}`;
      }
    }
  }
}

/** Unicode-normalises, lowercases and reduces punctuation to single spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * FNV-1a, 32 bit, over UTF-16 code units low byte first.
 *
 * Chosen because it is short, stable across runs and trivially reproducible in
 * Python, which matters the day the perception worker wants to produce vectors
 * that land in the same space.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    const high = code >> 8;
    if (high !== 0) {
      hash ^= high;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}

export function l2normalize(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  if (sum === 0) return vector;
  const norm = Math.sqrt(sum);
  return vector.map((v) => v / norm);
}
