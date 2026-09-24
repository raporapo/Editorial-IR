import {
  compareText,
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
  REQUIRES_CONTEXT_THRESHOLD,
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
  /** Adjustments from a caller: a person on the command line, or a model agent. */
  overrides?: PlanOverrides;
  now?: () => string;
}

/**
 * Adjustments applied after the skill and before selection.
 *
 * This is the seam a model-driven agent works through. It contributes judgement
 * about which moments matter for a particular request — "the meals do not all
 * need to be shown" — and the planner keeps contributing feasibility: the target
 * duration, the user's must-keeps and the validator's invariants are still
 * satisfied by construction, whoever asked for what.
 *
 * It does override the skill: `require` recovers an event a skill rule dropped,
 * because the skill is a style and this is a particular request.
 *
 * It cannot override the user. An event the user marked essential stays, and an
 * event they excluded stays out, whatever is passed here. An id that names no
 * event is an error rather than a no-op — planning the default cut after being
 * asked for a different one is a failure that reports success.
 */
export interface PlanOverrides {
  /** Select these if at all possible. */
  require?: readonly string[];
  /** Do not select these. */
  drop?: readonly string[];
  /** Added to the score, before ranking. Negative is allowed. */
  boost?: Readonly<Record<string, number>>;
  /** Why, for the plan's rationale. */
  reasons?: Readonly<Record<string, string>>;
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
  const excludedAssets = new Set(ir.context.constraints.excluded_assets);
  const ordered = eventsInOrder(ir);
  const rationale: PlanRationale[] = [];

  // ---- candidates ----------------------------------------------------------
  const candidates: Candidate[] = [];
  // Events the skill turned down, kept to one side so that a caller asking for
  // one by name can have it back. The skill is a style; the caller is this
  // particular request, and the request wins.
  const setAside = new Map<string, Candidate>();
  const knownEventIds = new Set<string>();
  for (const [index, event] of ordered.entries()) {
    const directive = directives.get(event.id);
    const assessment = assessmentFor(ir, event.id);
    if (!directive || !assessment) continue;
    knownEventIds.add(event.id);

    if (event.knowledge.excluded) {
      rationale.push({
        event_id: event.id,
        decision: 'excluded',
        reason: 'the user excluded this',
        skill_rule_ids: directive.matched_rule_ids,
        tags: directive.tags,
      });
      continue;
    }

    // A recording the user banned in `constraints.excluded_assets`. The
    // validator refuses to export a plan containing one, and the planner did not
    // know about them at all — so excluding a recording produced a cut full of
    // it that then would not export, with nothing to say what to remove.
    const bannedAsset = event.source_ranges
      .map((range) => range.asset_id)
      .find((assetId) => excludedAssets.has(assetId));
    if (bannedAsset !== undefined) {
      rationale.push({
        event_id: event.id,
        decision: 'excluded',
        reason: `the user excluded ${bannedAsset}`,
        skill_rule_ids: directive.matched_rule_ids,
        tags: directive.tags,
      });
      continue;
    }

    // The user's own bounds, which outrank the skill's.
    //
    // `constraints.min_clip_duration_ms` and `max_clip_duration_ms` sit in the
    // document described as "everything the user knows that the media cannot
    // contain", which no model may write to, and **nothing read them**. Verified:
    // writing `min_clip_duration_ms: 8000` into a project's context.yaml and
    // planning it returned clips of 2.7s, 2.0s, 2.5s, 9s and 3.8s — four of five
    // under the stated floor, with nothing said by `plan` or by `oea review`.
    const available = event.end_ms - event.start_ms;
    const userFloor = ir.context.constraints.min_clip_duration_ms ?? 0;
    const userCeiling = ir.context.constraints.max_clip_duration_ms ?? Infinity;

    // A moment too short to satisfy the floor is not used, rather than used at a
    // length the user said not to. Clamping the floor to whatever the event
    // happens to contain is the same as not having a floor, and the first
    // attempt here did exactly that: on a project with a stated eight-second
    // minimum it still returned two- and four-second clips, because it went on
    // choosing short events. That is precisely what the constraint exists to
    // stop, and there were forty-eight events long enough to choose instead.
    //
    // Excluded rather than dropped, for the same reason an excluded asset is:
    // the user decided this, not the skill, and the rationale should say so.
    if (userFloor > 0 && available < userFloor) {
      rationale.push({
        event_id: event.id,
        decision: 'excluded',
        reason: `shorter than the ${Math.round(userFloor / 1000)}s minimum the project asks for`,
        skill_rule_ids: directive.matched_rule_ids,
        tags: directive.tags,
      });
      continue;
    }

    const minMs = Math.min(Math.max(directive.min_duration_ms, userFloor), available);
    const maxMs = Math.max(minMs, Math.min(directive.max_duration_ms, userCeiling, available));
    const candidate: Candidate = {
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
    };

    if (directive.dropped) {
      rationale.push({
        event_id: event.id,
        decision: 'dropped',
        reason: `dropped by ${describeRules(directive)}`,
        score: directive.score,
        skill_rule_ids: directive.matched_rule_ids,
        tags: directive.tags,
      });
      setAside.set(event.id, candidate);
      continue;
    }

    candidates.push(candidate);
  }

