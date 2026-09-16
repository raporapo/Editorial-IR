import { z } from 'zod';
import { Iso8601, Milliseconds, UnitScore, obj } from './primitives.js';
import { AssetId, EventId, OperationId, PlanId, ProjectId, ReviewId, RevisionId } from './ids.js';
import { NarrativeRole } from './editorial.js';
import { Provenance } from './provenance.js';
import { EDIT_PLAN_VERSION } from './version.js';

/**
 * EditPlan — "what goes where, for how long".
 *
 * It sits between the IR and any editing application on purpose. The agent
 * writes a plan; adapters translate a plan. Neither ever meets the other, which
 * is why a second NLE costs an adapter instead of a rewrite, and why a plan can
 * be validated and diffed without opening Premiere.
 */

export const TransitionType = z
  .enum(['hard_cut', 'cross_dissolve', 'dip_to_black', 'dip_to_white', 'fade_in', 'fade_out'])
  .meta({ id: 'TransitionType' });
export type TransitionType = z.infer<typeof TransitionType>;

export const Transition = obj({
  type: TransitionType,
  duration_ms: Milliseconds.default(0),
}).meta({ id: 'Transition' });
export type Transition = z.infer<typeof Transition>;

export const OperationConstraints = obj({
  minimum_duration_ms: Milliseconds.optional(),
  maximum_duration_ms: Milliseconds.optional(),
  /** The user pinned this; no later pass may trim, move or drop it. */
  locked: z.boolean().default(false),
}).meta({ id: 'OperationConstraints' });
export type OperationConstraints = z.infer<typeof OperationConstraints>;

/**
 * One clip on the video track.
 *
 * `source_in_ms`/`source_out_ms` are in the *source asset's* own time, never on
 * the capture timeline, because that is the only coordinate every NLE agrees on.
 */
export const VideoOperation = obj({
  operation_id: OperationId,
  source_asset_id: AssetId,
  /** The event this clip came from, so a reviewer can walk back to the reasoning. */
  event_id: EventId.optional(),
  source_in_ms: Milliseconds,
  source_out_ms: Milliseconds,
  timeline_start_ms: Milliseconds,
  /** Which video track, 0-based. Track 0 is the main story track. */
  track: z.int().min(0).default(0),
  role: NarrativeRole.optional(),
  /** Playback rate. 1 is normal; requires adapter capability `speed_change`. */
  speed: z.number().gt(0).default(1),
  transition_in: Transition.optional(),
  transition_out: Transition.optional(),
  constraints: OperationConstraints.optional(),
  /** Whether the clip's own audio is used. B-roll normally sets this to false. */
  use_source_audio: z.boolean().default(true),
  provenance: Provenance.default('agent_derived'),
}).meta({ id: 'VideoOperation', title: 'VideoOperation' });
export type VideoOperation = z.infer<typeof VideoOperation>;

export const TextOperation = obj({
  operation_id: OperationId,
  timeline_start_ms: Milliseconds,
  timeline_end_ms: Milliseconds,
  text: z.string().min(1),
  /** `caption` follows speech; `title` is an authored card; `lower_third` names a person or place. */
  kind: z.enum(['caption', 'title', 'lower_third']).default('caption'),
  /** Normalised position in [0,1] from the top-left of frame. */
  position: obj({ x: z.number(), y: z.number() }).optional(),
  event_id: EventId.optional(),
  provenance: Provenance.default('agent_derived'),
}).meta({ id: 'TextOperation' });
export type TextOperation = z.infer<typeof TextOperation>;

export const AudioTrackSpec = z
  .discriminatedUnion('type', [
    /** Each video clip carries its own sound. */
    obj({
      type: z.literal('source_audio'),
      track: z.int().min(0).default(0),
      gain_db: z.number().default(0),
    }),
    /** An external bed such as music, laid once across the sequence. */
    obj({
      type: z.literal('external'),
      track: z.int().min(0).default(1),
      asset_id: AssetId,
      source_in_ms: Milliseconds.default(0),
      timeline_start_ms: Milliseconds.default(0),
      duration_ms: Milliseconds.optional(),
      gain_db: z.number().default(-18),
      /** Duck the bed under speech. Requires adapter capability `keyframes`. */
      duck_under_speech: z.boolean().default(false),
    }),
  ])
  .meta({ id: 'AudioTrackSpec' });
export type AudioTrackSpec = z.infer<typeof AudioTrackSpec>;

export const SequenceSpec = obj({
  name: z.string().min(1),
  target_duration_ms: Milliseconds,
  tolerance_ms: Milliseconds.default(0),
  width: z.int().min(1).default(1920),
  height: z.int().min(1).default(1080),
  frame_rate: z.number().gt(0).default(30),
  /** Rational frame rate, preserved exactly for NTSC rates such as 30000/1001. */
  frame_rate_num: z.int().min(1).default(30),
  frame_rate_den: z.int().min(1).default(1),
  sample_rate: z.int().min(1).default(48000),
}).meta({ id: 'SequenceSpec' });
export type SequenceSpec = z.infer<typeof SequenceSpec>;

