import {
  PIPELINE_VERSION,
  overlapMs,
  rangesOverlap,
  seqId,
  type AssetPlacement,
  type EventObservations,
  type MediaAsset,
  type ObservationTimeline,
  type Conflict,
  type PrepareResult,
  type ProjectContext,
  type SemanticEvent,
  type UserAnnotation,
} from '@editorial-ir/contracts';
import { HeuristicContextModel, type ContextModel } from '@editorial-ir/perception';
import type { SegmentDraft } from './segment.js';
import { annotationsFor, applyAnnotations, withOverrides } from './annotations.js';
import {
  TokenRate,
  promptChars,
  selectLeavingOut,
  withinBudget,
  type EscalationPolicy,
  type CostBudget,
} from './budget.js';
import type { ModelRunRecorder } from './model-runs.js';
import { framePathFor } from './observe.js';
import { linkKnownEntities, withKnownEntities } from './entities.js';
import type { PerceptionCache } from './cache.js';
import { hashObject } from './fingerprint.js';
import { inactiveMsWithin, isQuietRange, thinTimestamps, type InactiveSpan } from './activity.js';
import { distinctLines, textRoles, type TextRole } from './onscreen-text.js';

/**
 * Turning segments into events that mean something.
 *
 * Two passes, and the second is the point. Every event gets a cheap description
 * first; then the events where a better answer would actually change the edit —
 * the ones the cheap layer is unsure about, weighted by how much material they
 * occupy — are sent to the expensive model, within a budget.
 *
 * Running the good model over everything is the obvious design and the one that
 * makes an hour of footage cost more than the edit is worth. Running it nowhere
 * produces a timeline nobody trusts. The interesting engineering is in choosing.
 */
export interface BuildEventsOptions {
  assets: readonly MediaAsset[];
  placements: readonly AssetPlacement[];
  observations: ObservationTimeline;
  context: ProjectContext;
  annotations: readonly UserAnnotation[];
  runs: ModelRunRecorder;

  /** Runs over every event. Cheap and usually rule-based. */
  baseModel?: ContextModel;
  /** Runs over the events worth spending on. */
  escalationModel?: ContextModel;
  escalation?: EscalationPolicy;
  budget?: CostBudget;
  /** Derivative paths, so frames can be handed to a multimodal model. */
  derived?: Map<string, PrepareResult>;
  frameFps?: number;
  /**
   * Caches descriptions on what they actually depend on.
   *
   * Without this, editing one annotation re-runs the vision-language model over
   * every event in the project. The key is the describe call itself, so a change
   * to the occasion correctly re-describes everything — it changes what the
   * events mean — while a change to the target duration correctly costs nothing.
   */
  cache?: PerceptionCache;
  /**
   * Where the footage was both still and silent.
   *
   * An event that lies wholly inside such a span is described by the rules
   * rather than by the base model, and is never sent for a closer look; frames
   * for a closer look at any other event are not taken twice from one span. No
   * boundary and no time value depends on it — the events are already cut.
   */
  inactive?: readonly InactiveSpan[];

  onProgress?: (stage: string, done: number, total: number) => void;
  /**
   * The clock, so that a conflict's `detected_at` is reproducible.
   *
   * The compiler is supposed to turn the same input into the same output, and a
   * wall-clock timestamp on a recorded disagreement was one of the two things
   * that made that untrue for any project with an annotation the model argued
   * with.
   */
  now?: () => string;
}

/**
 * How many refusals before a context model is treated as gone.
 *
 * A dead endpoint should cost a handful of requests rather than one per event:
 * seventy-three timeouts is a long way to find out that a server is down.
 */
const GIVE_UP_AFTER = 3;

/**
 * What one multimodal look at an event is assumed to cost on a hosted model.
 *
 * An estimate, and labelled as one. It exists so `--budget` has something to
 * count before a provider has told anyone the price; the `input_tokens` and
 * `output_tokens` recorded alongside it are measured, and are what a real cost
 * figure should be computed from.
 */
const ESTIMATED_COST_PER_EVENT_USD = 0.004;