  applyOverrides(candidates, options.overrides, {
    rationale,
    setAside,
    knownEventIds,
  });

  // The mirror of the excluded-asset filter above, and it was missing entirely.
  //
  // `constraints.required_assets` — "assets that must appear at least once" —
  // sits in the same object as `excluded_assets`, in the worked example's own
  // context.yaml, and was read by nothing. Verified: setting it to `[asset_002]`
  // produced a cut using asset_001 four times and asset_003 once, and
  // `oea review` said "nothing to report".
  //
  // The validator now reports a required asset that never made the cut, and this
  // is what lets the planner satisfy it — exactly the argument the exclusion
  // comment above makes in reverse. Only the best candidate from each asset is
  // promoted: "must appear at least once" is a floor, not an instruction to take
  // everything from that recording.
  for (const assetId of ir.context.constraints.required_assets) {
    const fromAsset = candidates.filter((candidate) =>
      candidate.event.source_ranges.some((range) => range.asset_id === assetId),
    );
    if (fromAsset.length === 0 || fromAsset.some((candidate) => candidate.required)) continue;
    const best = fromAsset.reduce((a, b) => (b.value > a.value ? b : a));
    best.required = true;
    best.directive = { ...best.directive, required: true };
    rationale.push({
      event_id: best.event.id,
      decision: 'locked',
      reason: `${assetId} must appear at least once`,
      score: best.value,
      skill_rule_ids: best.directive.matched_rule_ids,
      tags: best.directive.tags,
    });
  }

  if (candidates.length === 0) {
    // Say what did it, because the answer decides what the user should do next
    // and the rationale already knows. A skill dropping everything is the
    // ordinary outcome on footage with no speech and no vision model — every
    // event is `filler` at importance 0.175 — and "there is nothing to cut" on
    // its own sends someone to look at their footage when the answer is a
    // different skill, a correction, or a model.
    const why = new Map<string, number>();
    for (const entry of rationale) {
      if (entry.decision !== 'dropped' && entry.decision !== 'excluded') continue;
      why.set(entry.reason, (why.get(entry.reason) ?? 0) + 1);
    }
    const reasons = [...why.entries()]
      .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
      .slice(0, 3)
      .map(([reason, count]) => `${count} × ${reason}`);

    throw new EditorialError(
      'plan_invalid',
      `all ${ordered.length} event(s) were dropped or excluded; there is nothing to cut`,
      {
        ...(reasons.length > 0 ? { why: reasons.join('; ') } : {}),
        hint: 'try another skill ("oea skills"), keep one with "oea annotate <event> essential", or configure a model so the events are understood rather than guessed at',
      },
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
    relations: relationIndex(ir),
  });

