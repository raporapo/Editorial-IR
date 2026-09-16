import {
  EDIT_PLAN_VERSION,
  EditorialError,
  assessmentFor,
  eventsInOrder,
  newId,
  seqId,
  type EditPlan,
  type EditorialAssessment,
  type EditorialIR,
  type ObservationTimeline,
  type PlanRationale,
  type SemanticEvent,
  type SequenceSpec,
  type SkillDirective,
  type SkillManifest,
  type Transition,
  type VideoOperation,
} from '@editorial-ir/contracts';
import { SkillRuntime } from '@editorial-ir/skills';
import { chooseTrim } from './trim.js';

/**
 * Turning an Editorial IR and a Skill into an EditPlan.
 *
 * This is deliberately a deterministic optimiser rather than a language model.
 * Not because a model could not do it — because "three minutes" is a hard
 * constraint, "the user marked this essential" is a hard constraint, and a
 * planner that satisfies them by construction is worth more than one that
 * usually does and occasionally does not. It is also free, instant, and produces
 * the same cut twice, which is what makes a change to a Skill measurable.
 *
 * A model-driven agent sits above this rather than replacing it: it can search,
 * reason and adjust, and whatever it produces goes through the same validator.
 */
export interface PlanOptions {
  ir: EditorialIR;
  skill: SkillManifest;
  /** Overrides the target in the project's editing goal. */
  targetDurationMs?: number;
  toleranceMs?: number;
  sequence?: Partial<SequenceSpec>;
  /** Used to snap cut points to silence. */
  observations?: ObservationTimeline;
  now?: () => string;
}

interface Candidate {
  event: SemanticEvent;
  assessment: EditorialAssessment;
  directive: SkillDirective;
  value: number;
  minMs: number;
  maxMs: number;
  /** What this clip should get if the budget allows, rather than its floor. */
  preferredMs: number;
  required: boolean;
  segment: number;
  index: number;
}