export interface BuildEventsResult {
  events: SemanticEvent[];
  conflicts: Conflict[];
  escalated: string[];
  /** Why escalation stopped where it did, for reporting to the user. */
  escalationLimitedBy: string;
  /**
   * Events a context model refused, and why.
   *
   * They keep the description they already had — the rule-based one, or the
   * fallback built from what was observed — so the compile continues. It is
   * reported rather than swallowed, because a description at confidence 0.15
   * standing in for a model's answer is a thing the user should be told about.
   */
  failures: { eventId: string; stage: string; reason: string }[];
  /**
   * How many events ended up with the fallback description rather than a
   * model's, whether or not each one produced its own failure entry.
   *
   * The failure list stops at {@link GIVE_UP_AFTER}, because listing the same
   * connection error eighty times helps nobody. What that hid is that the loop
   * also *stops*: with a model that had gone away, three failures were reported
   * and the remaining events were never attempted, so a run where every single
   * description came from a template looked like a run where three did.
   */
  describedByFallback: number;
  /**
   * Events the base model was meant to describe: every event, less the still,
   * silent ones the rules described instead. What `describedByFallback` is a
   * share of.
   *
   * Measured against every event, a dead model hid behind the quiet ones: with
   * 53 of 73 events described by the rules, a model that answered none of the
   * three calls it was sent — and was never sent the other seventeen — left 20
   * fallbacks among 73 events, under half, and the IR was stamped `standard`.
   */
  describeAsked: number;
  /** Events described from their observations because the cost limit had been reached. */
  budgetStopped: number;
  /** Model work not done because the event, or part of it, was still and silent. */
  savings: {
    /**
     * Events the rules described instead of the base model, where asking the
     * model would have cost something: one the cache would have answered for
     * free is not a saving.
     */
    describeCallsSkipped: number;
    /** Frames not attached to a closer look that was actually taken, because another from the same span was. */
    framesNotSent: number;
    /** Events that were quiet throughout, for the judgement stage to read. */
    quietEvents: string[];
    /** An estimate: each skipped call priced by its own prompt, at this run's measured tokens per character. */
    estimatedTokensAvoided: number;
    /** Closer looks the quiet events would have taken, net of the ones given to other events instead. */
    escalationsAvoided: number;
    /** Closer looks given to other events because the quiet ones were not candidates. */
    escalationsRedirected: number;
    /** An estimate, from the per-event cost each pass already charges. */
    estimatedCostAvoidedUsd: number;
  };
}

