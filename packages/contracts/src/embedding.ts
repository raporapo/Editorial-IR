import { z } from 'zod';
import { obj } from './primitives.js';
import { ModelRunId } from './ids.js';

/**
 * One event does not fit in one vector.
 *
 * "the night view shot", "where they say let's come back", "the arrival scene"
 * and "the moments that feel like an anniversary" are four different queries
 * over four different aspects of the same event, so each aspect is indexed
 * separately and searched separately.
 */
export const EMBEDDING_KINDS = ['visual', 'speech', 'event', 'context', 'mood', 'audio'] as const;
export const EmbeddingKind = z.enum(EMBEDDING_KINDS).meta({ id: 'EmbeddingKind' });
export type EmbeddingKind = z.infer<typeof EmbeddingKind>;

/**
 * A stored vector. Vectors live in a sidecar file, never inside the IR document,
 * because a 600-event project with six aspects at 768 dimensions is ~11 MB of
 * numbers that no human ever wants to read in a diff.
 */
export const EmbeddingRecord = obj({
  /** `<owner_id>:<kind>`, e.g. `evt_0031:event`. */
  id: z.string().min(1),
  /** The event, frame or asset this vector describes. */
  owner_id: z.string().min(1),
  kind: EmbeddingKind,
  dim: z.int().min(1),
  vector: z.array(z.number()),
  model_run_id: ModelRunId.optional(),
}).meta({ id: 'EmbeddingRecord' });
export type EmbeddingRecord = z.infer<typeof EmbeddingRecord>;

export const EmbeddingSet = obj({
  project_id: z.string(),
  generated_at: z.string(),
  records: z.array(EmbeddingRecord).default([]),
}).meta({ id: 'EmbeddingSet' });
export type EmbeddingSet = z.infer<typeof EmbeddingSet>;

export function embeddingRefFor(ownerId: string, kind: EmbeddingKind): string {
  return `${ownerId}:${kind}`;
}
