import {
  type EditorialIR,
  type SkillAction,
  type SkillDirective,
  type SkillManifest,
  type SkillRule,
} from '@editorial-ir/contracts';
import { evaluateCondition } from './condition.js';
import { deriveFacts, type EventFacts } from './facts.js';

/**
 * Turns a Skill and an Editorial IR into one directive per event.
 *
 * A directive is not a plan. It says how much this event is worth under this
 * Skill, how short it may be cut, whether it may be dropped at all — and then
 * the planner decides what actually goes in. Keeping selection in one place is
 * what stops a Skill from producing a shape the validator has never seen.
 */
export interface SkillRuntimeOptions {
  /** Called for every rule that fired, for explaining a plan afterwards. */
  onRuleFired?: (eventId: string, ruleId: string) => void;
}

/** What a `prefer: true` or `avoid: true` is worth when no number is given. */
export const DEFAULT_BIAS = 0.15;

export class SkillRuntime {
  private readonly rules: (SkillRule & { id: string })[];

  constructor(
    readonly skill: SkillManifest,
    private readonly options: SkillRuntimeOptions = {},
  ) {
    this.rules = skill.rules
      .map((rule, index) => ({ ...rule, id: rule.id ?? `${skill.name}#${index}`, __index: index }))
      // Lowest priority first, so the highest-priority rule is applied last and
      // therefore wins any field both of them set.
      .sort((a, b) => a.priority - b.priority || a.__index - b.__index);
  }

  /** Directives for every event in the IR, keyed by event id. */
  evaluate(ir: EditorialIR): Map<string, SkillDirective> {
    const facts = deriveFacts(ir);
    const directives = new Map<string, SkillDirective>();
    for (const [eventId, eventFacts] of facts) {
      directives.set(eventId, this.evaluateEvent(eventFacts));
    }
    return directives;
  }