export async function buildSemanticEvents(
  drafts: readonly SegmentDraft[],
  options: BuildEventsOptions,
): Promise<BuildEventsResult> {
  const placementOf = new Map(options.placements.map((p) => [p.asset_id, p.offset_ms]));
  const ordered = [...drafts].sort((a, b) => {
    const offsetA = placementOf.get(a.asset_id) ?? 0;
    const offsetB = placementOf.get(b.asset_id) ?? 0;
    return offsetA + a.start_ms - (offsetB + b.start_ms);
  });

  // ---- observations --------------------------------------------------------
  // Which text is a subtitle is a property of the whole file, so it is decided
  // once rather than once per event.
  const roles = textRoles(options.observations.ocr);
  const skeletons = ordered.map((draft, index) => {
    const offset = placementOf.get(draft.asset_id) ?? 0;
    return {
      draft,
      id: seqId('evt', index + 1),
      startMs: offset + draft.start_ms,
      endMs: offset + draft.end_ms,
      observed: gatherObservations(draft, options.observations, options.inactive, roles),
    };
  });

  // ---- still and silent ----------------------------------------------------
  // Quiet as a whole, and not pointed at by the user. An annotation on the
  // project as a whole says nothing about this span, so it does not count; one
  // on this asset, this range or this event does, because the user looking at
  // a lens cap is a reason to describe it properly.
  const quiet = new Set<string>();
  for (const skeleton of skeletons) {
    if (!options.inactive || options.inactive.length === 0) break;
    const { asset_id, start_ms, end_ms } = skeleton.draft;
    if (!isQuietRange(options.inactive, asset_id, start_ms, end_ms)) continue;
    const pointedAt = annotationsFor(
      {
        id: skeleton.id,
        start_ms: skeleton.startMs,
        end_ms: skeleton.endMs,
        source_ranges: [{ asset_id, source_in_ms: start_ms, source_out_ms: end_ms }],
      } as SemanticEvent,
      options.annotations,
      placementOf.get(asset_id) ?? 0,
    ).some((annotation) => annotation.target.kind !== 'project');
    if (!pointedAt) quiet.add(skeleton.id);
  }
  let describeCallsSkipped = 0;
  const framesSkipped = { count: 0 };
  // Prompt sizes and the tokens they measured, which is what a call not made is
  // priced from. Nothing measured, nothing estimated.
  const baseRate = new TokenRate();
  const skippedSizes: number[] = [];
  let baseCostPerEvent = 0;
  // Which run produced a description, where it was not the base model's own.
  const describedBy = new Map<string, string>();
  let describeAsked = skeletons.length;
  let describedByModel = 0;
  let budgetStopped = 0;
  let describing = 0;

  // ---- cheap pass ----------------------------------------------------------
  const descriptions = new Map<string, Awaited<ReturnType<ContextModel['describe']>>>();
  const failures: { eventId: string; stage: string; reason: string }[] = [];
  if (options.baseModel) {
    const model = options.baseModel;
    const baseRun = options.runs.fromIdentity('context', model.identity);
    // What the base pass costs, which was not being counted at all.
    //
    // `addCost` was called only in the escalation branch below, so a run whose
    // descriptions all came from the base model recorded no tokens and no cost —
    // and that is the ordinary case, because a model on this machine is made the
    // base model precisely so it can describe every event. An eleven-event run
    // against a local model reported "cost: nothing" having made eleven calls.
    //
    // Zero for a model on this machine, because it is. For a hosted one this
    // is an estimate and the tokens beside it are not — which is the right way
    // round: a price per token is a property of whichever provider you chose,
    // and the token count is a property of this pipeline.
    baseCostPerEvent = model.identity.locality === 'remote_api' ? ESTIMATED_COST_PER_EVENT_USD : 0;
    // Only worth doing when the base model is a model. When it is already the
    // rules, asking the rules instead saves nothing and would be counted as a
    // saving that never happened.
    const rules = model.identity.standIn === undefined ? new HeuristicContextModel() : undefined;

    // The quiet events first, and on their own. Inside the model's loop they
    // were counted as described, which diluted a dead model's failures below
    // the line the tier is drawn at, and they sat between the model and the
    // events it had not yet been asked about when it gave up.
    if (rules && quiet.size > 0) {
      const rulesRun = options.runs.fromIdentity('context', rules.identity);
      for (const [index, skeleton] of skeletons.entries()) {
        if (!quiet.has(skeleton.id)) continue;
        options.onProgress?.('describe', describing++, skeletons.length);
        const params = describeParams(skeleton, skeletons, index, options, {
          includeFrames: false,
        });
        // The model's own description, when the cache already holds it, costs
        // nothing and says more than the rules can: a re-run of an analysis made
        // without the mask keeps it, and nothing is counted as saved.
        const known = options.cache?.peek<Awaited<ReturnType<ContextModel['describe']>>>(
          describeKey(model, params),
        );
        if (known) {
          descriptions.set(skeleton.id, known);
          continue;
        }
        // Described from what was measured, which for a still, silent stretch is
        // all there is to say. Not a fallback and not a failure: the model was
        // there and was not asked, and `savings` says so.
        descriptions.set(skeleton.id, await rules.describe(params));
        describedBy.set(skeleton.id, rulesRun);
        describeCallsSkipped++;
        skippedSizes.push(promptChars(stableParams(params)));
      }
      describeAsked = skeletons.length - quiet.size;
    }

    // What `--budget` was documented to bound and did not: `spend` was called
    // only for the closer looks, so a hosted model describing every event
    // (OEA_VLM_SCOPE=base) spent past any limit. Past the limit the pass stops
    // asking; an answer the cache holds is still free and still taken.
    let budgetReached = false;
    let firstUnpaid: string | undefined;
    for (const [index, skeleton] of skeletons.entries()) {
      if (rules && quiet.has(skeleton.id)) continue;
      options.onProgress?.('describe', describing++, skeletons.length);
      const params = describeParams(skeleton, skeletons, index, options, { includeFrames: false });
      const key = describeKey(model, params);
      const hit = options.cache?.get<Awaited<ReturnType<ContextModel['describe']>>>(key);
      if (hit) {
        descriptions.set(skeleton.id, hit);
        describedByModel++;
        baseRate.observe(promptChars(stableParams(params)), hit.input_tokens, hit.output_tokens);
        continue;
      }
      if (budgetReached || (options.budget && !options.budget.canAfford(baseCostPerEvent))) {
        budgetReached = true;
        budgetStopped++;
        firstUnpaid ??= skeleton.id;
        continue;
      }
      try {
        const result = await model.describe(params);
        options.cache?.set(key, result);
        descriptions.set(skeleton.id, result);
        describedByModel++;
        baseRate.observe(
          promptChars(stableParams(params)),
          result.input_tokens,
          result.output_tokens,
        );
        options.budget?.charge(baseCostPerEvent);
        options.runs.addCost(baseRun, baseCostPerEvent, result.input_tokens, result.output_tokens);
      } catch (error) {
        // Leave the map empty for this one and let `fallbackDescription` below
        // do the job it was written for, at confidence 0.15 — the honest record
        // of what happened. There was no catch here, so one refusal from an
        // optional model threw out of the whole compile and the user got no
        // timeline and no plan at all.
        failures.push({
          eventId: skeleton.id,
          stage: 'describe',
          reason: error instanceof Error ? error.message : String(error),
        });
        if (failures.length >= GIVE_UP_AFTER) break;
      }
    }
    if (firstUnpaid !== undefined) {
      failures.push({
        eventId: firstUnpaid,
        stage: 'describe',
        reason: `the cost limit of $${options.budget?.limit} was reached; ${budgetStopped} event(s) from here on were described from what was observed`,
      });
    }
  } else {
    describeAsked = 0;
  }
  // Counted after the loop rather than inside it, so that giving up early is
  // included: what matters downstream is how many of the events the model was
  // meant to describe have its description, not how many errors were worth
  // printing.
  const describedByFallback = options.baseModel
    ? describeAsked - describedByModel
    : skeletons.length - descriptions.size;

  // ---- escalation ----------------------------------------------------------
  const escalated: string[] = [];
  let limitedBy = 'nothing';
  let escalationsAvoided = 0;
  let escalationsRedirected = 0;
  let escalationCostAvoided = 0;
  if (options.escalationModel) {
    const model = options.escalationModel;
    // Free when the closer look runs on this machine, for the same reason the
    // base pass is: it is. Reporting "$0.01" for a run that spent nothing and
    // sent nothing anywhere is the same falsified provenance as reporting a
    // hosted stage as local, one field over. Escalation stays bounded without
    // it — `selectForEscalation` limits by count and by value as well as cost.
    const costPerEvent =
      model.identity.locality === 'remote_api' ? ESTIMATED_COST_PER_EVENT_USD : 0;
    const totalDuration = skeletons.reduce((sum, s) => sum + (s.endMs - s.startMs), 0) || 1;
    const indexOf = new Map(skeletons.map((skeleton, index) => [skeleton.id, index]));
    const lookParams = (id: string) => {
      const index = indexOf.get(id)!;
      return describeParams(skeletons[index]!, skeletons, index, options, { includeFrames: true });
    };
    const wouldPay = (id: string) =>
      options.cache?.peek(describeKey(model, lookParams(id))) === undefined;

    // A closer look at a lens cap finds a lens cap. Selected twice — once as it
    // is, once as it would have been with the quiet events in — so that leaving
    // them out is counted rather than assumed.
    const { decision, leftOutPicked, redirected } = selectLeavingOut(
      skeletons.map((skeleton) => ({
        id: skeleton.id,
        value: escalationValue(
          descriptions.get(skeleton.id)?.confidence ?? 0,
          (skeleton.endMs - skeleton.startMs) / totalDuration,
          skeleton.observed,
        ),
        costUsd: costPerEvent,
      })),
      quiet,
      withinBudget(options.escalation ?? {}, options.budget),
    );
    limitedBy = decision.limitedBy;
    escalationsRedirected = redirected.length;
    escalationsAvoided = Math.max(
      0,
      leftOutPicked.filter(wouldPay).length - redirected.filter(wouldPay).length,
    );
    escalationCostAvoided = escalationsAvoided * costPerEvent;

    const runId = options.runs.fromIdentity('context', model.identity);
    const selected = new Set(decision.selected);
    let done = 0;
    for (const [index, skeleton] of skeletons.entries()) {
      if (!selected.has(skeleton.id)) continue;
      options.onProgress?.('inspect', done++, decision.selected.length);

      // Frames thinned from this look are counted only if the look is taken:
      // an answer from the cache sends no frames at all, so none were saved.
      const thinned = { count: 0 };
      const params = describeParams(skeleton, skeletons, index, options, {
        includeFrames: true,
        framesSkipped: thinned,
      });
      // One lookup. This asked the cache once here and again inside the call
      // below, so every look actually taken was counted as two misses.
      const key = describeKey(model, params);
      const cached = options.cache?.get<Awaited<ReturnType<ContextModel['describe']>>>(key);
      if (!cached && options.budget && !options.budget.canAfford(costPerEvent)) {
        limitedBy = 'cost';
        break;
      }

      let result;
      try {
        if (cached) {
          result = cached;
        } else {
          // Only spend from the budget when the call is actually going to happen.
          options.budget?.spend(costPerEvent, `a closer look at ${skeleton.id}`);
          result = await model.describe(params);
          options.cache?.set(key, result);
          framesSkipped.count += thinned.count;
        }
      } catch (error) {
        // The cheap description already in the map stands. A closer look that
        // could not be taken is worth less than the analysis.
        failures.push({
          eventId: skeleton.id,
          stage: 'inspect',
          reason: error instanceof Error ? error.message : String(error),
        });
        if (failures.filter((f) => f.stage === 'inspect').length >= GIVE_UP_AFTER) break;
        continue;
      }
      descriptions.set(skeleton.id, result);
      escalated.push(skeleton.id);
      if (!cached)
        options.runs.addCost(runId, costPerEvent, result.input_tokens, result.output_tokens);
    }
  }

  // ---- assemble ------------------------------------------------------------
  const events: SemanticEvent[] = [];
  const conflicts: BuildEventsResult['conflicts'] = [];

  for (const skeleton of skeletons) {
    const described = descriptions.get(skeleton.id);
    const isEscalated = escalated.includes(skeleton.id);

    const event: SemanticEvent = {
      id: skeleton.id,
      start_ms: skeleton.startMs,
      end_ms: skeleton.endMs,
      source_ranges: [
        {
          asset_id: skeleton.draft.asset_id,
          source_in_ms: skeleton.draft.start_ms,
          source_out_ms: skeleton.draft.end_ms,
        },
      ],
      description: {
        value: described?.description ?? fallbackDescription(skeleton.observed),
        provenance: 'inferred',
        confidence: described?.confidence ?? 0.15,
        // The rules' run on a quiet event, so the IR says who described it; every
        // other event exactly as before.
        ...(described ? { model_run_id: describedBy.get(skeleton.id) } : {}),
      },
      event_type: {
        value: described?.event_type || 'moment',
        provenance: 'inferred',
        confidence: described?.confidence ?? 0.15,
      },
      ...(described?.title
        ? {
            title: {
              value: described.title,
              provenance: 'inferred' as const,
              confidence: described.confidence,
            },
          }
        : {}),
      entities: {
        // What the user named, found where it is mentioned, merged with what the
        // model found. Both are inferred — the vocabulary is the user's, but the
        // claim "this is in this event" is ours — and the user's ids go first
        // because they are the ones a skill rule and a reader use.
        value: withKnownEntities(
          {
            people: described?.entities.people ?? [],
            places: described?.entities.places ?? [],
            objects: described?.entities.objects ?? [],
            topics: described?.entities.topics ?? [],
            organisations: [],
          },
          linkKnownEntities(
            {
              // A subtitle is what was said, so a name in one is a mention.
              speech: [
                ...skeleton.observed.speech.map((utterance) => utterance.text),
                ...(skeleton.observed.subtitles ?? []),
              ],
              ocr: skeleton.observed.ocr,
              visual_labels: skeleton.observed.visual_labels,
              ...(described?.description ? { description: described.description } : {}),
            },
            options.context,
          ),
        ),
        provenance: 'inferred',
      },
      affect: { value: described?.affect ?? {}, provenance: 'inferred' },
      observed: skeleton.observed,
      knowledge: { notes: [], essential: false, excluded: false, annotation_refs: [] },
      segmentation: {
        method: skeleton.draft.method,
        boundary_confidence: skeleton.draft.boundary_confidence,
      },
      embedding_refs: [],
      // An escalated event was looked at properly; a cheap one was guessed at.
      confidence: described ? described.confidence : 0.15,
    };

    const applicable = annotationsFor(
      event,
      options.annotations,
      placementOf.get(skeleton.draft.asset_id) ?? 0,
    );
    // The events are walked in a fixed order, so numbering conflicts as they
    // are found makes their ids reproducible; `now` comes from the caller for
    // the same reason. A wall-clock timestamp and a random id meant a project
    // with any correction the model disagreed with never compiled to the same
    // IR twice.
    const applied = applyAnnotations(
      event,
      applicable,
      options.context.background.occasion,
      options.now,
      conflicts.length,
    );
    conflicts.push(...applied.conflicts);
    events.push(withOverrides(event, applied));

    void isEscalated;
  }

  return {
    events,
    conflicts,
    escalated,
    escalationLimitedBy: limitedBy,
    failures,
    describedByFallback,
    describeAsked,
    budgetStopped,
    savings: {
      describeCallsSkipped,
      framesNotSent: framesSkipped.count,
      quietEvents: [...quiet],
      estimatedTokensAvoided: skippedSizes.reduce((sum, size) => sum + baseRate.estimate(size), 0),
      escalationsAvoided,
      escalationsRedirected,
      estimatedCostAvoidedUsd: describeCallsSkipped * baseCostPerEvent + escalationCostAvoided,
    },
  };
}

