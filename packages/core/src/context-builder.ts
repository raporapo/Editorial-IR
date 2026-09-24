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
import { selectForEscalation, type EscalationPolicy, type CostBudget } from './budget.js';
import type { ModelRunRecorder } from './model-runs.js';
import { framePathFor } from './observe.js';
import { linkKnownEntities, withKnownEntities } from './entities.js';
import type { PerceptionCache } from './cache.js';
import { hashObject } from './fingerprint.js';
import { inactiveMsWithin, isQuietRange, thinTimestamps, type InactiveSpan } from './activity.js';

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
  /** Model work not done because the event, or part of it, was still and silent. */
  savings: {
    /** Events the rules described instead of the base model. */
    describeCallsSkipped: number;
    /** Frames not attached to a closer look because another one from the same span was. */
    framesNotSent: number;
    /** Events that were quiet throughout, for the judgement stage to read. */
    quietEvents: string[];
    /** Skipped calls times the tokens measured per base call in this run. */
    estimatedTokensAvoided: number;
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
  const skeletons = ordered.map((draft, index) => {
    const offset = placementOf.get(draft.asset_id) ?? 0;
    return {
      draft,
      id: seqId('evt', index + 1),
      startMs: offset + draft.start_ms,
      endMs: offset + draft.end_ms,
      observed: gatherObservations(draft, options.observations, options.inactive),
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
  // Measured tokens per base call this run, which is what an estimate of the
  // calls not made is scaled from. Nothing measured, nothing estimated.
  let baseCalls = 0;
  let baseTokens = 0;

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
    // It is not only a reporting gap. `OEA_VLM_SCOPE=base` is documented as the
    // way to have a *hosted* model describe everything, and with the base pass
    // uncounted `--budget` could not see that spending at all — a limit that
    // does not bind is worse than no limit, because the documentation promises
    // it does.
    // Zero for a model on this machine, because it is. For a hosted one this
    // is an estimate and the tokens beside it are not — which is the right way
    // round: a price per token is a property of whichever provider you chose,
    // and the token count is a property of this pipeline.
    const baseCostPerEvent =
      model.identity.locality === 'remote_api' ? ESTIMATED_COST_PER_EVENT_USD : 0;
    // Only worth doing when the base model is a model. When it is already the
    // rules, asking the rules instead saves nothing and would be counted as a
    // saving that never happened.
    const rules = model.identity.standIn === undefined ? new HeuristicContextModel() : undefined;
    for (const [index, skeleton] of skeletons.entries()) {
      options.onProgress?.('describe', index, skeletons.length);
      const params = describeParams(skeleton, skeletons, index, options, { includeFrames: false });
      if (rules && quiet.has(skeleton.id)) {
        // Described from what was measured, which for a still, silent stretch is
        // all there is to say. Not a fallback and not a failure: the model was
        // there and was not asked, and `savings` says so.
        descriptions.set(skeleton.id, await rules.describe(params));
        describeCallsSkipped++;
        continue;
      }
      try {
        const { result, cached } = await describeCached(model, params, options.cache);
        descriptions.set(skeleton.id, result);
        // A cache hit is free, which is the whole point of the cache; counting
        // it would make a re-run look as expensive as the first one.
        if (!cached) {
          baseCalls++;
          baseTokens += (result.input_tokens ?? 0) + (result.output_tokens ?? 0);
          options.runs.addCost(
            baseRun,
            baseCostPerEvent,
            result.input_tokens,
            result.output_tokens,
          );
        }
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
  }
  // Counted after the loop rather than inside it, so that giving up early is
  // included: what matters downstream is how many events have a model's
  // description, not how many errors were worth printing.
  const describedByFallback = skeletons.length - descriptions.size;

  // ---- escalation ----------------------------------------------------------
  const escalated: string[] = [];
  let limitedBy = 'nothing';
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

    const decision = selectForEscalation(
      // A closer look at a lens cap finds a lens cap.
      skeletons
        .filter((skeleton) => !quiet.has(skeleton.id))
        .map((skeleton) => ({
          id: skeleton.id,
          value: escalationValue(
            descriptions.get(skeleton.id)?.confidence ?? 0,
            (skeleton.endMs - skeleton.startMs) / totalDuration,
            skeleton.observed,
          ),
          costUsd: costPerEvent,
        })),
      options.escalation ?? {},
    );
    limitedBy = decision.limitedBy;

    const runId = options.runs.fromIdentity('context', model.identity);
    const selected = new Set(decision.selected);
    let done = 0;
    for (const [index, skeleton] of skeletons.entries()) {
      if (!selected.has(skeleton.id)) continue;
      options.onProgress?.('inspect', done++, decision.selected.length);

      const params = describeParams(skeleton, skeletons, index, options, {
        includeFrames: true,
        framesSkipped,
      });
      const cached = options.cache?.get<Awaited<ReturnType<ContextModel['describe']>>>(
        describeKey(model, params),
      );
      // Only spend from the budget when the call is actually going to happen.
      if (!cached) options.budget?.spend(costPerEvent, `a closer look at ${skeleton.id}`);

      let result;
      try {
        result = cached ?? (await describeCached(model, params, options.cache)).result;
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
        ...(described ? { model_run_id: undefined } : {}),
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
              speech: skeleton.observed.speech.map((utterance) => utterance.text),
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
    savings: {
      describeCallsSkipped,
      framesNotSent: framesSkipped.count,
      quietEvents: [...quiet],
      estimatedTokensAvoided:
        baseCalls > 0 ? Math.round((describeCallsSkipped * baseTokens) / baseCalls) : 0,
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
  const { frame_paths, event_id: _event_id, ...stable } = params;
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

/** The description, and whether it cost anything to get. */
async function describeCached(
  model: ContextModel,
  params: Parameters<ContextModel['describe']>[0],
  cache: PerceptionCache | undefined,
): Promise<{ result: Awaited<ReturnType<ContextModel['describe']>>; cached: boolean }> {
  const key = describeKey(model, params);
  const hit = cache?.get<Awaited<ReturnType<ContextModel['describe']>>>(key);
  if (hit) return { result: hit, cached: true };
  const result = await model.describe(params);
  cache?.set(key, result);
  return { result, cached: false };
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
  const speech = observed.speech.length > 0 ? 0.2 : 0;
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
  if (observed.visual_labels.length > 0) return observed.visual_labels.slice(0, 4).join(', ');
  if (observed.ocr.length > 0) return observed.ocr.slice(0, 2).join(' / ');
  return 'no speech or on-screen text';
}

/**
 * Collects every observation that falls inside a segment.
 *
 * Denormalised onto the event on purpose: an event has to be reviewable on its
 * own, including by an agent that is only allowed to see events.
 */
export function gatherObservations(
  draft: SegmentDraft,
  observations: ObservationTimeline,
  inactive?: readonly InactiveSpan[],
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

  const ocr = [
    ...new Set(
      inAsset(observations.ocr)
        .filter((observation) => rangesOverlap(observation, range))
        .map((observation) => observation.text),
    ),
  ];

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
