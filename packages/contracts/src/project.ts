import { z } from 'zod';
import { Iso8601, Milliseconds, UnitScore, obj } from './primitives.js';
import { AnnotationId, AssetId, EventId, ProjectId } from './ids.js';
import { NarrativeRole } from './editorial.js';

export const ProjectStatus = z
  .enum(['created', 'ingested', 'analyzed', 'planned', 'applied'])
  .meta({ id: 'ProjectStatus' });
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Project = obj({
  id: ProjectId,
  title: z.string().min(1),
  /** Free-form project kind, e.g. `travel_vlog`. Matched against skill hints only as a suggestion. */
  type: z.string().optional(),
  status: ProjectStatus.default('created'),
  ir_version: z.string(),
  /**
   * How this project was last analysed, e.g. `python` or `fixture:./recorded.json`.
   *
   * Recorded so that re-analysing uses the same perception it used before.
   * Silently falling back to a different backend produces a completely different
   * representation of the same footage, and the user's only clue is that their
   * project suddenly has three events instead of seventy-three.
   */
  perception: z.string().optional(),
  created_at: Iso8601,
  updated_at: Iso8601,
}).meta({ id: 'Project' });
export type Project = z.infer<typeof Project>;

/* -------------------------------------------------------------------------- */
/* Background: knowledge only the user has                                     */
/* -------------------------------------------------------------------------- */

export const Person = obj({
  id: z.string().min(1),
  /** How this person relates to the video, e.g. "自分", "彼女", "guest". */
  role: z.string().optional(),
  display_name: z.string().optional(),
  /** Alternative names, used to link transcript mentions to this person. */
  aliases: z.array(z.string()).default([]),
  notes: z.string().optional(),
}).meta({ id: 'Person' });
export type Person = z.infer<typeof Person>;

export const Place = obj({
  id: z.string().min(1),
  display_name: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  notes: z.string().optional(),
}).meta({ id: 'Place' });
export type Place = z.infer<typeof Place>;

export const ProjectBackground = obj({
  /** The occasion, e.g. "交際1周年旅行". The single most valuable field a user can fill in. */
  occasion: z.string().optional(),
  summary: z.string().optional(),
  people: z.array(Person).default([]),
  places: z.array(Place).default([]),
  /** Domain words the transcriber and the context model should expect. */
  vocabulary: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
}).meta({ id: 'ProjectBackground' });
export type ProjectBackground = z.infer<typeof ProjectBackground>;

export const EditingGoal = obj({
  target_duration_ms: Milliseconds.optional(),
  /** Acceptable deviation from the target. Defaults to 10% of the target when omitted. */
  tolerance_ms: Milliseconds.optional(),
  /** Overall tone words, e.g. `["fun", "warm"]`. */
  tone: z.array(z.string()).default([]),
  opening: z.array(z.string()).default([]),
  middle: z.array(z.string()).default([]),
  ending: z.array(z.string()).default([]),
  audience: z.string().optional(),
  /** BCP-47 tag used for ASR and for generated text. */
  language: z.string().optional(),
  /** Free-form instruction from the user, kept verbatim. */
  instruction: z.string().optional(),
}).meta({ id: 'EditingGoal' });
export type EditingGoal = z.infer<typeof EditingGoal>;

export const ProjectConstraints = obj({
  /** Things the edit must not do, in the user's words. Surfaced to the agent verbatim. */
  forbidden: z.array(z.string()).default([]),
  min_clip_duration_ms: Milliseconds.optional(),
  max_clip_duration_ms: Milliseconds.optional(),
  /** Assets that must appear at least once. */
  required_assets: z.array(AssetId).default([]),
  /** Assets that must never appear. */
  excluded_assets: z.array(AssetId).default([]),
  allow_speed_change: z.boolean().default(false),
  allowed_music: z.array(z.string()).default([]),
  forbidden_music: z.array(z.string()).default([]),
}).meta({ id: 'ProjectConstraints' });
export type ProjectConstraints = z.infer<typeof ProjectConstraints>;

/**
 * Everything the user knows that the media cannot contain.
 *
 * The whole document is `user_provided` by definition; no model may write to it.
 * A model may *propose* additions, but those arrive as inferred values elsewhere
 * in the IR and never here.
 */
export const ProjectContext = obj({
  project_id: ProjectId,
  background: ProjectBackground.prefault({}),
  editing_goal: EditingGoal.prefault({}),
  constraints: ProjectConstraints.prefault({}),
  updated_at: Iso8601,
}).meta({ id: 'ProjectContext', title: 'ProjectContext' });
export type ProjectContext = z.infer<typeof ProjectContext>;

