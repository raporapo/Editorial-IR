import {
  EMBEDDING_KINDS,
  coverage,
  embeddingRefFor,
  type EditorialIR,
  type EmbeddingKind,
  type SemanticEvent,
} from '@editorial-ir/contracts';
import type { VectorIndex } from './vector.js';
import { aspectText } from './aspects.js';

/**
 * Anything that can turn text into vectors.
 *
 * Structural rather than imported so that the index does not depend on the
 * perception package: what it needs is one method, not a model registry.
 */
export interface TextEncoder {
  embed(texts: string[], role?: 'query' | 'passage'): Promise<number[][]>;
}

export interface SearchOptions {
  /** Which aspects to search. Defaults to all of them. */
  kinds?: readonly EmbeddingKind[];
  limit?: number;
  minScore?: number;
  /** Restrict to a window on the capture timeline. */
  timeRange?: { start_ms: number; end_ms: number };
  chapterId?: string;
  eventIds?: readonly string[];
  /**
   * Weight of vector similarity against literal text overlap, in [0,1].
   *
   * Both matter, for different reasons: a vector finds a paraphrase, and literal
   * overlap finds a proper noun the model has never seen. Leaning entirely on
   * either is how a search misses the one clip the user is certain exists.
   */
  vectorWeight?: number;
}

export interface SearchHit {
  event_id: string;
  score: number;
  /** Which aspect matched best. */
  kind: EmbeddingKind;
  vector_score: number;
  lexical_score: number;
  /** A short piece of the matching text, for showing why it matched. */
  snippet: string;
}

/** Aspects whose stored vectors could not be searched with this query. */
export interface SearchDiagnostics {
  /** Aspects where the query and the index are in different embedding spaces. */
  unsearchableKinds: EmbeddingKind[];
}

const DEFAULT_VECTOR_WEIGHT = 0.65;

/**
 * Retrieval over an Editorial IR.
 *
 * Searching the IR rather than the video is the point of having compiled one:
 * "find where they say let's come back" costs a vector comparison, not another
 * pass over an hour of footage.
 */
export class SemanticIndex {
  private readonly events = new Map<string, SemanticEvent>();

  constructor(
    private readonly ir: EditorialIR,
    private readonly vectors: VectorIndex,
    private readonly encoder: TextEncoder,
  ) {
    for (const event of ir.events) this.events.set(event.id, event);
  }

  get eventCount(): number {
    return this.events.size;
  }

  /** Aspects the last search could not compare vectors for. */
  lastDiagnostics: SearchDiagnostics = { unsearchableKinds: [] };

  /** Searches one aspect, or all of them and keeps each event's best. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const kinds = options.kinds ?? EMBEDDING_KINDS;
    const limit = options.limit ?? 10;
    const vectorWeight = options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
    const candidates = this.candidateIds(options);
    if (candidates.length === 0 || query.trim().length === 0) return [];

    const [queryVector] = await this.encoder.embed([query], 'query');

    const best = new Map<string, SearchHit>();
    const unsearchable: EmbeddingKind[] = [];

    for (const kind of kinds) {
      const vectorHits = new Map<string, number>();
      if (queryVector) {
        for (const hit of this.vectors.search({ vector: queryVector, kind, ownerIds: candidates })) {
          vectorHits.set(hit.ownerId, hit.score);
        }
        // Stored vectors that the query could not be compared against: the
        // search still works lexically, and the caller is told why it is weaker.
        if (vectorHits.size === 0 && this.vectors.owners(kind).length > 0) unsearchable.push(kind);
      }

      for (const eventId of candidates) {
        const event = this.events.get(eventId);
        if (!event) continue;
        const text = aspectText(event, kind, this.ir.context);
        if (text.trim().length === 0) continue;

        const vectorScore = vectorHits.get(eventId) ?? 0;
        const lexicalScore = coverage(query, text);
        const score = vectorWeight * vectorScore + (1 - vectorWeight) * lexicalScore;
        if (score <= 0) continue;

        const existing = best.get(eventId);
        if (!existing || score > existing.score) {
          best.set(eventId, {
            event_id: eventId,
            score: round(score),
            kind,
            vector_score: round(vectorScore),
            lexical_score: round(lexicalScore),
            snippet: snippetOf(text),
          });
        }
      }
    }

    this.lastDiagnostics = { unsearchableKinds: unsearchable };

    const minScore = options.minScore ?? 0;
    return [...best.values()]
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score || a.event_id.localeCompare(b.event_id))
      .slice(0, limit);
  }

  /** Events most like a given one, for finding second takes and callbacks. */
  similarTo(eventId: string, kind: EmbeddingKind = 'event', limit = 5): SearchHit[] {
    const vector = this.vectors.get(eventId, kind);
    if (!vector) return [];
    return this.vectors
      .search({ vector, kind, limit: limit + 1 })
      .filter((hit) => hit.ownerId !== eventId)
      .slice(0, limit)
      .map((hit) => {
        const event = this.events.get(hit.ownerId);
        return {
          event_id: hit.ownerId,
          score: round(hit.score),
          kind,
          vector_score: round(hit.score),
          lexical_score: 0,
          snippet: event ? snippetOf(aspectText(event, kind, this.ir.context)) : '',
        };
      });
  }

  private candidateIds(options: SearchOptions): string[] {
    let ids = [...this.events.keys()];
    if (options.eventIds) {
      const allowed = new Set(options.eventIds);
      ids = ids.filter((id) => allowed.has(id));
    }
    if (options.chapterId) {
      ids = ids.filter((id) => this.events.get(id)?.chapter_id === options.chapterId);
    }
    if (options.timeRange) {
      const { start_ms, end_ms } = options.timeRange;
      ids = ids.filter((id) => {
        const event = this.events.get(id);
        return event !== undefined && event.start_ms < end_ms && start_ms < event.end_ms;
      });
    }
    return ids.sort();
  }
}

/** Which embedding refs an event should carry, given what was indexed. */
export function embeddingRefsFor(eventId: string, kinds: readonly EmbeddingKind[]): string[] {
  return kinds.map((kind) => embeddingRefFor(eventId, kind));
}

function snippetOf(text: string, max = 80): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
