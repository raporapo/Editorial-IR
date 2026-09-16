import {
  embeddingRefFor,
  type EmbeddingKind,
  type EmbeddingRecord,
  type ProjectContext,
  type SemanticEvent,
} from '@editorial-ir/contracts';
import { aspectText, populatedAspects } from '@editorial-ir/index';
import type { TextEmbeddingModel } from '@editorial-ir/perception';

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

  for (const event of events) {
    const visual = options.frameVectors ? visualVectorFor(event, options.frameVectors) : undefined;
    if (visual) {
      records.push({
        id: embeddingRefFor(event.id, 'visual'),
        owner_id: event.id,
        kind: 'visual',
        dim: visual.length,
        vector: visual,
      });
    }
    for (const kind of populatedAspects(event, context)) {
      if (kind === 'visual' && visual) continue;
      jobs.push({ eventId: event.id, kind, text: aspectText(event, kind, context) });
    }
  }

  // One call for everything: an embedding backend charges and waits per request,
  // not per string, and a per-event loop over six aspects is six hundred
  // requests for a hundred-event project.
  const vectors = jobs.length > 0 ? await encoder.embed(jobs.map((job) => job.text)) : [];
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
    });
  }

  records.sort((a, b) => a.owner_id.localeCompare(b.owner_id) || a.kind.localeCompare(b.kind));
  return { records, kinds: [...new Set(records.map((r) => r.kind))].sort() };
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
  return events.map((event) => ({ ...event, embedding_refs: (byEvent.get(event.id) ?? []).sort() }));
}
