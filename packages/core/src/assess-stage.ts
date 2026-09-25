import {
  PIPELINE_VERSION,
  seqId,
  type EditorialAssessment,
  type EventEditorial,
  type EventState,
  type ProjectContext,
  type SemanticEvent,
} from '@editorial-ir/contracts';
import {
  HeuristicDecisionBackend,
  assessEvent,
  type EditorialDecisionModel,
} from '@editorial-ir/decision';
import {
  TokenRate,
  promptChars,
  selectLeavingOut,
  withinBudget,
  type CostBudget,
  type EscalationPolicy,
} from './budget.js';
import type { ModelRunRecorder } from './model-runs.js';
import type { PerceptionCache } from './cache.js';
import { hashObject } from './fingerprint.js';

/**
 * Running the decision layer over every event.
 *
 * The same escalation shape as the context builder, for the same reason: most
 * events are unambiguous and a rule answers them as well as anything would, and
 * the few that are not are where a better judgement changes the cut.
 *
 * The user's explicit importance is applied after the model has answered, not
 * instead of asking. The model's opinion stays in the record; the user's wins.
 */
export interface AssessOptions {
  context: ProjectContext;
  runs: ModelRunRecorder;
  /** Answers every event. */
  baseModel: EditorialDecisionModel;
  /** Answers the events worth spending on. */
  escalationModel?: EditorialDecisionModel;
  escalation?: EscalationPolicy;
  budget?: CostBudget;
  /** Highest similarity each event has to any other, for redundancy. */
  similarities?: Map<string, number>;
  /**
   * Caches assessments on the event state and the backend.
   *
   * A judgement depends on what the event is and who was asked, and on nothing
   * else — not on the target duration, not on the skill. Re-analysing after
   * changing either should cost nothing, and with a hosted model it otherwise
   * costs a full pass.
   */
  cache?: PerceptionCache;
  /**
   * Events that were still and silent throughout.
   *
   * The rules judge them instead of the base model, and they are never sent for
   * a second opinion. The rules do not guess here: an event with nothing moving
   * and nothing to hear scores low on every question a model would be asked,
   * and says why. Recorded as its own run, so the IR never claims the model
   * answered.
   */
  quietEvents?: readonly string[];
  onProgress?: (stage: string, done: number, total: number) => void;
  /** Told when a second opinion could not be had, so the substitution is visible. */
  onDegraded?: (message: string, failures: { eventId: string; reason: string }[]) => void;
}