/**
 * The key a description is cached under.
 *
 * Everything the model will be shown, plus which model it is. Frame *paths* are
 * excluded because the same event analysed from a different working directory is
 * the same call; whether frames were sent at all is not, because a description
 * from four frames is a different thing from one from a transcript alone. The
 * event id is excluded for the same reason: segmentation renumbers events, and
 * a description of unchanged material should survive that.
 */
export function describeKey(
  model: ContextModel,
  params: Parameters<ContextModel['describe']>[0],
): Parameters<PerceptionCache['get']>[0] {
  const stable = stableParams(params);
  const { frame_paths } = params;
  return {
    operation: 'describe',
    // Which frames, by where they sit under the project rather than the whole
    // path. Leaving them out entirely made two events with the same words share
    // one answer whatever their pictures showed: measured, an active stretch
    // was handed the description of the frozen minute before it, because
    // neither had speech and "with frames" was all the key said about them.
    mediaSha256: hashObject({ ...stable, frames: frame_paths.map(frameIdentity) }),
    backend: model.identity.backend,
    ...(model.identity.model === undefined ? {} : { model: model.identity.model }),
    ...(model.identity.modelVersion === undefined
      ? {}
      : { modelVersion: model.identity.modelVersion }),
    parameters: { with_frames: frame_paths.length > 0 },
    pipelineVersion: PIPELINE_VERSION,
  };
}

