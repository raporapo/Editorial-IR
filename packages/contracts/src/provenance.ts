import { z } from 'zod';
import { Confidence, obj } from './primitives.js';
import { ConflictId, ModelRunId } from './ids.js';

/**
 * Provenance is an architectural invariant, not a convenience field.
 *
 * "What the machine saw", "what the machine inferred" and "what the user told
 * us" are three different kinds of knowledge with three different failure modes.
 * Collapsing them into one field is the single fastest way to make an editing
 * system untrustworthy: once you cannot tell an inference from an observation,
 * you cannot debug a bad cut, and you cannot honour the rule that user
 * knowledge outranks model output.
 */
export const Provenance = z
  .enum([
    /** Directly measured from the media (ASR text, a detected shot boundary, ffprobe metadata). */
    'observed',
    /** Produced by a model reasoning over observations. */
    'inferred',
    /** Supplied by the user. Never overwritten by a model. */
    'user_provided',
    /** Produced by evaluating a Skill's declarative rules. */
    'skill_derived',
    /** Produced by the editing agent while planning. */
    'agent_derived',
    /** Read back out of an NLE after the plan was applied. */
    'nle_observed',
  ])
  .meta({ id: 'Provenance' });
export type Provenance = z.infer<typeof Provenance>;

/**
 * Authority ranking. Higher wins when two sources describe the same field.
 *
 * `observed` outranks `inferred` because a measurement beats a guess, and
 * `user_provided` outranks everything because the user knows things the media
 * cannot contain ("this is our first anniversary").
 *
 * This ordering is only ever used to *choose what to present*. It never causes a
 * lower-authority value to be deleted: losing values are retained so that a
 * disagreement stays visible (see {@link Conflict}).
 */
export const PROVENANCE_AUTHORITY: Record<Provenance, number> = {
  user_provided: 100,
  observed: 80,
  nle_observed: 75,
  skill_derived: 60,
  agent_derived: 50,
  inferred: 40,
};

export function outranks(a: Provenance, b: Provenance): boolean {
  return PROVENANCE_AUTHORITY[a] > PROVENANCE_AUTHORITY[b];
}

/**
 * Wraps a value with where it came from.
 *
 * `model_run_id` points at a {@link ModelRun} record; the model *name* is never
 * stored inline, because models are replaceable backends and must not leak into
 * the IR schema.
 */
export function provenanced<T extends z.ZodType>(value: T, id?: string) {
  return obj({
    value,
    provenance: Provenance,
    confidence: Confidence.optional(),
    model_run_id: ModelRunId.optional(),
    /** Free-form pointer at the evidence: an utterance id, an annotation id, a file path. */
    source_refs: z.array(z.string()).optional(),
  }).meta(id ? { id } : {});
}

export type Provenanced<T> = {
  value: T;
  provenance: Provenance;
  confidence?: number;
  model_run_id?: string;
  source_refs?: string[];
};

export const ProvenancedString = provenanced(z.string(), 'ProvenancedString');
export const ProvenancedNumber = provenanced(z.number(), 'ProvenancedNumber');

/**
 * A recorded disagreement between two sources of knowledge.
 *
 * When an observation contradicts user-supplied knowledge we do **not** silently
 * pick a winner and move on. The user's value is used, and the contradiction is
 * written down so that a human can see the system noticed.
 */
export const Conflict = obj({
  id: ConflictId,
  /** Dotted path into the IR, e.g. `events.evt_0031.affect`. */
  path: z.string().min(1),
  user_value: z.unknown().optional(),
  observed_value: z.unknown().optional(),
  inferred_value: z.unknown().optional(),
  /** Which provenance the compiler used for the effective value. */
  resolved_with: Provenance,
  note: z.string().optional(),
  detected_at: z.string(),
}).meta({ id: 'Conflict' });
export type Conflict = z.infer<typeof Conflict>;