export function planEdit(options: PlanOptions): EditPlan {
  const { ir, skill } = options;
  const now = options.now ?? (() => new Date().toISOString());

  const targetDurationMs =
    options.targetDurationMs ?? ir.context.editing_goal.target_duration_ms ?? defaultTarget(ir);
  const toleranceMs =
    options.toleranceMs ??
    ir.context.editing_goal.tolerance_ms ??
    Math.round(targetDurationMs * 0.1);

  if (targetDurationMs <= 0) {
    throw new EditorialError('invalid_input', 'a target duration is required to plan an edit');
  }

  const runtime = new SkillRuntime(skill);
  const directives = runtime.evaluate(ir);
  const ordered = eventsInOrder(ir);
  const rationale: PlanRationale[] = [];

  // ---- candidates ----------------------------------------------------------
  const candidates: Candidate[] = [];
  for (const [index, event] of ordered.entries()) {
    const directive = directives.get(event.id);
    const assessment = assessmentFor(ir, event.id);
    if (!directive || !assessment) continue;

    if (event.knowledge.excluded) {
      rationale.push({
        event_id: event.id,
        decision: 'excluded',
        reason: 'the user excluded this',
        skill_rule_ids: directive.matched_rule_ids,
      });
      continue;
    }
    if (directive.dropped) {
      rationale.push({
        event_id: event.id,
        decision: 'dropped',
        reason: `dropped by ${describeRules(directive)}`,
        score: directive.score,
        skill_rule_ids: directive.matched_rule_ids,
      });
      continue;
    }

    const available = event.end_ms - event.start_ms;
    const minMs = Math.min(directive.min_duration_ms, available);
    const maxMs = Math.max(minMs, Math.min(directive.max_duration_ms, available));
    candidates.push({
      event,
      assessment,
      directive,
      value: directive.score,
      minMs,
      maxMs,
      // Filled in once every candidate is known: how long a clip should be is a
      // question about how it compares to the others, not about its raw score.
      preferredMs: minMs,
      required: directive.required,
      segment: 0,
      index,
    });
  }

  if (candidates.length === 0) {
    throw new EditorialError(
      'plan_invalid',
      'every event was dropped or excluded; there is nothing to cut',
    );
  }

  assignPreferredDurations(candidates);
  assignArcSegments(candidates, skill);
  suppressDuplicates(candidates, ir, rationale);

  // ---- selection -----------------------------------------------------------
  const selected = select(candidates, {
    targetDurationMs,
    skill,
    rationale,
  });

  enforceContextDependencies(selected, candidates, ir, rationale);
  allocateDurations(selected, targetDurationMs);

  // ---- ordering ------------------------------------------------------------
  const sequenceOrder = orderForSequence(selected, skill);

  // ---- operations ----------------------------------------------------------
  const sequence = buildSequenceSpec(ir, targetDurationMs, toleranceMs, options.sequence);
  const operations: VideoOperation[] = [];
  let timeline = 0;

  for (const [position, candidate] of sequenceOrder.entries()) {
    const range = candidate.event.source_ranges[0];
    if (!range) continue;

    const assetSpeech = candidate.event.observed.speech.map((s) => ({
      start_ms: s.start_ms,
      end_ms: s.end_ms,
    }));
    const silences = silencesFor(options.observations, range.asset_id);

    const trim = chooseTrim({
      range: { start_ms: range.source_in_ms, end_ms: range.source_out_ms },
      speech: assetSpeech,
      silences,
      desiredMs: candidate.allocatedMs ?? candidate.minMs,
      minMs: candidate.minMs,
      maxMs: candidate.maxMs,
      padInMs: skill.defaults.pad_in_ms,
      padOutMs: skill.defaults.pad_out_ms,
      snapToSilence: skill.defaults.snap_to_silence,
      snapWindowMs: skill.defaults.snap_window_ms,
      preserveReaction: candidate.directive.preserve_reaction,
    });

    const previous = sequenceOrder[position - 1];
    const transition = transitionFor(candidate, previous, skill);

    const operation: VideoOperation = {
      operation_id: seqId('op', position + 1),
      source_asset_id: range.asset_id,
      event_id: candidate.event.id,
      source_in_ms: trim.in_ms,
      source_out_ms: trim.out_ms,
      timeline_start_ms: timeline,
      track: 0,
      ...(candidate.directive.role ? { role: candidate.directive.role } : {}),
      speed: 1,
      ...(transition ? { transition_in: transition } : {}),
      ...(candidate.directive.locked ? { constraints: { locked: true } } : {}),
      use_source_audio: !candidate.directive.as_b_roll,
      provenance: candidate.directive.locked ? 'user_provided' : 'agent_derived',
    };

    operations.push(operation);
    timeline += trim.out_ms - trim.in_ms;

    rationale.push({
      event_id: candidate.event.id,
      operation_id: operation.operation_id,
      decision: candidate.directive.locked
        ? 'locked'
        : trim.reason === 'whole_event'
          ? 'selected'
          : 'trimmed',
      reason: selectionReason(candidate, trim.reason),
      score: candidate.value,
      skill_rule_ids: candidate.directive.matched_rule_ids,
    });
  }

  const totalDuration = timeline;
  const availableMs = ordered.reduce((sum, e) => sum + (e.end_ms - e.start_ms), 0) || 1;

  return {
    edit_plan_version: EDIT_PLAN_VERSION,
    id: newId('plan'),
    project_id: ir.project.id,
    created_at: now(),
    ir_fingerprint: ir.fingerprint,
    skill: { name: skill.name, version: skill.version },
    sequence,
    tracks: {
      video: operations,
      audio: [{ type: 'source_audio', track: 0, gain_db: 0 }],
      text: [],
    },
    intent: {
      ...(skill.intent.opening ? { opening: skill.intent.opening } : {}),
      ...(skill.intent.middle ? { middle: skill.intent.middle } : {}),
      ...(skill.intent.ending ? { ending: skill.intent.ending } : {}),
      tone:
        ir.context.editing_goal.tone.length > 0 ? ir.context.editing_goal.tone : skill.intent.tone,
    },
    rationale,
    stats: {
      operation_count: operations.length,
      total_duration_ms: totalDuration,
      duration_error_ms: totalDuration - targetDurationMs,
      compression_ratio: Math.min(1, totalDuration / availableMs),
      events_selected: operations.length,
      events_available: candidates.length,
      mean_importance: mean(sequenceOrder.map((c) => c.assessment.metrics.story_importance)),
      mean_continuity: meanContinuity(sequenceOrder, ir),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

interface Selected extends Candidate {
  allocatedMs?: number;
}

/**
 * Chooses what goes in, one arc segment at a time.
 *
 * Within a segment the order is by value per second rather than by value: a
 * three-second moment worth 0.8 beats a thirty-second one worth 0.9, because the
 * budget is time. Required events are taken first regardless — a user's
 * "keep this" is not something to weigh against a score.
 */
function select(
  candidates: readonly Candidate[],
  options: { targetDurationMs: number; skill: SkillManifest; rationale: PlanRationale[] },
): Selected[] {
  const { skill, targetDurationMs } = options;
  const segments =
    skill.arc.segments.length > 0
      ? skill.arc.segments
      : [{ name: 'all', budget: 1, prefer_roles: [], require_roles: [] }];
  const maxOperations = skill.constraints.max_operations ?? Infinity;

  const chosen: Selected[] = [];
  let used = 0;

  for (const [segmentIndex, segment] of segments.entries()) {
    const budget = targetDurationMs * segment.budget;
    const pool = candidates.filter((c) => c.segment === segmentIndex);

    // Share the clip cap across the arc rather than letting whichever segment
    // is evaluated first spend all of it. Without this, a format with a hard cap
    // fills up on its opening and never reaches its ending.
    const segmentCap =
      maxOperations === Infinity
        ? Infinity
        : Math.max(1, Math.round(maxOperations * segment.budget));

    const required = pool.filter((c) => c.required);
    const optional = pool
      .filter((c) => !c.required)
      // By value first, not by value per second. Value per second is the right
      // answer to "fit the most worth into a budget" and the wrong answer to
      // "make a good cut": it fills the piece with cheap two-second shots of
      // nothing because they score well per second. An editor picks the best
      // moments and adds filler if there is time left, which is this order.
      .sort(
        (a, b) =>
          roleAdjusted(b, segment.prefer_roles) - roleAdjusted(a, segment.prefer_roles) ||
          density(b, segment.prefer_roles) - density(a, segment.prefer_roles) ||
          a.event.id.localeCompare(b.event.id),
      );

    let segmentUsed = 0;
    let segmentCount = 0;
    for (const candidate of required) {
      chosen.push(candidate);
      segmentUsed += candidate.preferredMs;
      segmentCount++;
    }

    for (const candidate of optional) {
      if (chosen.length >= maxOperations || segmentCount >= segmentCap) break;
      // Budgeted at the duration this clip should get, not at its floor.
      // Selecting at the floor packs in everything that fits and produces a cut
      // that is technically the right length and uniformly three seconds long.
      if (segmentUsed + candidate.preferredMs > budget) continue;
      chosen.push(candidate);
      segmentUsed += candidate.preferredMs;
      segmentCount++;
    }

    used += segmentUsed;
  }

  // A segment can come in under budget while another has candidates left over;
  // spending the slack is better than finishing short.
  if (used < targetDurationMs && chosen.length < maxOperations) {
    const remaining = candidates
      .filter((c) => !chosen.includes(c))
      .sort((a, b) => b.value - a.value || a.event.id.localeCompare(b.event.id));
    for (const candidate of remaining) {
      if (chosen.length >= maxOperations) break;
      if (used + candidate.preferredMs > targetDurationMs) continue;
      chosen.push(candidate);
      used += candidate.preferredMs;
    }
  }

  for (const candidate of candidates) {
    if (chosen.includes(candidate)) continue;
    options.rationale.push({
      event_id: candidate.event.id,
      decision: 'dropped',
      reason: 'there was no room for it inside the target duration',
      score: candidate.value,
      skill_rule_ids: candidate.directive.matched_rule_ids,
    });
  }

  return chosen.sort((a, b) => a.index - b.index);
}

/** Value, with a bonus for the roles this part of the arc wants. */
function roleAdjusted(candidate: Candidate, preferRoles: readonly string[]): number {
  const roleBonus =
    candidate.directive.role && preferRoles.includes(candidate.directive.role) ? 0.15 : 0;
  return candidate.value + roleBonus;
}

/** Value per second, used only to break ties between equally good moments. */
function density(candidate: Candidate, preferRoles: readonly string[]): number {
  const seconds = Math.max(1, candidate.preferredMs / 1000);
  const roleBonus =
    candidate.directive.role && preferRoles.includes(candidate.directive.role) ? 0.15 : 0;
  return (candidate.value + roleBonus) / seconds;
}

/**
 * How long a clip should be, given how good it is.
 *
 * The floor is what a clip needs to be usable; the ceiling is what the skill
 * will tolerate. Where a particular moment sits between them is a judgement
 * about the moment, and spending it on the good ones is the difference between
 * a cut that breathes and one that is uniformly clipped.
 */
export function preferredDuration(minMs: number, maxMs: number, rank: number): number {
  const scaled = Math.min(1, Math.max(0, rank));
  return Math.round(minMs + (maxMs - minMs) * scaled);
}

/**
 * Sets each candidate's preferred duration from its rank, not its raw score.
 *
 * Absolute scores are not comparable across projects or across decision
 * backends: rules produce a narrow band where a model produces a wide one, and
 * using the raw number means the same footage is cut at a uniform three seconds
 * under one backend and properly varied under another. Rank is the same
 * question — which of these moments is worth more time — asked in a way that
 * does not depend on how a particular backend spreads its numbers.
 */
export function assignPreferredDurations(candidates: Candidate[]): void {
  if (candidates.length === 0) return;
  if (candidates.length === 1) {
    const only = candidates[0]!;
    only.preferredMs = Math.round((only.minMs + only.maxMs) / 2);
    return;
  }

  const ranked = [...candidates].sort(
    (a, b) => a.value - b.value || a.event.id.localeCompare(b.event.id),
  );
  for (const [position, candidate] of ranked.entries()) {
    const rank = position / (ranked.length - 1);
    candidate.preferredMs = preferredDuration(candidate.minMs, candidate.maxMs, rank);
  }
}

/**
 * Splits candidates across the arc by position.
 *
 * Chronological, because the arc shapes how much time each part of the piece
 * gets, not which part of the day goes where.
 */
function assignArcSegments(candidates: Candidate[], skill: SkillManifest): void {
  const segments = skill.arc.segments;
  if (segments.length === 0) return;

  const total = candidates.reduce((sum, c) => sum + (c.event.end_ms - c.event.start_ms), 0) || 1;
  let cumulative = 0;

  for (const candidate of candidates) {
    const position = cumulative / total;
    cumulative += candidate.event.end_ms - candidate.event.start_ms;

    let boundary = 0;
    let assigned = segments.length - 1;
    for (const [index, segment] of segments.entries()) {
      boundary += segment.budget;
      if (position < boundary) {
        assigned = index;
        break;
      }
    }

    // A skill rule can pin an event to the opening or the ending regardless of
    // when it happened; that is the one place position is overridden.
    if (candidate.directive.place_at === 'opening') assigned = 0;
    else if (candidate.directive.place_at === 'ending') assigned = segments.length - 1;

    candidate.segment = assigned;
  }
}

/** Among events that cover the same material, keep the one worth keeping. */
function suppressDuplicates(
  candidates: Candidate[],
  ir: EditorialIR,
  rationale: PlanRationale[],
): void {
  const groups = new Map<string, Candidate[]>();
  for (const relation of ir.relations) {
    if (relation.relation_type !== 'duplicate_of') continue;
    const a = candidates.find((c) => c.event.id === relation.source_event_id);
    const b = candidates.find((c) => c.event.id === relation.target_event_id);
    if (!a || !b) continue;
    const key = a.event.id;
    const group = groups.get(key) ?? [a];
    if (!group.includes(b)) group.push(b);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (!group.some((c) => c.directive.prefer_higher_quality_only)) continue;

    const best = [...group].sort(
      (a, b) =>
        b.value - a.value ||
        (b.assessment.metrics.visual_quality ?? 0) - (a.assessment.metrics.visual_quality ?? 0) ||
        a.event.id.localeCompare(b.event.id),
    )[0];

    for (const candidate of group) {
      if (candidate === best || candidate.required) continue;
      candidate.directive = { ...candidate.directive, dropped: true };
      candidate.value = -Infinity;
      rationale.push({
        event_id: candidate.event.id,
        decision: 'dropped',
        reason: `another take of the same thing was kept instead (${best?.event.id})`,
        skill_rule_ids: candidate.directive.matched_rule_ids,
      });
    }
  }

  // Dropping is done by value here rather than by removal, so the indices used
  // for ordering stay stable.
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i]!.value === -Infinity) candidates.splice(i, 1);
  }
}