/**
 * A frame file by what identifies its content: the media's work directory,
 * which is named for its hash, and the file within it. Stable when the project
 * moves, different for every frame of every file.
 */
function frameIdentity(path: string): string {
  return path.split(/[\\/]/).slice(-3).join('/');
}

/** What a describe call is about, without what only locates it: the event id and the frame paths. */
function stableParams(params: Parameters<ContextModel['describe']>[0]) {
  const { frame_paths: _frames, event_id: _event_id, ...stable } = params;
  return stable;
}

/**
 * How much a closer look at this event is worth.
 *
 * Uncertainty dominates, because a confident cheap answer is usually right.
 * Duration matters because a long event occupies more of the edit, and speech
 * matters because an event with words in it has more that can be misread.
 */
export function escalationValue(
  confidence: number,
  durationShare: number,
  observed: EventObservations,
): number {
  const uncertainty = 1 - confidence;
  // Subtitles are words that were said, and as easy to misread in context.
  const speech = observed.speech.length > 0 || (observed.subtitles?.length ?? 0) > 0 ? 0.2 : 0;
  const onScreen = observed.ocr.length > 0 ? 0.1 : 0;
  return 0.6 * uncertainty + 0.3 * Math.min(1, durationShare * 20) + speech + onScreen;
}

type Skeleton = {
  draft: SegmentDraft;
  id: string;
  startMs: number;
  endMs: number;
  observed: EventObservations;
};