  // Both passes only ever remove, and each can create work for the other: the
  // role cap drops a clip that something else depended on. Repeating until the
  // cut stops changing is what keeps the two from leaving a mess between them —
  // running them once in a fixed order left orphans behind whichever ran first.
  for (let pass = 0; pass < selected.length + 1; pass++) {
    const before = selected.length;
    enforceContextDependencies(selected, ir, rationale);
    capConsecutiveRoles(selected, skill, targetDurationMs, rationale);
    if (selected.length === before) break;
  }
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
    // The event's denormalised speech carries no word timings, so these come
    // from the observation timeline — the same place the silences do.
    const words = wordsFor(options.observations, range.asset_id, range);

    const trim = chooseTrim({
      range: { start_ms: range.source_in_ms, end_ms: range.source_out_ms },
      speech: assetSpeech,
      silences,
      words,
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
      // A rule that asks for a clip to be *left* a particular way. The plan
      // contract carries it, the validator checks it and both adapters write
      // it; the planner was the one link that dropped it, so `transition_out`
      // in a skill file did nothing at all.
      ...(candidate.directive.transition_out
        ? { transition_out: candidate.directive.transition_out }
        : {}),
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
      tags: candidate.directive.tags,
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
    // Empty, and correctly so: the deterministic planner asks nobody anything.
    // `oea agent` fills this in with the model it consulted.
    model_runs: [],
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
 * Ranked by value rather than by value per second: value per second is the
 * right answer to "fit the most worth into a budget" and the wrong answer to
 * "make a good cut", because it fills the piece with cheap two-second shots of
 * nothing. Required events are taken first regardless — a user's "keep this" is
 * not something to weigh against a score.
 *
 * The ranking is redone after every pick, because two of the three terms are
 * about the company a moment keeps: a shot loses value once something it
 * duplicates is already in, and gains a little when it continues something that
 * is. A skill sets both amounts, and both were declared and never applied.
 */
function select(
  candidates: readonly Candidate[],
  options: {
    targetDurationMs: number;
    skill: SkillManifest;
    rationale: PlanRationale[];
    relations: RelationIndex;
  },
): Selected[] {
  const { skill, targetDurationMs, relations } = options;
  const segments =
    skill.arc.segments.length > 0
      ? skill.arc.segments
      : [{ name: 'all', budget: 1, prefer_roles: [], require_roles: [] }];
  const maxOperations = skill.constraints.max_operations ?? Infinity;

  const chosen: Selected[] = [];
  const taken = new Set<string>();
  let used = 0;

  /** Value, adjusted for what is already in the cut around it. */
  const worth = (candidate: Candidate, preferRoles: readonly string[]): number =>
    roleAdjusted(candidate, preferRoles) +
    skill.scoring.continuity_bonus * relations.continuityWith(candidate.event.id, taken) -
    skill.scoring.duplicate_penalty * relations.duplicationWith(candidate.event.id, taken);

  /** The best candidate that still fits, or nothing. */
  const bestFitting = (
    pool: readonly Candidate[],
    preferRoles: readonly string[],
    fits: (candidate: Candidate) => boolean,
  ): Candidate | undefined => {
    let best: Candidate | undefined;
    let bestWorth = -Infinity;
    let bestDensity = -Infinity;
    for (const candidate of pool) {
      if (taken.has(candidate.event.id) || !fits(candidate)) continue;
      const value = worth(candidate, preferRoles);
      const perSecond = density(candidate, preferRoles);
      const better =
        best === undefined ||
        value > bestWorth ||
        (value === bestWorth &&
          (perSecond > bestDensity ||
            (perSecond === bestDensity && compareText(candidate.event.id, best.event.id) < 0)));
      if (better) {
        best = candidate;
        bestWorth = value;
        bestDensity = perSecond;
      }
    }
    return best;
  };

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

    let segmentUsed = 0;
    let segmentCount = 0;
    const take = (candidate: Candidate): void => {
      chosen.push(candidate);
      taken.add(candidate.event.id);
      segmentUsed += candidate.preferredMs;
      segmentCount++;
    };

    for (const candidate of pool.filter((c) => c.required)) take(candidate);

    // A segment the skill says is unfilled without one of these roles gets the
    // best one it can before the ordinary ranking spends the budget: tech-youtube
    // declares `require_roles: [setup]` on its opening because a tech video that
    // does not say what it is about loses the viewer, and it was read by nothing.
    const wanted = segment.require_roles;
    if (wanted.length > 0 && !pool.some((c) => taken.has(c.event.id) && hasRole(c, wanted))) {
      const opener = bestFitting(
        pool.filter((c) => hasRole(c, wanted)),
        segment.prefer_roles,
        (c) => segmentUsed + c.preferredMs <= budget,
      );
      if (opener) take(opener);
    }

    const optional = pool.filter((c) => !c.required);
    while (chosen.length < maxOperations && segmentCount < segmentCap) {
      // Budgeted at the duration this clip should get, not at its floor.
      // Selecting at the floor packs in everything that fits and produces a cut
      // that is technically the right length and uniformly three seconds long.
      const next = bestFitting(
        optional,
        segment.prefer_roles,
        (c) => segmentUsed + c.preferredMs <= budget,
      );
      if (!next) break;
      take(next);
    }

    used += segmentUsed;
  }

  // A segment can come in under budget while another has candidates left over;
  // spending the slack is better than finishing short.
  while (used < targetDurationMs && chosen.length < maxOperations) {
    const next = bestFitting(candidates, [], (c) => used + c.preferredMs <= targetDurationMs);
    if (!next) break;
    chosen.push(next);
    taken.add(next.event.id);
    used += next.preferredMs;
  }

  for (const candidate of candidates) {
    if (chosen.includes(candidate)) continue;
    options.rationale.push({
      event_id: candidate.event.id,
      decision: 'dropped',
      reason: 'there was no room for it inside the target duration',
      score: candidate.value,
      skill_rule_ids: candidate.directive.matched_rule_ids,
      tags: candidate.directive.tags,
    });
  }

  return chosen.sort((a, b) => a.index - b.index);
}

/**
 * Applies a caller's adjustments.
 *
 * Deliberately after the skill and before selection: the skill decides what the
 * style wants, the caller adjusts for this particular request, and the planner
 * still decides what actually fits.
 */
function applyOverrides(
  candidates: Candidate[],
  overrides: PlanOverrides | undefined,
  world: {
    rationale: PlanRationale[];
    /** Candidates the skill turned down, available for `require` to recover. */
    setAside: Map<string, Candidate>;
    /** Every event the plan could possibly have named. */
    knownEventIds: Set<string>;
  },
): void {
  if (!overrides) return;
  const { rationale, setAside, knownEventIds } = world;

  // A misspelt id used to do nothing at all, which is the worst outcome
  // available: the caller asked for a different cut, got the default one, and
  // was told it succeeded.
  const unknown = [...new Set([...(overrides.require ?? []), ...(overrides.drop ?? [])])].filter(
    (id) => !knownEventIds.has(id),
  );
  if (unknown.length > 0) {
    throw new EditorialError(
      'invalid_input',
      `no such event: ${unknown.join(', ')}. Run "oea timeline" for the ids in this project.`,
      { unknown_event_ids: unknown },
    );
  }

  const required = new Set(overrides.require ?? []);
  const dropped = new Set(overrides.drop ?? []);

  // Asked for by name, turned down by the skill. Put it back where it belongs
  // in the order, and take back the rationale line that said it was dropped —
  // a plan that records both decisions for one event explains nothing.
  for (const id of required) {
    const recovered = setAside.get(id);
    if (!recovered || dropped.has(id)) continue;
    setAside.delete(id);
    const at = candidates.findIndex((candidate) => candidate.index > recovered.index);
    candidates.splice(at === -1 ? candidates.length : at, 0, recovered);
    const line = rationale.findIndex(
      (entry) => entry.event_id === id && entry.decision === 'dropped',
    );
    if (line !== -1) rationale.splice(line, 1);
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    const id = candidate.event.id;

    const boost = overrides.boost?.[id];
    if (boost !== undefined) candidate.value += boost;

    if (dropped.has(id)) {
      // The user still outranks the caller: an event they marked essential is
      // not something an agent gets to drop.
      if (candidate.event.knowledge.essential) continue;
      rationale.push({
        event_id: id,
        decision: 'dropped',
        reason: overrides.reasons?.[id] ?? 'left out at the caller\u2019s request',
        score: candidate.value,
        skill_rule_ids: candidate.directive.matched_rule_ids,
        tags: candidate.directive.tags,
      });
      candidates.splice(i, 1);
      continue;
    }

    if (required.has(id)) {
      candidate.required = true;
      candidate.directive = { ...candidate.directive, required: true };
    }
  }
}

/** Whether a candidate carries one of the roles a segment insists on. */
function hasRole(candidate: Candidate, roles: readonly string[]): boolean {
  return candidate.directive.role !== undefined && roles.includes(candidate.directive.role);
}

/**
 * The two relations selection consults about the company a moment keeps.
 *
 * Both are read as "the strongest relation to anything already chosen" rather
 * than a sum. A shot that duplicates three selected shots is not three times as
 * redundant — it is redundant, and the penalty a skill writes down is the price
 * of that, once.
 */
interface RelationIndex {
  duplicationWith(eventId: string, chosen: ReadonlySet<string>): number;
  continuityWith(eventId: string, chosen: ReadonlySet<string>): number;
}

function relationIndex(ir: EditorialIR): RelationIndex {
  const duplicate = new Map<string, Map<string, number>>();
  const continuation = new Map<string, Map<string, number>>();

  const link = (
    into: Map<string, Map<string, number>>,
    from: string,
    to: string,
    strength: number,
  ): void => {
    const edges = into.get(from) ?? new Map<string, number>();
    edges.set(to, Math.max(edges.get(to) ?? 0, strength));
    into.set(from, edges);
  };

  for (const relation of ir.relations) {
    const into =
      relation.relation_type === 'duplicate_of'
        ? duplicate
        : relation.relation_type === 'continuation'
          ? continuation
          : undefined;
    if (!into) continue;
    // Stored both ways: continuation is directional as a statement about the
    // material, but "these two cut together" is a property of the pair, and
    // selection meets them in whichever order the ranking reaches them.
    link(into, relation.source_event_id, relation.target_event_id, relation.strength);
    link(into, relation.target_event_id, relation.source_event_id, relation.strength);
  }

  const strongest = (
    edges: Map<string, Map<string, number>>,
    eventId: string,
    chosen: ReadonlySet<string>,
  ): number => {
    let best = 0;
    for (const [other, strength] of edges.get(eventId) ?? []) {
      if (chosen.has(other) && strength > best) best = strength;
    }
    return best;
  };

  return {
    duplicationWith: (eventId, chosen) => strongest(duplicate, eventId, chosen),
    continuityWith: (eventId, chosen) => strongest(continuation, eventId, chosen),
  };
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
    (a, b) => a.value - b.value || compareText(a.event.id, b.event.id),
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
        compareText(a.event.id, b.event.id),
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
        tags: candidate.directive.tags,
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
  ir: EditorialIR,
  rationale: PlanRationale[],
): void {
  const chosen = new Set(selected.map((c) => c.event.id));
  const position = new Map(eventsInOrder(ir).map((event, index) => [event.id, index]));
  const previousOf = new Map(
    eventsInOrder(ir).map((event, index, all) => [event.id, all[index - 1]?.id]),
  );

  // Chronologically, so that a clip's predecessor has already been decided by
  // the time the clip itself is considered. Walking `selected` — which is in
  // selection order, by value within each arc segment — meant a chain could
  // survive in pieces: drop A, and the B that needed it goes, but the C that
  // needed B was visited first and stays. A reply to a question the viewer
  // never heard is the single most recognisable failure of an automatic edit,
  // and it was reachable by a chain of two.
  const chronological = [...selected].sort(
    (a, b) => (position.get(a.event.id) ?? 0) - (position.get(b.event.id) ?? 0),
  );

  for (const candidate of chronological) {
    if (candidate.required) continue;
    const needsContext = candidate.assessment.flags.requires_previous_context ?? 0;
    if (needsContext < REQUIRES_CONTEXT_THRESHOLD) continue;

    const previous = previousOf.get(candidate.event.id);
    if (previous === undefined || chosen.has(previous)) continue;

    const at = selected.indexOf(candidate);
    if (at < 0) continue;
    selected.splice(at, 1);
    chosen.delete(candidate.event.id);
    rationale.push({
      event_id: candidate.event.id,
      decision: 'dropped',
      reason: 'it only makes sense after the event before it, which is not in the cut',
      score: candidate.value,
      skill_rule_ids: candidate.directive.matched_rule_ids,
      tags: candidate.directive.tags,
    });
  }
}

/**
 * Stops the same kind of shot running six times in a row.
 *
 * The skill declares the cap (`constraints.max_consecutive_same_role`) and says
 * what it is for: "to stop six establishing shots in a row". It was declared and
 * never enforced, and the flagship cut showed exactly what that costs — seven
 * consecutive `transition` clips, twenty-one seconds of platforms and train
 * windows with no variation, in a three-minute travel vlog whose skill asks for
 * a cap of three.
 *
 * Selection cannot prevent it, because it happens per arc segment and by value,
 * and a run only becomes visible once the selection is laid out in time. So this
 * runs afterwards, on the chronological order, and keeps the best of each run:
 * the answer to "seven shots of travelling" is the three best ones, not the
 * first three. The time it gives back is spent by `allocateDurations` on what is
 * left, so the cut does not get shorter, it gets less repetitive.
 */
function capConsecutiveRoles(
  selected: Selected[],
  skill: SkillManifest,
  targetDurationMs: number,
  rationale: PlanRationale[],
): void {
  const cap = skill.constraints.max_consecutive_same_role;
  if (!Number.isFinite(cap) || cap < 1) return;

  // The cap is a heuristic about monotony, and it is never allowed to fight the
  // target duration, which is the planner's actual contract.
  //
  // Material where one role dominates is the case that makes this matter, and it
  // is ordinary material: forty shots from one afternoon are frequently all
  // `context`. Enforced blindly, the cap sees a single run of forty, keeps three
  // and drops thirty-seven — a three-clip film whatever length was asked for.
  // Every one of those drops is pure loss, because there is nothing else to
  // interleave and so no arrangement satisfies the cap anyway.
  //
  // So dropping stops at the point where the cut can no longer reach its target.
  //
  // The measure is each clip's *ceiling*, not the duration selection budgeted for
  // it. Dropping a clip does not shorten the cut: allocation hands the freed time
  // to the clips that remain, and they grow toward their maxima. What actually
  // limits it is whether the survivors have enough headroom left to cover the
  // target between them — which in the worked example they comfortably do, and
  // in a cut of forty near-identical shots they do not.
  let ceiling = selected.reduce((sum, candidate) => sum + candidate.maxMs, 0);

  const ordered = [...selected].sort((a, b) => a.index - b.index);
  const doomed = new Set<Selected>();

  let run: Selected[] = [];
  const flush = (): void => {
    if (run.length > cap) {
      // Keep the best of the run, not the earliest: if the viewer is going to
      // see three shots of a train, they should be the three worth seeing.
      const ranked = [...run].sort(
        (a, b) => b.value - a.value || compareText(a.event.id, b.event.id),
      );
      for (const candidate of ranked.slice(cap)) {
        if (candidate.required || candidate.directive.locked) continue;
        if (ceiling - candidate.maxMs < targetDurationMs) break;
        ceiling -= candidate.maxMs;
        doomed.add(candidate);
      }
    }
    run = [];
  };

  for (const candidate of ordered) {
    const role = candidate.directive.role;
    if (run.length > 0 && run[0]!.directive.role !== role) flush();
    run.push(candidate);
  }
  flush();

  for (const candidate of doomed) {
    const at = selected.indexOf(candidate);
    if (at < 0) continue;
    selected.splice(at, 1);
    rationale.push({
      event_id: candidate.event.id,
      decision: 'dropped',
      reason: `${cap} in a row of the same kind is the limit this style sets`,
      score: candidate.value,
      skill_rule_ids: candidate.directive.matched_rule_ids,
      tags: candidate.directive.tags,
    });
  }
}

/**
 * Hands out the running time.
 *
 * Everything starts at the duration selection budgeted for it, and whatever is
 * left over is shared out in proportion to value until either the budget or
 * every ceiling is reached. Giving the best moments the extra seconds is the
 * whole difference between a cut that breathes and one that is uniformly
 * clipped.
 *
 * Starting at the floor instead is the subtle version of the mistake selection
 * already avoids. Selection fits these clips to the target on the promise of
 * their preferred durations, which are rank-based and therefore comparable
 * across backends; allocation then reset every one of them to its floor and
 * redistributed by raw value share, which is a different weighting, so the cut
 * that came out was not the cut that was chosen.
 *
 * What that cost is measurable on the worked example: the three-minute travel
 * vlog carried 82.8% of the speech it had selected, because the moments where
 * someone says something were trimmed to make room for B-roll that had been
 * budgeted at two seconds and allocated four. Allocating what selection
 * budgeted brings it to 89.5% — four more seconds of people finishing their
 * sentences, at the same length, with the same clips.
 */
export function allocateDurations(selected: Selected[], targetDurationMs: number): void {
  for (const candidate of selected) {
    candidate.allocatedMs = Math.min(
      candidate.maxMs,
      Math.max(candidate.minMs, candidate.preferredMs),
    );
  }

  let used = selected.reduce((sum, c) => sum + (c.allocatedMs ?? 0), 0);
  let remaining = targetDurationMs - used;

  // Over budget. Take the overage back from the slack each clip has above its
  // own floor, in proportion to how much slack it has, so that the clips with
  // the most room give up the most and nothing is pushed under its minimum.
  if (remaining < 0) {
    const slackOf = (c: Selected): number => (c.allocatedMs ?? 0) - c.minMs;
    let slack = selected.reduce((sum, c) => sum + slackOf(c), 0);
    if (slack > 0) {
      const wanted = Math.min(-remaining, slack);
      for (const candidate of selected) {
        const share = slackOf(candidate);
        if (share <= 0) continue;
        const take = Math.min(share, Math.ceil((share / slack) * wanted));
        candidate.allocatedMs = (candidate.allocatedMs ?? 0) - take;
        remaining += take;
        if (remaining >= 0) break;
      }
      slack = selected.reduce((sum, c) => sum + slackOf(c), 0);
    }
  }

  // Still over budget with everything at its floor: the cut is holding more
  // clips than the target can carry, and the answer is fewer clips rather than
  // clips too short to read. Give back the least valuable.
  if (remaining < 0) {
    const byValue = [...selected].sort(
      (a, b) => a.value - b.value || compareText(a.event.id, b.event.id),
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
      compareText(a.event.id, b.event.id),
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

/**
 * How big a clip is *on screen*, which is not always how it is stored.
 *
 * A phone shooting portrait writes a 1920x1080 frame and a 90-degree display
 * matrix beside it, and every player honours the matrix. Reading `width` and
 * `height` alone therefore reports a vertical recording as landscape.
 */
function displaySize(asset: { width?: number; height?: number; rotation?: number }): {
  width: number;
  height: number;
} {
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  const turned = asset.rotation === 90 || asset.rotation === 270 || asset.rotation === -90;
  return turned ? { width: height, height: width } : { width, height };
}

function buildSequenceSpec(
  ir: EditorialIR,
  targetDurationMs: number,
  toleranceMs: number,
  overrides: Partial<SequenceSpec> | undefined,
): SequenceSpec {
  // Match the material rather than imposing a format: a vertical project should
  // not silently become sixteen by nine.
  //
  // Which it did. `rotation` has been probed and stored since ingest was
  // written and was read by nothing, here or anywhere else, so the sequence took
  // the *coded* dimensions — and a phone-shot portrait project came out
  // 1920x1080, the exact outcome the line above says must not happen. Verified
  // on a real file with a 90-degree display matrix: assets.json recorded
  // `width 1920, height 1080, rotation 90` and the plan's sequence was
  // 1920x1080.
  //
  // The sort key has to use the display size too. Ranking by coded area picks
  // the same asset either way, but only because the two differ by a transpose;
  // ranking by the number that is then *returned* is what keeps the two halves
  // of this function from disagreeing.
  //
  // And only video decides. A photo is placed into a sequence, it does not
  // define one: stills were ranked with everything else, so one 4032x3024 phone
  // photo beside a 1280x720 clip made the sequence 4032x3024 — at 25 fps, the
  // rate ffmpeg reports for every picture. An audio file has no picture to
  // match, and its album art is not one. With no video at all, the defaults.
  const reference = ir.assets
    .filter((asset) => asset.kind === 'video' && (asset.width ?? 0) > 0)
    .sort((a, b) => {
      const left = displaySize(a);
      const right = displaySize(b);
      return right.width * right.height - left.width * left.height || compareText(a.id, b.id);
    })[0];
  const display = reference ? displaySize(reference) : undefined;
  // The rate travels as one: a reference with no rational of its own must not
  // pair its float with the default's numerator.
  const rate =
    reference?.fps_num && reference.fps_den
      ? {
          fps: reference.fps_num / reference.fps_den,
          num: reference.fps_num,
          den: reference.fps_den,
        }
      : { fps: 30, num: 30, den: 1 };

  return {
    name: `${ir.project.title} — ${Math.round(targetDurationMs / 1000)}s`,
    target_duration_ms: targetDurationMs,
    tolerance_ms: toleranceMs,
    width: overrides?.width ?? (display?.width || undefined) ?? 1920,
    height: overrides?.height ?? (display?.height || undefined) ?? 1080,
    frame_rate: overrides?.frame_rate ?? rate.fps,
    frame_rate_num: overrides?.frame_rate_num ?? rate.num,
    frame_rate_den: overrides?.frame_rate_den ?? rate.den,
    sample_rate: overrides?.sample_rate ?? 48_000,
  };
}

/**
 * Word spans inside one clip's range, for the rule that a cut never goes through
 * a word.
 *
 * Narrowed to the range because a long asset has thousands of words and the
 * trimmer only ever asks about two moments. Returns nothing when the transcriber
 * gave no word timings, which is what makes the rule degrade rather than fail:
 * `chooseTrim` then behaves exactly as it did before.
 */
function wordsFor(
  observations: ObservationTimeline | undefined,
  assetId: string,
  range: { source_in_ms: number; source_out_ms: number },
): { start_ms: number; end_ms: number }[] {
  if (!observations) return [];
  const words: { start_ms: number; end_ms: number }[] = [];
  for (const utterance of observations.utterances) {
    if (utterance.asset_id !== assetId || utterance.words === undefined) continue;
    if (utterance.end_ms < range.source_in_ms || utterance.start_ms > range.source_out_ms) continue;
    for (const word of utterance.words) {
      if (word.end_ms < range.source_in_ms || word.start_ms > range.source_out_ms) continue;
      words.push({ start_ms: word.start_ms, end_ms: word.end_ms });
    }
  }
  return words;
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
