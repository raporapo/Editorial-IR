import { z } from 'zod';
import { Probability, UnitScore, obj } from './primitives.js';
import { AssessmentId, EventId, ModelRunId } from './ids.js';

/**
 * The editorial layer answers a different question from the semantic layer.
 *
 * Semantic: "what happened here?"
 * Editorial: "what is this worth to an edit?"
 *
 * Keeping them apart is what lets one expensive pass of video understanding be
 * reused by a 3-minute travel vlog, a 30-second short and a wedding film.
 */

export const NARRATIVE_ROLES = [
  'setup',
  'context',
  'build_up',
  'transition',
  'payoff',
  'climax',
  'reaction',
  'resolution',
  'ending',
  'filler',
] as const;

export const NarrativeRole = z.enum(NARRATIVE_ROLES).meta({
  id: 'NarrativeRole',
  description: 'The structural job an event does in the finished piece.',
});
export type NarrativeRole = z.infer<typeof NarrativeRole>;

/**
 * Editorial metrics. Every one is a unit score whose meaning is fixed here, so
 * that a Skill rule written against `redundancy` means the same thing no matter
 * which decision backend produced it.
 */
export const EDITORIAL_METRICS = [
  /** How much the piece loses if this event is cut entirely. */
  'story_importance',
  /** Strength of feeling in the moment itself, not its importance. */
  'emotional_intensity',
  /** How well this event serves the user's stated goal and background. */
  'context_relevance',
  /** Technical picture quality: focus, exposure, stability. */
  'visual_quality',
  /** Technical sound quality: intelligibility, noise, clipping. */
  'audio_quality',
  /** How unlike the rest of the material this event is. */
  'uniqueness',
  /** How much of this event is already covered by another event. */
  'redundancy',
  /** How badly a cut *into* this event would jar, given the previous event. */
  'continuity_previous',
  /** How badly a cut *out of* this event would jar, given the next event. */
  'continuity_next',
  /** Density of new information per second, mostly from speech and OCR. */
  'information_density',
] as const;

export const EditorialMetric = z.enum(EDITORIAL_METRICS).meta({ id: 'EditorialMetric' });
export type EditorialMetric = z.infer<typeof EditorialMetric>;

/**
 * Yes/no judgements, stored as probabilities rather than booleans.
 *
 * A boolean throws away exactly the information the planner needs when it has to
 * choose between two nearly equal candidates.
 */
export const EDITORIAL_FLAGS = [
  'preserve',
  'redundant',
  'establishing_shot',
  'b_roll_candidate',
  'opening_candidate',
  'ending_candidate',
  'requires_previous_context',
  'contains_dead_air',
] as const;

export const EditorialFlag = z.enum(EDITORIAL_FLAGS).meta({ id: 'EditorialFlag' });
export type EditorialFlag = z.infer<typeof EditorialFlag>;

export const NarrativeRoleAssessment = obj({
  selected: NarrativeRole,
  /** Full distribution over roles. Sparse: only non-negligible mass is stored. */
  probabilities: z.partialRecord(NarrativeRole, Probability).default({}),
}).meta({ id: 'NarrativeRoleAssessment' });
export type NarrativeRoleAssessment = z.infer<typeof NarrativeRoleAssessment>;

/**
 * One decision backend's complete verdict on one event.
 *
 * `model_run_id` makes it traceable, and it is stored rather than merged so that
 * re-running with a different backend is a comparison rather than a rewrite.
 */
export const EditorialAssessment = obj({
  id: AssessmentId,
  event_id: EventId,
  model_run_id: ModelRunId,
  metrics: z.record(EditorialMetric, UnitScore),
  flags: z.record(EditorialFlag, Probability),
  narrative_role: NarrativeRoleAssessment,
  /** Backend-supplied justification. Never used for control flow; shown to humans. */
  rationale: z.string().optional(),
  /** Overall confidence in this assessment; drives escalation to a stronger backend. */
  confidence: UnitScore,
}).meta({ id: 'EditorialAssessment', title: 'EditorialAssessment' });
export type EditorialAssessment = z.infer<typeof EditorialAssessment>;

/**
 * Above this, an event is treated as depending on the one before it.
 *
 * The planner drops such an event when its predecessor is not in the cut, the
 * reviewer warns about it, and the graph records the dependency as a relation.
 * All three read the same flag and each had written `0.6` down separately — the
 * arrangement where one of them gets tuned and the other two quietly disagree
 * with it.
 */
export const REQUIRES_CONTEXT_THRESHOLD = 0.6;

/** Neutral metric values, used when no backend has run yet. */
export const NEUTRAL_METRICS: Record<EditorialMetric, number> = {
  story_importance: 0.5,
  emotional_intensity: 0.5,
  context_relevance: 0.5,
  visual_quality: 0.5,
  audio_quality: 0.5,
  uniqueness: 0.5,
  redundancy: 0.5,
  continuity_previous: 0.5,
  continuity_next: 0.5,
  information_density: 0.5,
};

export const NEUTRAL_FLAGS: Record<EditorialFlag, number> = {
  preserve: 0.5,
  redundant: 0.5,
  establishing_shot: 0.5,
  b_roll_candidate: 0.5,
  opening_candidate: 0.5,
  ending_candidate: 0.5,
  requires_previous_context: 0.5,
  contains_dead_air: 0.5,
};
