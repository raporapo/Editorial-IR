import {
  PIPELINE_VERSION,
  compareText,
  embeddingRefFor,
  type EmbeddingKind,
  type EmbeddingRecord,
  type ProjectContext,
  type SemanticEvent,
} from '@editorial-ir/contracts';
import { aspectText, populatedAspects } from '@editorial-ir/index';
import type { TextEmbeddingModel } from '@editorial-ir/perception';
import type { ModelRunRecorder } from './model-runs.js';
import type { PerceptionCache } from './cache.js';
import { hashObject } from './fingerprint.js';

/**
 * Building the searchable representation of every event.
 *
 * Each aspect is embedded separately, from the text that aspect is actually
 * about. Where a vision model produced frame vectors, the visual aspect uses
 * those instead of a description of them, because "find the shot with the
 * fairground lights" should be answered by what the frame looked like, not by
 * whether anyone wrote the word fairground.
 */
export interface EmbedOptions {
  /** Frame vectors from this compile, keyed `<asset_id>:<timestamp_ms>`. */
  frameVectors?: Map<string, number[]>;
  /**
   * Where the encoder's identity is written down.
   *
   * The embedding stage was the one model call that recorded nothing: a
   * configured endpoint received every event's transcript, its labels and the
   * user's own background as plain text, and `ir.model_runs` had no entry for
   * it, the records carried no `model_run_id`, and the privacy block said
   * "media left this machine: no". Nothing in the project said a third party
   * had seen any of it.
   */
  runs?: ModelRunRecorder;
  /** The run that produced the frame vectors, for the records made from them. */
  visualRunId?: string;
  /**
   * Caches vectors on the text and the encoder.
   *
   * Every other model stage was cached and this one was not: each compile
   * re-embedded every aspect of every event, so changing the target duration
   * and re-analysing sent the whole project's text to a hosted embedding
   * endpoint again, at full price, for vectors that could not have changed.
   * A lexical encoder is not cached — it is a hash, cheaper to recompute than
   * to look up.
   */
  cache?: PerceptionCache;
  onProgress?: (done: number, total: number) => void;
}

export async function buildEmbeddings(
  events: readonly SemanticEvent[],
  context: ProjectContext,
  encoder: TextEmbeddingModel,
  options: EmbedOptions = {},
): Promise<{ records: EmbeddingRecord[]; kinds: EmbeddingKind[] }> {
  const jobs: { eventId: string; kind: EmbeddingKind; text: string }[] = [];
  const records: EmbeddingRecord[] = [];
  // Recorded even when nothing is sent anywhere: "this ran locally on the
  // hashing encoder" is an answer to the question, and an absent run is not.
  const runId = options.runs?.fromIdentity('embedding', encoder.identity);

  // Either every visual vector in this index came from the pictures, or none of
  // them did. A frame vector and an embedding of the words attached to a frame
  // are points in two unrelated spaces, and one `visual` slot holding some of
  // each is an index whose scores cannot be compared: the events a vision model
  // happened to cover would be ranked against the rest on a number that means
  // something different for each. Nothing downstream can detect it either — the
  // vector index refuses vectors of different widths, which catches this only
  // when the two models disagree about how wide a vector is.
  const seen = options.frameVectors ? options.frameVectors.size > 0 : false;
  const visualRunId = seen ? options.visualRunId : undefined;

  for (const event of events) {
    const visual = seen ? visualVectorFor(event, options.frameVectors!) : undefined;
    if (visual) {
      records.push({
        id: embeddingRefFor(event.id, 'visual'),
        owner_id: event.id,
        kind: 'visual',
        dim: visual.length,
        vector: visual,
        // The vision model's, not the text encoder's: these came from frames.
        ...(visualRunId === undefined ? {} : { model_run_id: visualRunId }),
      });
    }
    for (const kind of populatedAspects(event, context)) {
      // An event a vision model did not reach gets no visual vector rather than
      // a text one standing in for it. Its labels and on-screen text are still
      // searchable as words, through the lexical half of the same aspect.
      if (kind === 'visual' && seen) continue;
      jobs.push({ eventId: event.id, kind, text: aspectText(event, kind, context) });
    }
  }

  // One call for everything: an embedding backend charges and waits per request,
  // not per string, and a per-event loop over six aspects is six hundred
  // requests for a hundred-event project.
  const vectors = await embedCached(
    encoder,
    jobs.map((job) => job.text),
    encoder.lexical ? undefined : options.cache,
  );
  options.onProgress?.(jobs.length, jobs.length);

  for (const [index, job] of jobs.entries()) {
    const vector = vectors[index];
    if (!vector || vector.length === 0) continue;
    records.push({
      id: embeddingRefFor(job.eventId, job.kind),
      owner_id: job.eventId,
      kind: job.kind,
      dim: vector.length,
      vector,
      ...(runId === undefined ? {} : { model_run_id: runId }),
    });
  }

  records.sort((a, b) => compareText(a.owner_id, b.owner_id) || compareText(a.kind, b.kind));
  return { records, kinds: [...new Set(records.map((r) => r.kind))].sort() };
}