/**
 * A clip that only makes sense after another clip cannot stand alone.
 *
 * When the predecessor did not make the cut, the dependent clip goes too. The
 * alternative — leaving it in — produces the single most recognisable failure of
 * an automatic edit: a reply to a question the viewer never heard.
 */
function enforceContextDependencies(
  selected: Selected[],
  candidates: readonly Candidate[],
  ir: EditorialIR,
  rationale: PlanRationale[],
): void {
  const chosen = new Set(selected.map((c) => c.event.id));
  const ordered = eventsInOrder(ir);

  for (let i = selected.length - 1; i >= 0; i--) {
    const candidate = selected[i]!;
    if (candidate.required) continue;
    const needsContext = candidate.assessment.flags.requires_previous_context ?? 0;
    if (needsContext < 0.6) continue;

    const position = ordered.findIndex((e) => e.id === candidate.event.id);
    const previous = position > 0 ? ordered[position - 1] : undefined;
    if (!previous || chosen.has(previous.id)) continue;

    selected.splice(i, 1);
    chosen.delete(candidate.event.id);
    rationale.push({
      event_id: candidate.event.id,
      decision: 'dropped',
      reason: 'it only makes sense after the event before it, which is not in the cut',
      score: candidate.value,
      skill_rule_ids: candidate.directive.matched_rule_ids,
    });
  }

  void candidates;
}

