import { z } from 'zod';
import { Milliseconds, UnitScore, obj } from './primitives.js';
import { EDITORIAL_FLAGS, EDITORIAL_METRICS, NarrativeRole } from './editorial.js';
import { Transition } from './plan.js';
import { SKILL_MANIFEST_VERSION } from './version.js';

/**
 * A Skill says what counts as a good edit. It does not look at video.
 *
 * The split matters: the decision layer says "this moment scores 0.91 on
 * emotional intensity", and the Skill says "when emotional intensity is that
 * high, do not cut it shorter than three seconds". Change the model and the
 * style survives; change the style and the expensive analysis survives.
 *
 * Skills are declarative on purpose. A rule file is data — reviewable,
 * diffable, shareable, and unable to reach into the planner and do something
 * surprising.
 */

/* -------------------------------------------------------------------------- */
/* Comparators                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A numeric test written the way an editor would write it.
 *
 * Accepted forms: `">0.7"`, `">=0.7"`, `"<0.2"`, `"<=0.2"`, `"==0.5"`,
 * `"!=0.5"`, `"0.3..0.7"` (inclusive range), a bare number (exact match), or the
 * object form `{ gt: 0.7 }` for machine-generated rules.
 */
export const NumericCondition = z
  .union([
    z.number(),
    z
      .string()
      .regex(
        /^\s*(?:(?:>=|<=|==|!=|>|<)\s*-?\d+(?:\.\d+)?|-?\d+(?:\.\d+)?\s*\.\.\s*-?\d+(?:\.\d+)?)\s*$/,
        'expected a comparator such as ">0.7", "<=0.2" or "0.3..0.7"',
      ),
    obj({
      gt: z.number().optional(),
      gte: z.number().optional(),
      lt: z.number().optional(),
      lte: z.number().optional(),
      eq: z.number().optional(),
      ne: z.number().optional(),
    }),
  ])
  .meta({ id: 'NumericCondition' });
export type NumericCondition = z.infer<typeof NumericCondition>;

const StringMatch = z.union([z.string(), z.array(z.string()).min(1)]);

/** Where an event sits inside its chapter, and inside the project. */
export const PositionalScope = z.enum(['first', 'middle', 'last']).meta({ id: 'PositionalScope' });

const metricConditions = Object.fromEntries(
  EDITORIAL_METRICS.map((m) => [m, NumericCondition.optional()]),
) as Record<(typeof EDITORIAL_METRICS)[number], z.ZodOptional<typeof NumericCondition>>;

const flagConditions = Object.fromEntries(
  EDITORIAL_FLAGS.map((f) => [`${f}_probability`, NumericCondition.optional()]),
) as Record<
  `${(typeof EDITORIAL_FLAGS)[number]}_probability`,
  z.ZodOptional<typeof NumericCondition>
>;

/**
 * Conditions are ANDed. Nesting is available through `all_of` / `any_of` / `not`.
 *
 * Every field name here is part of the Skill contract: if a rule can name it, a
 * decision backend has to be able to produce it.
 */
export const SkillCondition: z.ZodType<SkillConditionShape> = z.lazy(() =>
  obj({
    ...metricConditions,
    ...flagConditions,

    /** Matches the selected narrative role. */
    narrative_role: StringMatch.optional(),
    /** Matches the open-vocabulary event type. */
    event_type: StringMatch.optional(),
    /** Matches a named affect axis, e.g. `{ affect: { excitement: ">0.8" } }`. */
    affect: z.record(z.string(), NumericCondition).optional(),

    duration_ms: NumericCondition.optional(),
    speech_ratio: NumericCondition.optional(),
    silence_ratio: NumericCondition.optional(),
    shot_count: NumericCondition.optional(),
    /** Mean camera motion in [0,1]. */
    motion: NumericCondition.optional(),
    /** Share of the event that was both still and silent, in [0,1]. */
    inactive_ratio: NumericCondition.optional(),
    /**
     * What kind of material the event comes from: `raw`, `edited`, `clip`,
     * `screen_recording`, `audio_only` or `still`. A rule written for camera
     * footage — "no speech, so use it as b-roll without its sound" — is wrong
     * for an edited programme, whose music bed is the point.
     */
    material: StringMatch.optional(),
    /** True when the picture carries burned-in subtitles. */
    has_subtitles: z.boolean().optional(),

    /** True when this event's place differs from the previous event's place. */
    new_location: z.boolean().optional(),
    /** True when someone appears who was not in the previous event. */
    new_person: z.boolean().optional(),
    has_speech: z.boolean().optional(),
    has_music: z.boolean().optional(),
    has_laughter: z.boolean().optional(),
    has_text_on_screen: z.boolean().optional(),

    /** The user marked this essential. */
    is_user_essential: z.boolean().optional(),
    /** The user marked this excluded. */
    is_user_excluded: z.boolean().optional(),

    /** Position within the chapter. */
    chapter_position: PositionalScope.optional(),
    /** Position within the whole project. */
    project_position: PositionalScope.optional(),

    /** Case-insensitive substring match over description, speech and OCR. */
    mentions: StringMatch.optional(),
    /** Matches any of these people by id or alias. */
    involves_person: StringMatch.optional(),
    /** Matches the resolved place. */
    at_place: StringMatch.optional(),

    all_of: z.array(SkillCondition).optional(),
    any_of: z.array(SkillCondition).optional(),
    not: SkillCondition.optional(),
  }).meta({ id: 'SkillCondition' }),
);

