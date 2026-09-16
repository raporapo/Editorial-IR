import { z } from 'zod';
import { Iso8601, Milliseconds, obj } from './primitives.js';
import { ModelRunId } from './ids.js';

/**
 * Every pipeline stage that can produce a different answer tomorrow than it did
 * today records a ModelRun. This is where model identity lives.
 *
 * Model names never appear in the IR schema itself; IR fields carry a
 * `model_run_id` instead. That keeps models replaceable (an architectural
 * invariant) while still making every value in the IR fully traceable.
 */
export const PipelineStage = z
  .enum([
    'ingest',
    'speech',
    'visual',
    'audio',
    'ocr',
    'shot_detection',
    'segmentation',
    'context',
    'decision',
    'embedding',
    'planning',
    'review',
  ])
  .meta({ id: 'PipelineStage' });
export type PipelineStage = z.infer<typeof PipelineStage>;

/** Where the work physically happened. Used for privacy reporting and costing. */
export const ExecutionLocality = z.enum(['local', 'remote_api', 'unknown']).meta({
  id: 'ExecutionLocality',
});
export type ExecutionLocality = z.infer<typeof ExecutionLocality>;

export const ModelRun = obj({
  id: ModelRunId,
  stage: PipelineStage,
  /** Backend implementation id, e.g. `heuristic`, `python-worker`, `openai-compatible`. */
  backend: z.string().min(1),
  /** Opaque model identifier as reported by the backend. May be absent for rule-based stages. */
  model: z.string().optional(),
  model_version: z.string().optional(),
  locality: ExecutionLocality.default('unknown'),
  /** Parameters that affect the output, and therefore the cache key. */
  parameters: z.record(z.string(), z.unknown()).default({}),
  /** Estimated cost in USD. 0 for local execution. */
  cost_usd: z.number().min(0).default(0),
  input_tokens: z.int().min(0).optional(),
  output_tokens: z.int().min(0).optional(),
  latency_ms: Milliseconds.optional(),
  /** True when raw media or media-derived content left the machine. */
  media_left_device: z.boolean().default(false),
  created_at: Iso8601,
}).meta({ id: 'ModelRun' });
export type ModelRun = z.infer<typeof ModelRun>;