export async function assessEvents(
  events: readonly SemanticEvent[],
  options: AssessOptions,
): Promise<{
  editorial: EventEditorial[];
  escalated: string[];
  failures: { eventId: string; reason: string }[];
  /**
   * Base-model judgements not asked for because the event was still and silent,
   * where asking would have cost something: one the cache would have answered
   * for free is not a saving.
   */
  judgeCallsSkipped: number;
  /** An estimate: each skipped judgement priced by its own state, at this run's measured tokens per character. */
  estimatedTokensAvoided: number;
  /** Events the base model was meant to judge: all of them, less the quiet ones the rules took. */
  judgeAsked: number;
  /** Events judged by the rules because the cost limit had been reached. */
  budgetStopped: number;
  /** The first of them, for the report. */
  budgetStoppedAt?: string;
  /** Second opinions the quiet events would have taken, net of the ones given to other events instead. */
  escalationsAvoided: number;
  /** Second opinions given to other events because the quiet ones were not candidates. */
  escalationsRedirected: number;
  /** An estimate, from what each pass charges per event. */
  estimatedCostAvoidedUsd: number;
}> {
  const ordered = [...events].sort((a, b) => a.start_ms - b.start_ms);
  const totalMs = ordered.reduce((sum, e) => sum + (e.end_ms - e.start_ms), 0) || 1;
  const states = new Map<string, EventState>();

  for (const [index, event] of ordered.entries()) {
    states.set(
      event.id,
      buildEventState(
        event,
        ordered[index - 1],
        ordered[index + 1],
        index / Math.max(1, ordered.length - 1),
        {
          context: options.context,
          ...(options.similarities?.has(event.id)
            ? { maxSimilarity: options.similarities.get(event.id)! }
            : {}),
        },
      ),
    );
  }

  const baseRun = options.runs.record({
    stage: 'decision',
    backend: options.baseModel.identity.backend,
    ...(options.baseModel.identity.model === undefined
      ? {}
      : { model: options.baseModel.identity.model }),
    locality: options.baseModel.identity.locality,
    mediaLeavesDevice: options.baseModel.identity.mediaLeavesDevice,
  });

  const drafts = new Map<string, Awaited<ReturnType<typeof assessEvent>>>();
  // Which run actually produced each answer. Recording the cheap model's run id
  // on an answer the expensive one gave is a falsified provenance: it tells a
  // reader, and the escalation policy on the next pass, that a rule-based judge
  // at confidence 0.4 said what a hosted model said.
  const producedBy = new Map<string, string>();
  // The base pass costs whatever the base model costs, and that was not being
  // counted either — `addCost` appeared only in the escalation branch below.
  // With `OEA_DECISION=local-system-one` the base judge is a real language model
  // answering nineteen questions per event, and a run reported no tokens at all.
  const baseCostPerEvent = options.baseModel.identity.costPerEventUsd ?? 0;
  // Asking the rules instead of the rules saves nothing, so only a real model
  // is spared. The run is recorded lazily, so a project with no quiet events
  // carries no run for work that never happened.
  const quiet = new Set(options.quietEvents ?? []);
  const spareQuiet = quiet.size > 0 && options.baseModel.identity.standIn === undefined;
  let rules: HeuristicDecisionBackend | undefined;
  let rulesRun: string | undefined;
  const judgeByRules = async (event: SemanticEvent): Promise<void> => {
    rules ??= new HeuristicDecisionBackend();
    rulesRun ??= options.runs.record({
      stage: 'decision',
      backend: rules.identity.backend,
      ...(rules.identity.model === undefined ? {} : { model: rules.identity.model }),
      locality: rules.identity.locality,
      mediaLeavesDevice: rules.identity.mediaLeavesDevice,
    });
    drafts.set(event.id, await assessEvent(rules, states.get(event.id)!));
    producedBy.set(event.id, rulesRun);
  };
  let judgeCallsSkipped = 0;
  let judgeAsked = 0;
  let budgetStopped = 0;
  let firstUnpaid: string | undefined;
  // What each paid call was charged, for the next call's expected price and
  // for pricing the calls not made.
  let charged = 0;
  let paidCalls = 0;
  const expectedCost = (): number =>
    options.baseModel.identity.costPerEventUsd ?? (paidCalls > 0 ? charged / paidCalls : 0);
  const baseRate = new TokenRate();
  const skippedSizes: number[] = [];
  for (const [index, event] of ordered.entries()) {
    options.onProgress?.('assess', index, ordered.length);
    const state = states.get(event.id)!;
    const size = promptChars({ ...state, event_id: undefined });
    if (spareQuiet && quiet.has(event.id)) {
      // The model's own answer, when the cache already holds it, costs nothing
      // and is better than the rules': taking the rules instead would lower the
      // quality of a re-run for no saving at all.
      const known = options.cache?.peek<Awaited<ReturnType<typeof assessEvent>>>(
        assessKey(options.baseModel, state),
      );
      if (known) {
        drafts.set(event.id, known);
        producedBy.set(event.id, baseRun);
        continue;
      }
      await judgeByRules(event);
      judgeCallsSkipped++;
      skippedSizes.push(size);
      continue;
    }
    judgeAsked++;
    const key = assessKey(options.baseModel, state);
    const hit = options.cache?.get<Awaited<ReturnType<typeof assessEvent>>>(key);
    if (hit) {
      // A cache hit is free. Counting it would make a re-run look as expensive
      // as the first one, which is the opposite of what the cache is for.
      drafts.set(event.id, hit);
      producedBy.set(event.id, baseRun);
      baseRate.observe(size, hit.inputTokens, hit.outputTokens);
      continue;
    }
    // `--budget` binds here too. With a hosted judge it did not, although this
    // is the pass that asks nineteen questions of every event.
    if (
      firstUnpaid !== undefined ||
      (options.budget && !options.budget.canAfford(expectedCost()))
    ) {
      firstUnpaid ??= event.id;
      budgetStopped++;
      await judgeByRules(event);
      continue;
    }
    const draft = await assessEvent(options.baseModel, state);
    options.cache?.set(key, draft);
    drafts.set(event.id, draft);
    producedBy.set(event.id, baseRun);
    baseRate.observe(size, draft.inputTokens, draft.outputTokens);
    const cost = draft.costUsd ?? baseCostPerEvent;
    options.budget?.charge(cost);
    charged += cost;
    paidCalls++;
    options.runs.addCost(baseRun, cost, draft.inputTokens, draft.outputTokens);
  }

  const escalated: string[] = [];
  const failures: { eventId: string; reason: string }[] = [];
  let escalationsAvoided = 0;
  let escalationsRedirected = 0;
  let escalationCostAvoided = 0;
  if (options.escalationModel) {
    const model = options.escalationModel;
    const costPerEvent = model.identity.costPerEventUsd ?? 0.002;
    // Still, silent events are never sent for a second opinion — and what that
    // saved is counted against the selection that would have been made with
    // them in, rather than assumed.
    const { decision, leftOutPicked, redirected } = selectLeavingOut(
      ordered.map((event) => {
        const draft = drafts.get(event.id)!;
        return {
          id: event.id,
          // Worth asking again where the cheap answer is unsure, where the event
          // is long, and where the decision is close to the line that decides
          // whether it survives at all.
          value:
            0.5 * (1 - draft.confidence) +
            0.3 * Math.min(1, ((event.end_ms - event.start_ms) / totalMs) * 20) +
            0.2 * (1 - Math.abs(draft.metrics.story_importance - 0.5) * 2),
          costUsd: costPerEvent,
        };
      }),
      quiet,
      withinBudget(options.escalation ?? {}, options.budget),
    );
    const wouldPay = (id: string): boolean =>
      options.cache?.peek(assessKey(model, states.get(id)!)) === undefined;
    escalationsRedirected = redirected.length;
    escalationsAvoided = Math.max(
      0,
      leftOutPicked.filter(wouldPay).length - redirected.filter(wouldPay).length,
    );
    escalationCostAvoided = escalationsAvoided * costPerEvent;

    const escalationRun = options.runs.record({
      stage: 'decision',
      backend: model.identity.backend,
      ...(model.identity.model === undefined ? {} : { model: model.identity.model }),
      locality: model.identity.locality,
      mediaLeavesDevice: model.identity.mediaLeavesDevice,
    });

    let done = 0;
    for (const eventId of decision.selected) {
      options.onProgress?.('reassess', done++, decision.selected.length);
      const state = states.get(eventId)!;

      // Cached like the cheap pass, which it was not: the escalation loop called
      // the model directly, so every re-analysis asked the hosted backend the
      // same nineteen questions about the same unchanged events and was charged
      // for them again. This is the expensive half of the run.
      const key = assessKey(model, state);
      const cached = options.cache?.get<Awaited<ReturnType<typeof assessEvent>>>(key);
      if (cached) {
        drafts.set(eventId, cached);
        producedBy.set(eventId, escalationRun);
        escalated.push(eventId);
        continue;
      }
      // Selected within what the budget had left; this is the line that holds
      // when a call cost more than it was expected to.
      if (options.budget && !options.budget.canAfford(costPerEvent)) break;

      // A second opinion that cannot be had is worth less than the cut.
      //
      // There was no catch here, so one 500 from a restarted local server threw
      // out of `compileProject` before the CLI ever reached `writeIr` — every
      // minute of transcription and every cheap judgement, lost, because an
      // optional model declined one question. The rule is that a missing model
      // costs that stage and not the run; this was the stage costing the run.
      let draft;
      try {
        options.budget?.spend(costPerEvent, `a second opinion on ${eventId}`);
        draft = await assessEvent(model, state);
      } catch (error) {
        // The cheap answer is already in `drafts` and `producedBy` still points
        // at the run that gave it, which is the truth about who answered.
        failures.push({ eventId, reason: error instanceof Error ? error.message : String(error) });
        // A dead endpoint should cost one request, not one per event.
        if (failures.length >= GIVE_UP_AFTER) break;
        continue;
      }
      options.cache?.set(key, draft);
      drafts.set(eventId, draft);
      producedBy.set(eventId, escalationRun);
      escalated.push(eventId);
      options.runs.addCost(
        escalationRun,
        draft.costUsd ?? costPerEvent,
        draft.inputTokens,
        draft.outputTokens,
      );
    }
  }

  const editorial: EventEditorial[] = ordered.map((event, index) => {
    const draft = drafts.get(event.id)!;

    const assessment: EditorialAssessment = {
      id: seqId('asm', index + 1),
      event_id: event.id,
      model_run_id: producedBy.get(event.id) ?? baseRun,
      metrics: { ...draft.metrics },
      flags: { ...draft.flags },
      narrative_role: draft.narrative_role,
      ...(draft.rationale ? { rationale: draft.rationale } : {}),
      confidence: draft.confidence,
    };

    // The user outranks the model, and the model's answer is kept beside the
    // override rather than replaced by it.
    const importance = event.knowledge.importance_override;
    const role = event.knowledge.narrative_role_override;
    if (importance !== undefined || role !== undefined) {
      const original: EditorialAssessment = {
        ...assessment,
        id: `${assessment.id}_model`,
        rationale: 'the model’s own assessment, kept because the user overrode it',
      };
      if (importance !== undefined) {
        assessment.metrics = { ...assessment.metrics, story_importance: importance };
        assessment.flags = {
          ...assessment.flags,
          preserve: Math.max(assessment.flags.preserve, importance),
        };
      }
      if (role !== undefined) {
        // The distribution is replaced rather than edited: the model's spread of
        // belief is about a question the user has now answered, and leaving it
        // beside a certain answer invites something downstream to average them.
        assessment.narrative_role = { selected: role, probabilities: { [role]: 1 } };
      }
      return { event_id: event.id, current: assessment, history: [original] };
    }

    return { event_id: event.id, current: assessment, history: [] };
  });

  if (failures.length > 0) {
    options.onDegraded?.(
      `the second opinion failed on ${failures.length} event(s); the rule-based judgement stands for them`,
      failures,
    );
  }

  return {
    editorial,
    escalated,
    failures,
    judgeCallsSkipped,
    estimatedTokensAvoided: skippedSizes.reduce((sum, size) => sum + baseRate.estimate(size), 0),
    judgeAsked,
    budgetStopped,
    ...(firstUnpaid === undefined ? {} : { budgetStoppedAt: firstUnpaid }),
    escalationsAvoided,
    escalationsRedirected,
    estimatedCostAvoidedUsd:
      judgeCallsSkipped * (paidCalls > 0 ? charged / paidCalls : baseCostPerEvent) +
      escalationCostAvoided,
  };
}

