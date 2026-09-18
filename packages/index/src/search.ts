import {
  compareText,
  EMBEDDING_KINDS,
  coverage,
  embeddingRefFor,
  type EditorialIR,
  type EmbeddingKind,
  type SemanticEvent,
} from '@editorial-ir/contracts';
import type { VectorIndex } from './vector.js';
import { aspectText } from './aspects.js';
import { calibrationOf, strengthOf } from './calibrate.js';

/**
 * Anything that can turn text into vectors.
 *
 * Structural rather than imported so that the index does not depend on the
 * perception package: what it needs is one method, not a model registry.
 */
export interface TextEncoder {
  /**
   * True when this encoder's similarity comes only from shared surface forms.
   *
   * See `TextEmbeddingModel.lexical`. Retrieval reads it to tell a real match
   * from a hash collision; a semantic encoder leaves it unset.
   */
  readonly lexical?: boolean;
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
  /**
   * Why the visual aspect was matched on words alone, when it was.
   *
   * Three different situations produced the same silent outcome before this
   * existed, and they have different answers: provision a vision model, provision
   * one with a text tower, or ask in English. A list of aspect names told the
   * user none of that.
   */
  visualFallback?: 'no_query_encoder' | 'query_language' | 'encoder_failed';
}

/**
 * Anything that can put a query in the *vision* model's space.
 *
 * Separate from `TextEncoder` because it is a different model, and that is the
 * entire point: frame vectors and query vectors have to come from the same one.
 */
export interface VisualQueryEncoder {
  embedQuery(texts: string[]): Promise<number[][]>;
  /** `en` or `multi`. See `looksEnglishEnough`. */
  readonly queryLanguage?: string;
}

/**
 * Whether a query is in a script an English-only text tower can read.
 *
 * A deliberately blunt test: it looks for the scripts that are definitely not
 * English — CJK, kana, Hangul, Cyrillic, Arabic, Hebrew, Thai, Devanagari — and
 * says no if it finds any. It does not try to tell English from French, and it
 * should not: CLIP's tower has seen enough Latin-script text that "coucher de
 * soleil" is a degraded answer rather than a wrong one, whereas 夜景 scores at
 * noise level. The measured failure is the one being guarded against.
 *
 * Erring here is asymmetric. A false "not English" costs the visual aspect on a
 * query the tower might have half-answered; a false "English" returns a
 * confident ranking of noise and looks exactly like a result.
 */
export function looksEnglishEnough(query: string): boolean {
  return !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/u.test(
    query,
  );
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
    /**
     * The vision model's text tower, when there is one. Without it the `visual`
     * aspect is matched on its labels as words and nothing else — which is what
     * happened on every search this project has ever run.
     */
    private readonly visualEncoder?: VisualQueryEncoder,
  ) {
    for (const event of ir.events) this.events.set(event.id, event);
  }

  get eventCount(): number {
    return this.events.size;
  }

  /** Aspects the last search could not compare vectors for. */
  lastDiagnostics: SearchDiagnostics = { unsearchableKinds: [] };

  /**
   * The query in the vision model's space, or the reason there isn't one.
   *
   * Returning a reason rather than just `undefined` is the point: "your footage
   * was never looked at", "the model you provisioned cannot be asked questions"
   * and "ask that in English" are three different problems with three different
   * answers, and they all used to look identical from outside.
   */
  private async visualQuery(
    query: string,
  ): Promise<{ vector?: number[]; reason?: SearchDiagnostics['visualFallback'] }> {
    if (!this.visualEncoder) return { reason: 'no_query_encoder' };
    if (this.visualEncoder.queryLanguage !== 'multi' && !looksEnglishEnough(query)) {
      return { reason: 'query_language' };
    }
    try {
      const [vector] = await this.visualEncoder.embedQuery([query]);
      return vector ? { vector } : { reason: 'encoder_failed' };
    } catch {
      // A search is not worth failing over a model that went away. The lexical
      // half of every aspect still answers, and the diagnostic says what broke.
      return { reason: 'encoder_failed' };
    }
  }

  /** Searches one aspect, or all of them and keeps each event's best. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const kinds = options.kinds ?? EMBEDDING_KINDS;
    const limit = options.limit ?? 10;
    const vectorWeight = options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
    const candidates = this.candidateIds(options);
    if (candidates.length === 0 || query.trim().length === 0) return [];

    const [queryVector] = await this.encoder.embed([query], 'query');
    const { vector: visualVector, reason: visualFallback } = await this.visualQuery(query);

    const best = new Map<string, SearchHit>();
    const unsearchable: EmbeddingKind[] = [];

    for (const kind of kinds) {
      const vectorHits = new Map<string, number>();
      // The visual aspect holds vectors from the vision model, so it is the one
      // aspect whose query does not come from the sentence encoder.
      const queryFor = kind === 'visual' ? visualVector : queryVector;
      if (queryFor) {
        const raw = this.vectors.search({ vector: queryFor, kind, ownerIds: candidates });
        // Almost everything in a project is unrelated to any given query, so
        // the bulk of these scores is this model's floor, observed right here.
        // Without it `minScore` means nothing: measured against e5, "a rocket
        // launching into space" returned all eleven events of a harbour project
        // between 0.486 and 0.517, every one above the threshold. A lexical
        // encoder has no spread to speak of and falls through unchanged.
        // The visual aspect's vectors came from the vision model, so whether
        // the *text* encoder is lexical says nothing about them.
        const lexical = kind === 'visual' ? false : this.encoder.lexical === true;
        // Two different questions, and both have to be asked. Can this aspect
        // tell its own events apart at all — a property of the index — and where
        // does this query's answer sit among the rest, which is per query. The
        // `audio` aspect of a real project answers no to the first: its text is
        // "music speech" for almost every event, so any query separates them by
        // rounding, and the luckiest one came out at 1.000.
        const discrimination = lexical ? undefined : this.vectors.discrimination?.(kind);
        const calibration =
          discrimination?.kind === 'undiscriminating'
            ? discrimination
            : lexical
              ? undefined
              : calibrationOf(raw.map((h) => h.score));
        for (const hit of raw) {
          vectorHits.set(hit.ownerId, strengthOf(hit.score, calibration));
        }
      }
      // Stored vectors that the query could not be compared against: the search
      // still works lexically, and the caller is told why it is weaker. This
      // check sat inside the branch above, so an aspect with no query vector at
      // all — exactly what `visual` has when there is no text tower — was
      // skipped without ever being reported.
      if (vectorHits.size === 0 && this.vectors.owners(kind).length > 0) unsearchable.push(kind);

      for (const eventId of candidates) {
        const event = this.events.get(eventId);
        if (!event) continue;
        const text = aspectText(event, kind, this.ir.context);
        if (text.trim().length === 0) continue;

        const vectorScore = vectorHits.get(eventId) ?? 0;
        const lexicalScore = coverage(query, text);

        // A lexical encoder's vector score is not independent evidence: it is an
        // approximation of the same shared-word signal `coverage` measures
        // exactly. So a vector score with no shared word at all is a hash
        // collision, and collisions are not small — searching the worked example
        // for ラーメン returned 最高だった at 0.29, ranked second of four, with a
        // confidence bar beside it. One real match presented as four is worse
        // than one real match.
        if (this.encoder.lexical && lexicalScore <= 0) continue;

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

    this.lastDiagnostics = {
      unsearchableKinds: unsearchable,
      ...(visualFallback && unsearchable.includes('visual') ? { visualFallback } : {}),
    };

    const minScore = options.minScore ?? 0;
    return [...best.values()]
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score || compareText(a.event_id, b.event_id))
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