/* -------------------------------------------------------------------------- */
/* Annotations: targeted user overrides                                        */
/* -------------------------------------------------------------------------- */

/** What an annotation is attached to. */
export const AnnotationTarget = z
  .discriminatedUnion('kind', [
    obj({
      kind: z.literal('time_range'),
      start_ms: Milliseconds,
      end_ms: Milliseconds,
      asset_id: AssetId.optional(),
    }),
    obj({ kind: z.literal('event'), event_id: EventId }),
    obj({ kind: z.literal('event_pair'), event_a: EventId, event_b: EventId }),
    obj({ kind: z.literal('asset'), asset_id: AssetId }),
    obj({ kind: z.literal('project') }),
  ])
  .meta({ id: 'AnnotationTarget' });
export type AnnotationTarget = z.infer<typeof AnnotationTarget>;

/**
 * The footage a target named, as it was when the annotation was made.
 *
 * An event id is a handle the compiler regenerates: `evt_0008` is the eighth
 * event of the last analysis and nothing more. Splitting or merging anything
 * earlier renumbers everything after it, so a correction stored against an id
 * silently moved to different material — on the worked example, one `merge`
 * moved an `essential` and a title onto a wordless platform shot and a
 * "this is the ending" onto a different moment, with nothing said about it.
 *
 * What the user pointed at is the material, so that is what is stored. The id
 * stays for display. One range per event the target names, so a pair has two.
 */
export const AnnotationAnchor = obj({
  asset_id: AssetId,
  start_ms: Milliseconds,
  end_ms: Milliseconds,
}).meta({ id: 'AnnotationAnchor' });
export type AnnotationAnchor = z.infer<typeof AnnotationAnchor>;

const annotationBase = {
  id: AnnotationId,
  target: AnnotationTarget,
  /**
   * The material the target named, in the asset's own time.
   *
   * Empty for a target that names material directly — a time range, an asset,
   * the project — because there is nothing to drift.
   */
  anchor: z.array(AnnotationAnchor).default([]),
  /** Higher priority wins when two annotations contradict each other. */
  priority: z.int().default(0),
  note: z.string().optional(),
  created_at: Iso8601,
};

/**
 * A user override.
 *
 * Overrides are stored alongside model output rather than applied destructively:
 * the IR keeps `ai_result + user_override`, so turning an override off restores
 * the model's opinion instead of losing it.
 */
export const UserAnnotation = z
  .discriminatedUnion('type', [
    /** "This must appear in the edit." */
    obj({ ...annotationBase, type: z.literal('essential') }),
    /** "This must never appear in the edit." */
    obj({ ...annotationBase, type: z.literal('exclude') }),
    /** Overrides `story_importance`. */
    obj({ ...annotationBase, type: z.literal('importance'), value: UnitScore }),
    /** Overrides the continuity strength between two events. */
    obj({ ...annotationBase, type: z.literal('continuity'), strength: UnitScore }),
    /** Renames an event or a chapter. */
    obj({ ...annotationBase, type: z.literal('rename'), title: z.string().min(1) }),
    /** Adds visual/topic labels the perception layer missed. */
    obj({ ...annotationBase, type: z.literal('label'), labels: z.array(z.string()).min(1) }),
    /** States who appears, using ids from `background.people`. */
    obj({ ...annotationBase, type: z.literal('person'), people: z.array(z.string()).min(1) }),
    /** Corrects the affect vector, e.g. "this is not a sad scene". */
    obj({ ...annotationBase, type: z.literal('mood'), mood: z.record(z.string(), UnitScore) }),
    /** Forces the narrative role. */
    obj({ ...annotationBase, type: z.literal('narrative_role'), role: NarrativeRole }),
    /** Splits or merges the segmentation the compiler produced. */
    obj({
      ...annotationBase,
      type: z.literal('boundary'),
      action: z.enum(['split', 'merge_with_next']),
      at_ms: Milliseconds.optional(),
    }),
    /** Free text attached to a range or event; fed to the context model as user knowledge. */
    obj({ ...annotationBase, type: z.literal('note'), text: z.string().min(1) }),
  ])
  .meta({ id: 'UserAnnotation', title: 'UserAnnotation' });
export type UserAnnotation = z.infer<typeof UserAnnotation>;
export type AnnotationType = UserAnnotation['type'];