export const PlanIntent = obj({
  opening: z.string().optional(),
  middle: z.string().optional(),
  ending: z.string().optional(),
  tone: z.array(z.string()).default([]),
}).meta({ id: 'PlanIntent' });
export type PlanIntent = z.infer<typeof PlanIntent>;

/**
 * Why an operation is in the plan, or why an event is not.
 *
 * Kept as first-class data rather than logging, because the first thing a user
 * asks about an automatic edit is "why did you cut that", and the answer has to
 * survive into the review loop.
 */
export const PlanRationale = obj({
  event_id: EventId,
  operation_id: OperationId.optional(),
  decision: z.enum(['selected', 'trimmed', 'dropped', 'locked', 'excluded']),
  /** Human-readable reason. */
  reason: z.string(),
  /** The value the planner assigned, for comparing near-misses. */
  score: z.number().optional(),
  /** Which Skill rules fired on this event. */
  skill_rule_ids: z.array(z.string()).default([]),
}).meta({ id: 'PlanRationale' });
export type PlanRationale = z.infer<typeof PlanRationale>;

export const PlanStats = obj({
  operation_count: z.int().min(0),
  total_duration_ms: Milliseconds,
  /** Signed difference from the target; negative means the cut is short. */
  duration_error_ms: z.int(),
  /** Fraction of source material retained, in [0,1]. */
  compression_ratio: UnitScore,
  events_selected: z.int().min(0),
  events_available: z.int().min(0),
  /** Mean `story_importance` of what was kept. */
  mean_importance: UnitScore,
  /** Mean continuity across every cut in the sequence. */
  mean_continuity: UnitScore,
}).meta({ id: 'PlanStats' });
export type PlanStats = z.infer<typeof PlanStats>;

export const EditPlan = obj({
  edit_plan_version: z.string().default(EDIT_PLAN_VERSION),
  id: PlanId,
  project_id: ProjectId,
  created_at: Iso8601,
  /** The IR fingerprint this plan was built from. */
  ir_fingerprint: z.string(),
  skill: obj({ name: z.string(), version: z.string() }),
  sequence: SequenceSpec,
  tracks: obj({
    video: z.array(VideoOperation).default([]),
    audio: z.array(AudioTrackSpec).default([]),
    text: z.array(TextOperation).default([]),
  }),
  intent: PlanIntent.prefault({}),
  rationale: z.array(PlanRationale).default([]),
  stats: PlanStats,
}).meta({ id: 'EditPlan', title: 'EditPlan' });
export type EditPlan = z.infer<typeof EditPlan>;

/* -------------------------------------------------------------------------- */
/* Revisions                                                                   */
/* -------------------------------------------------------------------------- */

export const ReviewObservation = obj({
  id: ReviewId,
  timeline_ms: Milliseconds,
  observation_type: z.enum([
    'abrupt_location_change',
    'missing_context',
    'audio_discontinuity',
    'too_short',
    'too_long',
    'repetition',
    'black_frame',
    'other',
  ]),
  message: z.string(),
  operation_id: OperationId.optional(),
  confidence: UnitScore,
}).meta({ id: 'ReviewObservation' });
export type ReviewObservation = z.infer<typeof ReviewObservation>;

export const PlanRevision = obj({
  id: RevisionId,
  plan_id: PlanId,
  revision_number: z.int().min(1),
  reason: z.string(),
  observations: z.array(ReviewObservation).default([]),
  created_at: Iso8601,
}).meta({ id: 'PlanRevision' });
export type PlanRevision = z.infer<typeof PlanRevision>;

/* -------------------------------------------------------------------------- */
/* Derived values                                                              */
/* -------------------------------------------------------------------------- */

/** Duration a clip occupies on the timeline, accounting for `speed`. */
export function operationTimelineDuration(op: VideoOperation): number {
  return Math.round((op.source_out_ms - op.source_in_ms) / op.speed);
}

export function operationTimelineEnd(op: VideoOperation): number {
  return op.timeline_start_ms + operationTimelineDuration(op);
}

/** End of the whole sequence: the furthest timeline point any operation reaches. */
export function planDurationMs(plan: EditPlan): number {
  let end = 0;
  for (const op of plan.tracks.video) end = Math.max(end, operationTimelineEnd(op));
  for (const t of plan.tracks.text) end = Math.max(end, t.timeline_end_ms);
  return end;
}

export function operationsInOrder(plan: EditPlan): VideoOperation[] {
  return [...plan.tracks.video].sort(
    (a, b) => a.track - b.track || a.timeline_start_ms - b.timeline_start_ms,
  );
}