/**
 * Hands out the running time.
 *
 * Everything starts at its floor, and whatever is left is shared out in
 * proportion to value until either the budget or every ceiling is reached.
 * Giving the best moments the extra seconds is the whole difference between a
 * cut that breathes and one that is uniformly clipped.
 */
export function allocateDurations(selected: Selected[], targetDurationMs: number): void {
  for (const candidate of selected) candidate.allocatedMs = candidate.minMs;

  let used = selected.reduce((sum, c) => sum + (c.allocatedMs ?? 0), 0);
  let remaining = targetDurationMs - used;

  // Over budget even at the floor: give back time from the least valuable.
  if (remaining < 0) {
    const byValue = [...selected].sort(
      (a, b) => a.value - b.value || a.event.id.localeCompare(b.event.id),
    );
    for (const candidate of byValue) {
      if (remaining >= 0) break;
      if (candidate.required || candidate.directive.locked) continue;
      const index = selected.indexOf(candidate);
      if (index < 0) continue;
      selected.splice(index, 1);
      remaining += candidate.allocatedMs ?? 0;
    }
    return;
  }

  for (let pass = 0; pass < 8 && remaining > 0; pass++) {
    const growable = selected.filter((c) => (c.allocatedMs ?? 0) < c.maxMs);
    if (growable.length === 0) break;

    const totalValue = growable.reduce((sum, c) => sum + Math.max(0.01, c.value), 0);
    let handedOut = 0;

    for (const candidate of growable) {
      const share = (Math.max(0.01, candidate.value) / totalValue) * remaining;
      const room = candidate.maxMs - (candidate.allocatedMs ?? 0);
      const give = Math.floor(Math.min(share, room));
      if (give <= 0) continue;
      candidate.allocatedMs = (candidate.allocatedMs ?? 0) + give;
      handedOut += give;
    }

    if (handedOut === 0) break;
    remaining -= handedOut;
    used += handedOut;
  }
}