function describeParams(
  skeleton: Skeleton,
  all: readonly Skeleton[],
  index: number,
  options: BuildEventsOptions,
  flags: { includeFrames: boolean; framesSkipped?: { count: number } },
) {
  const previous = index > 0 ? all[index - 1] : undefined;
  const next = all[index + 1];

  const framePaths = flags.includeFrames ? framesFor(skeleton, options, flags.framesSkipped) : [];

  return {
    event_id: skeleton.id,
    frame_paths: framePaths,
    transcript: skeleton.observed.speech.map((s) => s.text),
    ocr: skeleton.observed.ocr,
    // Only when there are some, so every key cached before subtitles were told
    // apart from other text is still the key of the same call.
    ...(skeleton.observed.subtitles?.length ? { subtitles: skeleton.observed.subtitles } : {}),
    audio_tags: skeleton.observed.audio.map((a) => a.type),
    visual_labels: skeleton.observed.visual_labels,
    ...(previous ? { previous_summary: fallbackDescription(previous.observed) } : {}),
    ...(next ? { next_summary: fallbackDescription(next.observed) } : {}),
    user_context: userContextFor(options.context),
    ...(options.context.editing_goal.language
      ? { language: options.context.editing_goal.language }
      : {}),
  };
}

function framesFor(
  skeleton: Skeleton,
  options: BuildEventsOptions,
  skipped?: { count: number },
): string[] {
  const prepared = options.derived?.get(skeleton.draft.asset_id);
  // A still is its own frame, and one look at it is all there is: four copies
  // of the same photo would cost four images and say nothing a second time.
  const asset = options.assets.find((a) => a.id === skeleton.draft.asset_id);
  if (asset?.kind === 'image') return prepared?.proxy_path ? [prepared.proxy_path] : [];
  if (!prepared?.frames_dir) return [];
  const fps = options.frameFps ?? 1;

  // Four frames: the start, two through the middle and the end. More rarely
  // changes the answer and every one of them costs money on a hosted model.
  const span = skeleton.draft.end_ms - skeleton.draft.start_ms;
  const all = [0.1, 0.35, 0.65, 0.9].map((fraction) =>
    Math.round(skeleton.draft.start_ms + span * fraction),
  );
  // Two frames of the same still, silent stretch are one frame sent twice.
  const { kept: points, dropped } = thinTimestamps(
    all,
    options.inactive ?? [],
    skeleton.draft.asset_id,
  );
  if (skipped) skipped.count += dropped;
  return points
    .map((ms) => framePathFor(prepared, ms, fps))
    .filter((path): path is string => path !== undefined);
}

