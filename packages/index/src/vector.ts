import { compareText } from '@editorial-ir/contracts';
import type { EmbeddingKind, EmbeddingRecord } from '@editorial-ir/contracts';
import { calibrationOf, strengthOf, type Calibration } from './calibrate.js';

/**
 * Vector storage, behind an interface so the default can be replaced without
 * touching anything that searches.
 */
export interface VectorQuery {
  vector: number[];
  kind: EmbeddingKind;
  limit?: number;
  /** Restrict to these owner ids, for searching inside a chapter or a filter. */
  ownerIds?: readonly string[];
  /** Drop anything below this similarity. */
  minScore?: number;
}

export interface VectorHit {
  ownerId: string;
  kind: EmbeddingKind;
  score: number;
}

export interface VectorIndex {
  /**
   * How well this aspect's own vectors tell its members apart, when the index
   * can say. Optional so that a replacement index need not implement it; search
   * simply keeps the per-query calibration alone.
   */
  discrimination?(kind: EmbeddingKind): Calibration | undefined;
  add(records: readonly EmbeddingRecord[]): void;
  search(query: VectorQuery): VectorHit[];
  get(ownerId: string, kind: EmbeddingKind): number[] | undefined;
  /** Every owner that has a vector of this kind. */
  owners(kind: EmbeddingKind): string[];
  readonly size: number;
}

/**
 * Exhaustive cosine search over vectors held in memory.
 *
 * This is a deliberate choice, not a placeholder. A one-hour project produces a
 * few hundred events and a few thousand vectors; at that size an exhaustive scan
 * costs microseconds, while an approximate index costs a native dependency, a
 * build step and a class of correctness bugs that only appear at recall
 * boundaries. The interface is here so that a project large enough to need
 * pgvector or a local vector database can have one, and nothing above it changes.
 *
 * Vectors are stored already normalised, so cosine similarity is a dot product.
 */
/**
 * How many vectors to sample when measuring an aspect's discriminating power.
 *
 * Sixty gives 1,770 pairs, which is far more than a median and a MAD need, and
 * it bounds the cost at a constant rather than at the square of the project.
 */
const DISCRIMINATION_SAMPLE = 60;

export class FlatVectorIndex implements VectorIndex {
  private readonly byKind = new Map<EmbeddingKind, Map<string, number[]>>();
  /**
   * Memoised, and invalidated by `add`, because it is a property of the whole
   * index rather than of a query and every search would otherwise recompute it.
   */
  private readonly discriminationByKind = new Map<EmbeddingKind, { calibration?: Calibration }>();

  get size(): number {
    let total = 0;
    for (const map of this.byKind.values()) total += map.size;
    return total;
  }

  add(records: readonly EmbeddingRecord[]): void {
    // Whatever was measured about how well these aspects separate is now about
    // a smaller index than the one that exists.
    if (records.length > 0) this.discriminationByKind.clear();
    for (const record of records) {
      let map = this.byKind.get(record.kind);
      if (!map) {
        map = new Map();
        this.byKind.set(record.kind, map);
      }
      map.set(record.owner_id, normalise(record.vector));
    }
  }

  get(ownerId: string, kind: EmbeddingKind): number[] | undefined {
    return this.byKind.get(kind)?.get(ownerId);
  }

  owners(kind: EmbeddingKind): string[] {
    return [...(this.byKind.get(kind)?.keys() ?? [])].sort();
  }

  search(query: VectorQuery): VectorHit[] {
    const map = this.byKind.get(query.kind);
    if (!map) return [];

    const allowed = query.ownerIds ? new Set(query.ownerIds) : undefined;
    const needle = normalise(query.vector);
    const minScore = query.minScore ?? -Infinity;

    const hits: VectorHit[] = [];
    for (const [ownerId, vector] of map) {
      if (allowed && !allowed.has(ownerId)) continue;
      // Vectors of different widths came from different models and are not in
      // the same space. Comparing the overlapping prefix produces a number, and
      // the number is noise — which is far worse than no answer, because it
      // ranks confidently. A text query cannot search vision vectors unless the
      // two models share an embedding space, and width is the cheap proxy for
      // "they do not".
      if (vector.length !== needle.length) continue;
      const score = dot(needle, vector);
      if (score >= minScore) hits.push({ ownerId, kind: query.kind, score });
    }

    // Ties break by id so that two runs over the same data agree exactly.
    hits.sort((a, b) => b.score - a.score || compareText(a.ownerId, b.ownerId));
    return query.limit === undefined ? hits : hits.slice(0, query.limit);
  }