/**
 * The order clips appear in.
 *
 * Chronological unless the Skill says `hook_first`, and even then only one
 * event moves. Rearranging someone's day into a more dramatic shape is the
 * fastest way to lose their trust in everything else the tool did.
 */
function orderForSequence(selected: Selected[], skill: SkillManifest): Selected[] {
  const chronological = [...selected].sort((a, b) => a.index - b.index);
  if (skill.arc.ordering !== 'hook_first' || chronological.length < 3) return chronological;

  const hook = [...chronological].sort(
    (a, b) =>
      (b.assessment.flags.opening_candidate ?? 0) +
        b.assessment.metrics.emotional_intensity -
        ((a.assessment.flags.opening_candidate ?? 0) + a.assessment.metrics.emotional_intensity) ||
      a.event.id.localeCompare(b.event.id),
  )[0];

  if (!hook || chronological[0] === hook) return chronological;
  return [hook, ...chronological.filter((c) => c !== hook)];
}

function transitionFor(
  candidate: Selected,
  previous: Selected | undefined,
  skill: SkillManifest,
): Transition | undefined {
  if (candidate.directive.transition_in) return candidate.directive.transition_in;
  if (!previous) return undefined;
  const changedChapter = previous.event.chapter_id !== candidate.event.chapter_id;
  if (changedChapter && skill.defaults.chapter_transition) return skill.defaults.chapter_transition;
  return skill.defaults.default_transition;
}