function userContextFor(context: ProjectContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (context.background.occasion) out.occasion = context.background.occasion;
  if (context.background.summary) out.summary = context.background.summary;
  if (context.background.people.length > 0) {
    out.people = context.background.people.map((p) => ({ id: p.id, role: p.role }));
  }
  if (context.background.places.length > 0) out.places = context.background.places.map((p) => p.id);
  if (context.editing_goal.instruction) out.goal = context.editing_goal.instruction;
  if (context.editing_goal.tone.length > 0) out.tone = context.editing_goal.tone;
  if (context.editing_goal.audience) out.audience = context.editing_goal.audience;
  const wanted = {
    opening: context.editing_goal.opening,
    middle: context.editing_goal.middle,
    ending: context.editing_goal.ending,
  };
  if (Object.values(wanted).some((words) => words.length > 0)) out.wanted = wanted;
  return out;
}

/** What the observations alone say, used as a neighbour summary and as a fallback. */
function fallbackDescription(observed: EventObservations): string {
  const speech = observed.speech.map((s) => s.text).join(' ');
  if (speech.trim().length > 0) return speech.slice(0, 120);
  const subtitles = (observed.subtitles ?? []).join(' ');
  if (subtitles.trim().length > 0) return subtitles.slice(0, 120);
  if (observed.visual_labels.length > 0) return observed.visual_labels.slice(0, 4).join(', ');
  if (observed.ocr.length > 0) return observed.ocr.slice(0, 2).join(' / ');
  return 'no speech or on-screen text';
}