/** Vectors for these texts, asking the encoder only about the ones never seen before. */
async function embedCached(
  encoder: TextEmbeddingModel,
  texts: readonly string[],
  cache: PerceptionCache | undefined,
): Promise<(number[] | undefined)[]> {
  if (texts.length === 0) return [];
  if (!cache) return encoder.embed([...texts]);

  const keyFor = (text: string) => ({
    operation: 'embed_text',
    mediaSha256: hashObject({ text }),
    backend: encoder.identity.backend,
    ...(encoder.identity.model === undefined ? {} : { model: encoder.identity.model }),
    ...(encoder.identity.modelVersion === undefined
      ? {}
      : { modelVersion: encoder.identity.modelVersion }),
    parameters: { role: 'passage' },
    pipelineVersion: PIPELINE_VERSION,
  });

  const out: (number[] | undefined)[] = texts.map((text) => cache.get<number[]>(keyFor(text)));
  const missing = [...new Set(texts.filter((_, i) => out[i] === undefined))];
  if (missing.length === 0) return out;

  // Still one request for everything that is new, for the reason above.
  const fresh = await encoder.embed(missing);
  const byText = new Map<string, number[]>();
  for (const [i, text] of missing.entries()) {
    const vector = fresh[i];
    if (!vector || vector.length === 0) continue;
    byText.set(text, vector);
    cache.set(keyFor(text), vector);
  }
  return texts.map((text, i) => out[i] ?? byText.get(text));
}

/** Mean of the frame vectors inside an event, normalised. */
export function visualVectorFor(
  event: SemanticEvent,
  frameVectors: Map<string, number[]>,
): number[] | undefined {
  const assetIds = new Set(event.source_ranges.map((range) => range.asset_id));
  const collected: number[][] = [];

  for (const [key, vector] of frameVectors) {
    const separator = key.lastIndexOf(':');
    const assetId = key.slice(0, separator);
    if (!assetIds.has(assetId)) continue;
    const timestamp = Number(key.slice(separator + 1));
    const range = event.source_ranges.find((r) => r.asset_id === assetId);
    if (!range) continue;
    if (timestamp >= range.source_in_ms && timestamp < range.source_out_ms) collected.push(vector);
  }

  if (collected.length === 0) return undefined;

  const dim = collected[0]!.length;
  const mean = new Array<number>(dim).fill(0);
  for (const vector of collected) {
    for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) + (vector[i] ?? 0);
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) {
    mean[i] = (mean[i] ?? 0) / collected.length;
    norm += (mean[i] ?? 0) ** 2;
  }
  if (norm === 0) return undefined;
  const scale = 1 / Math.sqrt(norm);
  return mean.map((value) => value * scale);
}

/** Attaches the refs an event's embeddings were stored under. */
export function attachEmbeddingRefs(
  events: readonly SemanticEvent[],
  records: readonly EmbeddingRecord[],
): SemanticEvent[] {
  const byEvent = new Map<string, string[]>();
  for (const record of records) {
    const refs = byEvent.get(record.owner_id) ?? [];
    refs.push(record.id);
    byEvent.set(record.owner_id, refs);
  }
  return events.map((event) => ({
    ...event,
    embedding_refs: (byEvent.get(event.id) ?? []).sort(),
  }));
}