function buildSequenceSpec(
  ir: EditorialIR,
  targetDurationMs: number,
  toleranceMs: number,
  overrides: Partial<SequenceSpec> | undefined,
): SequenceSpec {
  // Match the material rather than imposing a format: a vertical project should
  // not silently become sixteen by nine.
  const reference = [...ir.assets].sort(
    (a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
  )[0];

  return {
    name: `${ir.project.title} — ${Math.round(targetDurationMs / 1000)}s`,
    target_duration_ms: targetDurationMs,
    tolerance_ms: toleranceMs,
    width: overrides?.width ?? reference?.width ?? 1920,
    height: overrides?.height ?? reference?.height ?? 1080,
    frame_rate: overrides?.frame_rate ?? reference?.fps ?? 30,
    frame_rate_num: overrides?.frame_rate_num ?? reference?.fps_num ?? 30,
    frame_rate_den: overrides?.frame_rate_den ?? reference?.fps_den ?? 1,
    sample_rate: overrides?.sample_rate ?? 48_000,
  };
}

function silencesFor(
  observations: ObservationTimeline | undefined,
  assetId: string,
): { start_ms: number; end_ms: number }[] {
  if (!observations) return [];
  return observations.audio_events
    .filter((event) => event.asset_id === assetId && event.event_type === 'silence')
    .map((event) => ({ start_ms: event.start_ms, end_ms: event.end_ms }));
}

function selectionReason(candidate: Selected, trim: string): string {
  const parts: string[] = [];
  if (candidate.required) parts.push('kept because it must be');
  else parts.push(`scored ${candidate.value.toFixed(2)}`);
  if (candidate.directive.matched_rule_ids.length > 0)
    parts.push(`rules: ${describeRules(candidate.directive)}`);
  if (trim === 'speech') parts.push('trimmed to the speech in it');
  else if (trim === 'snapped') parts.push('cut points moved to the nearest quiet moment');
  else if (trim === 'whole_event') parts.push('short enough to keep whole');
  return parts.join('; ');
}

function describeRules(directive: SkillDirective): string {
  return directive.matched_rule_ids.length > 0
    ? directive.matched_rule_ids.join(', ')
    : 'the skill defaults';
}

function defaultTarget(ir: EditorialIR): number {
  // A tenth of the material, bounded to something a person would actually watch.
  const total = ir.assets.reduce((sum, a) => sum + a.duration_ms, 0);
  return Math.min(600_000, Math.max(30_000, Math.round(total * 0.1)));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10_000) / 10_000;
}

function meanContinuity(selected: readonly Selected[], ir: EditorialIR): number {
  if (selected.length < 2) return 1;
  const scores: number[] = [];
  for (let i = 1; i < selected.length; i++) {
    const relation = ir.relations.find(
      (r) =>
        r.relation_type === 'continuation' &&
        r.source_event_id === selected[i - 1]!.event.id &&
        r.target_event_id === selected[i]!.event.id,
    );
    scores.push(relation?.strength ?? 0.4);
  }
  return mean(scores);
}