  /** Every pairwise similarity above a floor, for redundancy detection. */
  pairsAbove(kind: EmbeddingKind, threshold: number): { a: string; b: string; score: number }[] {
    const map = this.byKind.get(kind);
    if (!map) return [];
    const entries = [...map.entries()].sort((x, y) => compareText(x[0], y[0]));
    const pairs: { a: string; b: string; score: number }[] = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const first = entries[i];
        const second = entries[j];
        if (!first || !second) continue;
        const score = dot(first[1], second[1]);
        if (score >= threshold) pairs.push({ a: first[0], b: second[0], score });
      }
    }
    pairs.sort((x, y) => y.score - x.score || compareText(x.a, y.a) || compareText(x.b, y.b));
    return pairs;
  }

  /**
   * Each owner's closest neighbour, as a strength rather than a raw cosine.
   *
   * The raw number is what `maxSimilarities` returns and it is not comparable
   * across models: measured on a real 62-minute project embedded with
   * multilingual-e5-large, the *least* similar pair of events scored 0.747 and
   * the median pair 0.813. The rules turn those into redundancy with
   * `(similarity - 0.6) / 0.4`, a constant written when the lexical vectoriser
   * scored unrelated pairs at zero — so the least similar pair in the project
   * came out at 0.368 and the median pair at 0.533, over the 0.5 line that skill
   * rules read as "redundant". More than half the footage was marked as
   * repeating itself, on material where nothing repeated, and that decides which
   * clips get dropped.
   *
   * Every pairwise similarity in the corpus is the sample: almost all of those
   * pairs are unrelated, so their bulk is this model's floor. Returns the raw
   * maxima unchanged when there is nothing to calibrate against — too few pairs,
   * or a lexical encoder whose spread is zero — so the existing behaviour is
   * what a caller gets when calibration would be a guess.
   */
  calibratedMaxSimilarities(kind: EmbeddingKind): {
    maxima: Map<string, number>;
    calibration?: Calibration;
  } {
    const maxima = this.maxSimilarities(kind);
    const calibration = this.discrimination(kind);
    if (!calibration) return { maxima };
    const calibrated = new Map<string, number>();
    for (const [ownerId, score] of maxima) calibrated.set(ownerId, strengthOf(score, calibration));
    return { maxima: calibrated, calibration };
  }

  /**
   * How well an aspect's own vectors tell its members apart.
   *
   * A property of the index rather than of any query, and the thing that catches
   * an aspect no query can use. The `audio` aspect's text is "music speech" for
   * almost every event of a real project, so its vectors are nearly the same
   * point — and a query's similarity to all of them is then nearly the same
   * number, differing only in the last decimal. Calibrated per query that reads
   * as one event standing four deviations clear of the rest, and it scored 1.000
   * and beat a genuinely better match in another aspect. Measured there: the
   * stored vectors have a median pairwise similarity of 0.9754, so there is less
   * room above the floor than there is noise in it.
   *
   * Sampled rather than exhaustive. Every pair of a 500-event project is 125,000
   * dot products of 1024 dimensions per aspect, and a median needs nothing like
   * that many; the sample is taken at an even stride through the ids, so it is
   * the same sample on every run.
   */
  discrimination(kind: EmbeddingKind): Calibration | undefined {
    const cached = this.discriminationByKind.get(kind);
    if (cached !== undefined) return cached.calibration;

    const map = this.byKind.get(kind);
    let calibration: Calibration | undefined;
    if (map && map.size >= 2) {
      const all = [...map.entries()].sort((a, b) => compareText(a[0], b[0]));
      const stride = Math.max(1, Math.ceil(all.length / DISCRIMINATION_SAMPLE));
      const sample = all.filter((_, index) => index % stride === 0);
      const pairs: number[] = [];
      for (let i = 0; i < sample.length; i++) {
        for (let j = i + 1; j < sample.length; j++) {
          const first = sample[i];
          const second = sample[j];
          if (!first || !second) continue;
          pairs.push(dot(first[1], second[1]));
        }
      }
      calibration = calibrationOf(pairs);
    }
    this.discriminationByKind.set(kind, { calibration });
    return calibration;
  }

  /** The highest similarity each owner has to any other owner of the same kind. */
  maxSimilarities(kind: EmbeddingKind): Map<string, number> {
    const map = this.byKind.get(kind);
    const result = new Map<string, number>();
    if (!map || map.size < 2) return result;
    const entries = [...map.entries()];
    for (const [ownerId] of entries) result.set(ownerId, 0);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const first = entries[i];
        const second = entries[j];
        if (!first || !second) continue;
        const score = dot(first[1], second[1]);
        if (score > (result.get(first[0]) ?? 0)) result.set(first[0], score);
        if (score > (result.get(second[0]) ?? 0)) result.set(second[0], score);
      }
    }
    return result;
  }
}

export function dot(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dotProduct += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / Math.sqrt(normA * normB);
}

export function normalise(vector: readonly number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  if (sum === 0) return [...vector];
  const norm = Math.sqrt(sum);
  return vector.map((v) => v / norm);
}