  evaluateEvent(facts: EventFacts): SkillDirective {
    const base = this.baseScore(facts);

    const directive: SkillDirective = {
      event_id: facts.event_id,
      base_score: round(base),
      score: round(base),
      min_duration_ms: this.skill.defaults.min_clip_duration_ms,
      max_duration_ms: this.skill.defaults.max_clip_duration_ms,
      dropped: false,
      required: false,
      locked: false,
      as_b_roll: false,
      preserve_reaction: false,
      prefer_higher_quality_only: false,
      keep_whole: false,
      remove_silences: false,
      tags: [],
      matched_rule_ids: [],
    };

    let bias = 0;
    let multiplier = 1;
    let avoidAggressiveCutting = false;
    // What the rules said about the two per-skill policies, if anything. A rule
    // that says `true` sticks like the other flags; one that says `false` turns
    // the skill's default off for the events it matches — "never tighten the
    // vows" in a skill that takes pauses out of everything else.
    let keepWholeSaid: boolean | undefined;
    let removeSilencesSaid: boolean | undefined;

    for (const rule of this.rules) {
      if (!evaluateCondition(rule.when, facts)) continue;

      directive.matched_rule_ids.push(rule.id);
      this.options.onRuleFired?.(facts.event_id, rule.id);

      const action: SkillAction = rule.action;
      if (action.prefer !== undefined) {
        bias += action.prefer === true ? DEFAULT_BIAS : action.prefer === false ? 0 : action.prefer;
      }
      if (action.avoid !== undefined) {
        bias -= action.avoid === true ? DEFAULT_BIAS : action.avoid === false ? 0 : action.avoid;
      }
      if (action.weight_multiplier !== undefined) multiplier *= action.weight_multiplier;

      // Sticky, because a rule that says "never use this" should not be undone
      // by a later rule that merely says something about duration.
      if (action.drop) directive.dropped = true;
      if (action.require) directive.required = true;
      if (action.as_b_roll) directive.as_b_roll = true;
      if (action.preserve_reaction) directive.preserve_reaction = true;
      if (action.prefer_higher_quality_only) directive.prefer_higher_quality_only = true;
      if (action.keep_whole !== undefined) {
        keepWholeSaid = keepWholeSaid === true || action.keep_whole;
      }
      if (action.remove_silences !== undefined) {
        removeSilencesSaid = removeSilencesSaid === true || action.remove_silences;
      }
      if (action.avoid_aggressive_cutting) avoidAggressiveCutting = true;

      // Last matching rule wins for a single-valued field, and rules are ordered
      // by priority, so the highest-priority rule that mentions a field sets it.
      if (action.minimum_duration_sec !== undefined) {
        directive.min_duration_ms = Math.round(action.minimum_duration_sec * 1000);
      }
      if (action.maximum_duration_sec !== undefined) {
        directive.max_duration_ms = Math.round(action.maximum_duration_sec * 1000);
      }
      if (action.transition_in) directive.transition_in = action.transition_in;
      if (action.transition_out) directive.transition_out = action.transition_out;
      if (action.role_override) directive.role = action.role_override;
      if (action.place_at) directive.place_at = action.place_at;
      if (action.tag) directive.tags.push(...action.tag);
    }

    directive.role ??= facts.narrative_role;
    directive.score = round(base * multiplier + bias);

    // The user's word outranks every rule in the file, including a rule that
    // would drop this event.
    if (facts.is_user_essential && this.skill.constraints.preserve_user_essential_events) {
      directive.required = true;
      directive.locked = true;
      directive.dropped = false;
    }
    if (facts.is_user_excluded) {
      directive.dropped = true;
      directive.required = false;
    }

    if (avoidAggressiveCutting) {
      // "Do not cut into this" means the floor is the whole event, not merely a
      // longer minimum.
      directive.min_duration_ms = Math.max(
        directive.min_duration_ms,
        Math.min(facts.duration_ms, directive.max_duration_ms),
      );
    }

    // A floor above the ceiling is a contradiction the planner cannot act on;
    // the floor is the protective one, so the ceiling moves.
    if (directive.min_duration_ms > directive.max_duration_ms) {
      directive.max_duration_ms = directive.min_duration_ms;
    }

    // The two policies a skill states once rather than per rule, resolved here so
    // the directive says what happens to this event and the planner reads only
    // directives. Both were accepted by the schema and read by nothing: a skill
    // author who wrote `remove_silences: true` got neither an error nor a pause
    // taken out.
    //
    // `keep_whole: auto` is for a clip the user already chose and trimmed, and
    // only when it fits the skill's clip limit: a style whose clips never run
    // past three and a half seconds trims an eight-second clip rather than being
    // overruled by it. The limit, not a rule's narrower ceiling for this kind of
    // moment — measured on the probe's folder of phone clips under travel-vlog,
    // the rules' four-second caps on wordless and dead-air moments still cut two
    // of eight clips short, one of them mid-sentence. The user trimmed the clip;
    // that is the stronger statement about how long this moment is. Trimming
    // them at all had cut the first syllable off two (0.5-4.5 s of a clip whose
    // speech began at 0.4 s).
    const wholeByDefault =
      this.skill.defaults.keep_whole === 'always' ||
      (this.skill.defaults.keep_whole === 'auto' &&
        facts.material === 'clip' &&
        facts.duration_ms <= this.skill.defaults.max_clip_duration_ms);
    directive.keep_whole = keepWholeSaid ?? wholeByDefault;
    directive.remove_silences = removeSilencesSaid ?? this.skill.defaults.remove_silences;

    if (this.skill.constraints.forbid_roles.includes(directive.role)) directive.dropped = true;

    return directive;
  }

  /**
   * Converts editorial metrics into the one number the planner ranks by.
   *
   * This is where a Skill's taste actually lives: a documentary weights
   * information density, a highlight reel weights feeling, and the same footage
   * sorts differently under each without re-running a single model.
   *
   * Normalised by the positive weights so that a `prefer: 0.15` bias means the
   * same thing whatever scale a Skill author chose for their weights.
   */
  baseScore(facts: EventFacts): number {
    const { weights, flag_weights } = this.skill.scoring;
    let total = 0;
    let positiveMass = 0;

    for (const [metric, weight] of Object.entries(weights)) {
      const value = facts.metrics[metric as keyof typeof facts.metrics];
      if (value === undefined) continue;
      total += weight * value;
      if (weight > 0) positiveMass += weight;
    }
    for (const [flag, weight] of Object.entries(flag_weights)) {
      const value = facts.flags[flag as keyof typeof facts.flags];
      if (value === undefined) continue;
      total += weight * value;
      if (weight > 0) positiveMass += weight;
    }

    if (positiveMass <= 0) return 0.5;
    return total / positiveMass;
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