/** How many refusals before a second-opinion model is treated as gone. */
const GIVE_UP_AFTER = 3;

/** The key an assessment is cached under: the event state, and who was asked. */
function assessKey(
  model: EditorialDecisionModel,
  state: EventState,
): Parameters<PerceptionCache['get']>[0] {
  return {
    operation: 'assess',
    mediaSha256: hashObject({ ...state, event_id: undefined }),
    backend: model.identity.backend,
    ...(model.identity.model === undefined ? {} : { model: model.identity.model }),
    ...(model.identity.modelVersion === undefined
      ? {}
      : { modelVersion: model.identity.modelVersion }),
    pipelineVersion: PIPELINE_VERSION,
  };
}

/** Builds the structured state a decision backend sees. */
export function buildEventState(
  event: SemanticEvent,
  previous: SemanticEvent | undefined,
  next: SemanticEvent | undefined,
  relativePosition: number,
  options: { context: ProjectContext; maxSimilarity?: number },
): EventState {
  const { context } = options;
  return {
    event_id: event.id,
    duration_ms: event.end_ms - event.start_ms,
    relative_position: Math.min(1, Math.max(0, relativePosition)),
    observed: {
      // Subtitles are what was said, read off the picture. They used to reach
      // the judge as on-screen text; kept apart from it, they reached it as
      // nothing at all, and a subtitled montage with a music bed was judged a
      // stretch in which nobody said or showed anything — the rules' filler.
      speech: [...event.observed.speech.map((s) => s.text), ...(event.observed.subtitles ?? [])],
      visual_labels: event.observed.visual_labels,
      ocr: event.observed.ocr,
      audio: [...new Set(event.observed.audio.map((a) => a.type))],
      shot_count: event.observed.shot_count,
      speech_ratio: event.observed.speech_ratio,
      silence_ratio: event.observed.silence_ratio,
      ...(event.observed.technical_quality === undefined
        ? {}
        : { technical_quality: event.observed.technical_quality }),
    },
    semantic: {
      description: event.description.value,
      event_type: event.event_type.value,
      entities: {
        people: event.entities.value.people,
        places: event.entities.value.places,
        topics: event.entities.value.topics,
      },
      affect: event.affect.value,
    },
    ...(previous
      ? {
          previous_event: {
            description: previous.description.value,
            event_type: previous.event_type.value,
          },
        }
      : {}),
    ...(next
      ? { next_event: { description: next.description.value, event_type: next.event_type.value } }
      : {}),
    user_context: {
      ...(context.background.occasion ? { occasion: context.background.occasion } : {}),
      ...(context.editing_goal.instruction ? { goal: context.editing_goal.instruction } : {}),
      tone: context.editing_goal.tone,
      // The user wrote these in the file the product calls "the step that
      // matters" and nothing had ever read them. They reach the judge the same
      // way `tone` does: a backend that reasons can use them, and the rule-based
      // default ignores them, which is a property of that backend rather than of
      // the design.
      ...(context.editing_goal.audience ? { audience: context.editing_goal.audience } : {}),
      ...(context.editing_goal.opening.length > 0
        ? { wanted_opening: context.editing_goal.opening }
        : {}),
      ...(context.editing_goal.middle.length > 0
        ? { wanted_middle: context.editing_goal.middle }
        : {}),
      ...(context.editing_goal.ending.length > 0
        ? { wanted_ending: context.editing_goal.ending }
        : {}),
      notes: event.knowledge.notes,
      essential: event.knowledge.essential,
    },
    ...(options.maxSimilarity === undefined
      ? {}
      : { max_similarity_to_others: options.maxSimilarity }),
  };
}
