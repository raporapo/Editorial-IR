import { z } from 'zod';
import { Iso8601, Milliseconds, UnitScore, obj } from './primitives.js';
import { AssetId, EventId, OperationId, PlanId, ProjectId, ReviewId, RevisionId } from './ids.js';
import { ModelRun } from './model-run.js';
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
 * One clip of the edit, whatever its media.
 *
 * `source_in_ms`/`source_out_ms` are in the *source asset's* own time, never on
 * the capture timeline, because that is the only coordinate every NLE agrees on.
 *
 * Named for the common case and not limited to it. The asset decides what an
 * adapter writes: a video asset is picture and (with `use_source_audio`) its
 * sound; a still is its picture held for `source_out_ms - source_in_ms`, and any
 * range is valid because a photograph is the same at every instant; an
 * audio-only asset is sound with no picture. One kind of operation keeps one
 * timeline to validate, review and allocate, rather than three that have to be
 * kept consistent with each other.
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
  /**
   * Which of the source's audio streams is its sound, by audio-relative index
   * (`-map 0:a:N`), when it has more than one.
   *
   * A camera with a lavalier on its second track records room tone on the
   * first. The analysis chose the stream with the speech in it; an export that
   * then linked stream 0 would put the room tone under the cut the transcript
   * was used to make. Absent means the first, as before.
   */
  audio_stream_index: z.int().min(0).optional(),
  /**
   * True when this clip continues the previous one's take, with only a pause
   * taken out between them: a jump cut.
   *
   * Said explicitly because everything that looks at neighbouring clips
   * otherwise reads two pieces of one sentence as two moments — the reviewer
   * would call each too short and ask what context the second is missing, and
   * an adapter might put a dissolve between them. A jump cut is always a hard
   * cut. Absent means false.
   */
  continues_previous: z.boolean().optional(),
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

/**
 * A named point on the finished timeline: a chapter, or a note for the editor.
 *
 * Chapters exist in the IR in capture time; this is the same chapter where it
 * begins in the cut, which is the only place a viewer or an editor can use it —
 * a marker in the NLE, a line in a video description.
 */
export const PlanMarker = obj({
  timeline_ms: Milliseconds,
  name: z.string().min(1),
  kind: z.enum(['chapter', 'note']).default('chapter'),
  /** The event whose clip the marker sits on. */
  event_id: EventId.optional(),
}).meta({ id: 'PlanMarker' });
export type PlanMarker = z.infer<typeof PlanMarker>;

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
  /**
   * Free tags the Skill's rules attached.
   *
   * Documented as "carried into the plan's rationale" since the format was
   * written, and there was nowhere for them to be carried to: the rule runtime
   * collected them and the planner read a directive that had no reader for the
   * field. A tag is how an author marks a group of clips in their own
   * vocabulary — `sponsor`, `needs-music`, `b-roll-only` — and finds them again
   * in the plan.
   */
  tags: z.array(z.string()).default([]),
}).meta({ id: 'PlanRationale' });
export type PlanRationale = z.infer<typeof PlanRationale>;

export const PlanStats = obj({
  operation_count: z.int().min(0),
  total_duration_ms: Milliseconds,
  /** Signed difference from the target; negative means the cut is short. */
  duration_error_ms: z.int(),
  /** Fraction of source material retained, in [0,1]. */
  compression_ratio: UnitScore,
  /**
   * Distinct events in the cut. Not the clip count: a take with its pauses
   * taken out is several clips (`continues_previous`) and one event.
   */
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
  /** Chapters and notes on the finished timeline, in timeline order. */
  markers: z.array(PlanMarker).default([]),
  intent: PlanIntent.prefault({}),
  rationale: z.array(PlanRationale).default([]),
  /**
   * Models that were asked anything while making this plan.
   *
   * Empty for the deterministic planner, which asks nobody. `oea agent` sends
   * the project's background — the occasion, the people, the places, the
   * instruction in the user's own words — and the transcript of every event it
   * inspects, and it recorded none of that anywhere: the run wrote a plan and
   * nothing else, so no artifact in the project said a hosted model had seen
   * any of it. The runs belong here rather than in the IR because the IR is
   * rebuilt by the next `oea analyze` and this plan is not.
   */
  model_runs: z.array(ModelRun).default([]),
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