/**
 * Collects every observation that falls inside a segment.
 *
 * Denormalised onto the event on purpose: an event has to be reviewable on its
 * own, including by an agent that is only allowed to see events.
 *
 * Text read off the picture is split by what it is (see `onscreen-text.ts`):
 * subtitles go to `subtitles`, once per line; counters and timecodes burned
 * into the picture go nowhere; everything else is `ocr`, once per line however
 * OCR spaced it. A read with no box is scene text, which is every read in the
 * worked example.
 */
export function gatherObservations(
  draft: SegmentDraft,
  observations: ObservationTimeline,
  inactive?: readonly InactiveSpan[],
  roles: ReadonlyMap<string, TextRole> = textRoles(observations.ocr),
): EventObservations {
  const range = { start_ms: draft.start_ms, end_ms: draft.end_ms };
  const duration = Math.max(1, draft.end_ms - draft.start_ms);
  const inAsset = <T extends { asset_id: string }>(items: readonly T[]): T[] =>
    items.filter((item) => item.asset_id === draft.asset_id);

  const speech = inAsset(observations.utterances)
    .filter((utterance) => rangesOverlap(utterance, range))
    .sort((a, b) => a.start_ms - b.start_ms)
    .map((utterance) => ({
      text: utterance.text,
      start_ms: utterance.start_ms,
      end_ms: utterance.end_ms,
      ...(utterance.speaker_id === undefined ? {} : { speaker_id: utterance.speaker_id }),
      confidence: utterance.confidence,
    }));

  const audio = inAsset(observations.audio_events)
    .filter((event) => rangesOverlap(event, range))
    .map((event) => ({ type: event.event_type, confidence: event.confidence }));

  const reads = inAsset(observations.ocr).filter((observation) =>
    rangesOverlap(observation, range),
  );
  const ocr = distinctLines(
    reads.filter((read) => roles.get(read.id) === 'scene').map((read) => read.text),
  );
  const subtitles = distinctLines(
    reads.filter((read) => roles.get(read.id) === 'subtitle').map((read) => read.text),
  );

  const frames = inAsset(observations.frame_features).filter(
    (frame) => frame.timestamp_ms >= range.start_ms && frame.timestamp_ms < range.end_ms,
  );

  const labels = [...new Set(frames.flatMap((frame) => frame.labels))];

  const speechMs = speech.reduce((sum, s) => sum + overlapMs(s, range), 0);
  const silenceMs = inAsset(observations.audio_events)
    .filter((event) => event.event_type === 'silence')
    .reduce((sum, event) => sum + overlapMs(event, range), 0);

  const inactiveRatio = inactive
    ? clamp(inactiveMsWithin(inactive, draft.asset_id, draft.start_ms, draft.end_ms) / duration)
    : 0;

  const motions = frames.map((f) => f.motion).filter((m): m is number => m !== undefined);
  const qualities = frames
    .map((f) => averageDefined([f.sharpness, f.exposure]))
    .filter((q): q is number => q !== undefined);

  return {
    speech,
    visual_labels: labels,
    ocr,
    audio,
    shot_ids: draft.shot_ids,
    shot_count: Math.max(draft.shot_ids.length, 1),
    speech_ratio: clamp(speechMs / duration),
    silence_ratio: clamp(silenceMs / duration),
    // Only when there are some, for the same reason as the ratio below.
    ...(subtitles.length > 0 ? { subtitles } : {}),
    ...(motions.length > 0 ? { motion: clamp(average(motions)) } : {}),
    ...(qualities.length > 0 ? { technical_quality: clamp(average(qualities)) } : {}),
    // Only when there is some: an absent field and a zero say the same thing,
    // and an absent one leaves every event of a project with no still, silent
    // footage exactly as it was, cache keys included.
    ...(inactiveRatio > 0 ? { inactive_ratio: round3(inactiveRatio) } : {}),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function averageDefined(values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length === 0 ? undefined : average(present);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