export interface SkillConditionShape {
  [key: string]: unknown;
  all_of?: SkillConditionShape[];
  any_of?: SkillConditionShape[];
  not?: SkillConditionShape;
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a matching rule does.
 *
 * Actions never select clips themselves — they adjust the planner's inputs. The
 * planner stays the single place where "which events, for how long, in what
 * order" is decided, so a Skill cannot produce a plan the validator has never
 * seen the shape of.
 */
export const SkillAction = obj({
  /** Additive bias on the selection score. `true` means +0.15. */
  prefer: z.union([z.boolean(), z.number()]).optional(),
  /** Additive penalty. `true` means -0.15. */
  avoid: z.union([z.boolean(), z.number()]).optional(),
  /** Multiplies the selection score. */
  weight_multiplier: z.number().gt(0).optional(),
  /** Never select this event, whatever it scores. */
  drop: z.boolean().optional(),
  /** Select this event even if the budget is tight. Weaker than a user `essential`. */
  require: z.boolean().optional(),

  minimum_duration_sec: z.number().gt(0).optional(),
  maximum_duration_sec: z.number().gt(0).optional(),
  /** Extend the out point past the end of speech to keep the reaction that follows. */
  preserve_reaction: z.boolean().optional(),
  /** Forbid trimming into the middle of this event and raise its floor duration. */
  avoid_aggressive_cutting: z.boolean().optional(),
  /** Among events related by `duplicate_of`, keep only the highest quality one. */
  prefer_higher_quality_only: z.boolean().optional(),

  transition_in: Transition.optional(),
  transition_out: Transition.optional(),
  /** Force the narrative role, overriding the decision layer. */
  role_override: NarrativeRole.optional(),
  /** Bias this event toward a position in the finished piece. */
  place_at: z.enum(['opening', 'ending']).optional(),
  /** Use as picture only; drop its own sound. */
  as_b_roll: z.boolean().optional(),
  /** Use the event's material whole rather than trimming inside it. */
  keep_whole: z.boolean().optional(),
  /** Take the pauses out of this event's speech, as jump cuts. */
  remove_silences: z.boolean().optional(),
  /** Free tags, carried into the plan's rationale. */
  tag: z.array(z.string()).optional(),
}).meta({ id: 'SkillAction' });
export type SkillAction = z.infer<typeof SkillAction>;

export const SkillRule = obj({
  /** Stable id, referenced from a plan's rationale. Generated from the index when omitted. */
  id: z.string().optional(),
  description: z.string().optional(),
  when: SkillCondition,
  action: SkillAction,
  /** Higher priority wins when two rules set the same field. Ties break by file order. */
  priority: z.int().default(0),
}).meta({ id: 'SkillRule' });
export type SkillRule = z.infer<typeof SkillRule>;

/* -------------------------------------------------------------------------- */
/* Scoring, arc and defaults                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How editorial metrics become one number the planner can rank by.
 *
 * This is the most style-defining part of a Skill: a documentary weights
 * `information_density`, a highlight reel weights `emotional_intensity`, and the
 * same footage sorts differently under each without re-running a single model.
 */
export const SkillScoring = obj({
  weights: z.record(z.string(), z.number()).default({}),
  flag_weights: z.record(z.string(), z.number()).default({}),
  /** Extra penalty applied to an event that duplicates one already selected. */
  duplicate_penalty: z.number().min(0).default(0.5),
  /** Bonus for a pair of adjacent selections with high continuity. */
  continuity_bonus: z.number().min(0).default(0.2),
}).meta({ id: 'SkillScoring' });
export type SkillScoring = z.infer<typeof SkillScoring>;

export const ArcSegment = obj({
  name: z.string().min(1),
  /** Share of the target duration, in [0,1]. Shares across segments must sum to 1. */
  budget: UnitScore,
  prefer_roles: z.array(NarrativeRole).default([]),
  /** The segment is considered unfilled unless at least one of these roles appears. */
  require_roles: z.array(NarrativeRole).default([]),
}).meta({ id: 'ArcSegment' });
export type ArcSegment = z.infer<typeof ArcSegment>;

export const SkillArc = obj({
  /**
   * `chronological` keeps capture order, which is what a travel or event film
   * needs. `hook_first` allows one high-hook event to be lifted to the front,
   * which is what a short needs. Nothing else reorders material, because
   * silently rearranging someone's day is the fastest way to lose their trust.
   */
  ordering: z.enum(['chronological', 'hook_first']).default('chronological'),
  segments: z.array(ArcSegment).default([]),
}).meta({ id: 'SkillArc' });
export type SkillArc = z.infer<typeof SkillArc>;

export const SkillDefaults = obj({
  min_clip_duration_ms: Milliseconds.default(1200),
  max_clip_duration_ms: Milliseconds.default(12000),
  /** Handle added before the in point, when the source allows it. */
  pad_in_ms: Milliseconds.default(150),
  /** Handle added after the out point. */
  pad_out_ms: Milliseconds.default(250),
  /** Move cut points to the nearest quiet moment so clips do not start mid-word. */
  snap_to_silence: z.boolean().default(true),
  /** How far a cut point may move while snapping. */
  snap_window_ms: Milliseconds.default(600),
  default_transition: Transition.default({ type: 'hard_cut', duration_ms: 0 }),
  /** Transition used where the place changes between clips. */
  chapter_transition: Transition.optional(),
  /** How long a photograph stays on screen. */
  still_duration_ms: Milliseconds.default(3000),
  /**
   * Whether a pre-trimmed clip is used whole. `auto` keeps a clip whole when the
   * material is a clip the user already chose and it fits the clip limits: they
   * trimmed it on their phone, and trimming it again cuts their first syllable.
   */
  keep_whole: z.enum(['auto', 'always', 'never']).default('auto'),
  /**
   * Whether cut points move onto the source's own cuts. `auto` does it for
   * edited material only: cutting an edited programme a few frames off its own
   * edit leaves a flash of the neighbouring shot. Raw footage has shot
   * boundaries too — camera moves — and snapping to those would move cuts that
   * are right.
   */
  snap_to_cuts: z.enum(['auto', 'always', 'never']).default('auto'),
  /** Take pauses out of long speech as jump cuts. Changes durations, by design. */
  remove_silences: z.boolean().default(false),
  /** Shortest pause that is taken out when removing silences. */
  min_removed_silence_ms: Milliseconds.default(700),
  /** Left on each side of a removed pause, so a word's tail and a breath survive. */
  silence_handle_ms: Milliseconds.default(120),
}).meta({ id: 'SkillDefaults' });
export type SkillDefaults = z.infer<typeof SkillDefaults>;

export const SkillConstraints = obj({
  /** A user `essential` annotation always survives planning. Default true, and turning it off is not recommended. */
  preserve_user_essential_events: z.boolean().default(true),
  /** Cap on identical consecutive roles, to stop six establishing shots in a row. */
  max_consecutive_same_role: z.int().min(1).default(3),
  /** Roles this Skill never selects. */
  forbid_roles: z.array(NarrativeRole).default([]),
  /** Minimum share of the target duration that must carry speech, in [0,1]. */
  min_speech_share: UnitScore.optional(),
  /** Hard ceiling on clip count, for formats where fast cutting is wrong. */
  max_operations: z.int().min(1).optional(),
}).meta({ id: 'SkillConstraints' });
export type SkillConstraints = z.infer<typeof SkillConstraints>;

export const SkillManifest = obj({
  manifest_version: z.string().default(SKILL_MANIFEST_VERSION),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'skill names are lowercase kebab-case'),
  version: z.string().default('0.1.0'),
  description: z.string().default(''),
  license: z.string().optional(),
  author: z.string().optional(),
  /** Names of skills merged in beneath this one, in order. Cycles are rejected at load time. */
  extends: z.array(z.string()).default([]),
  defaults: SkillDefaults.prefault({}),
  scoring: SkillScoring.prefault({}),
  arc: SkillArc.prefault({}),
  constraints: SkillConstraints.prefault({}),
  rules: z.array(SkillRule).default([]),
  intent: obj({
    opening: z.string().optional(),
    middle: z.string().optional(),
    ending: z.string().optional(),
    tone: z.array(z.string()).default([]),
  }).prefault({}),
}).meta({ id: 'SkillManifest', title: 'SkillManifest' });
export type SkillManifest = z.infer<typeof SkillManifest>;

/**
 * The per-event result of evaluating a Skill: everything the planner needs, and
 * nothing that would let a Skill plan by itself.
 */
export const SkillDirective = obj({
  event_id: z.string(),
  /** Base value from `scoring`, before rule biases. */
  base_score: z.number(),
  /** Value after every rule that matched. */
  score: z.number(),
  min_duration_ms: Milliseconds,
  max_duration_ms: Milliseconds,
  dropped: z.boolean().default(false),
  required: z.boolean().default(false),
  locked: z.boolean().default(false),
  as_b_roll: z.boolean().default(false),
  preserve_reaction: z.boolean().default(false),
  prefer_higher_quality_only: z.boolean().default(false),
  keep_whole: z.boolean().default(false),
  remove_silences: z.boolean().default(false),
  place_at: z.enum(['opening', 'ending']).optional(),
  role: NarrativeRole.optional(),
  transition_in: Transition.optional(),
  transition_out: Transition.optional(),
  tags: z.array(z.string()).default([]),
  matched_rule_ids: z.array(z.string()).default([]),
}).meta({ id: 'SkillDirective' });
export type SkillDirective = z.infer<typeof SkillDirective>;
