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
import type { ContextModel } from '@editorial-ir/perception';
import type { SegmentDraft } from './segment.js';
import { annotationsFor, applyAnnotations, withOverrides } from './annotations.js';
import { selectForEscalation, type EscalationPolicy, type CostBudget } from './budget.js';
import type { ModelRunRecorder } from './model-runs.js';
import { framePathFor } from './observe.js';
import { linkKnownEntities, withKnownEntities } from './entities.js';
import type { PerceptionCache } from './cache.js';
import { hashObject } from './fingerprint.js';

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
      observed: gatherObservations(draft, options.observations),
    };
  });

  // ---- cheap pass ----------------------------------------------------------
  const descriptions = new Map<string, Awaited<ReturnType<ContextModel['describe']>>>();
  const failures: { eventId: string; stage: string; reason: string }[] = [];
  if (options.baseModel) {
    const model = options.baseModel;
    options.runs.fromIdentity('context', model.identity);
    for (const [index, skeleton] of skeletons.entries()) {
      options.onProgress?.('describe', index, skeletons.length);
      const params = describeParams(skeleton, skeletons, index, options, { includeFrames: false });
      try {
        descriptions.set(skeleton.id, await describeCached(model, params, options.cache));
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

  // ---- escalation ----------------------------------------------------------
  const escalated: string[] = [];
  let limitedBy = 'nothing';
  if (options.escalationModel) {
    const model = options.escalationModel;
    const costPerEvent = 0.004;
    const totalDuration = skeletons.reduce((sum, s) => sum + (s.endMs - s.startMs), 0) || 1;

    const decision = selectForEscalation(
      skeletons.map((skeleton) => ({
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

      const params = describeParams(skeleton, skeletons, index, options, { includeFrames: true });
      const cached = options.cache?.get<Awaited<ReturnType<ContextModel['describe']>>>(
        describeKey(model, params),
      );
      // Only spend from the budget when the call is actually going to happen.
      if (!cached) options.budget?.spend(costPerEvent, `a closer look at ${skeleton.id}`);

      let result;
      try {
        result = cached ?? (await describeCached(model, params, options.cache));
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

  return { events, conflicts, escalated, escalationLimitedBy: limitedBy, failures };
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
function describeKey(
  model: ContextModel,
  params: Parameters<ContextModel['describe']>[0],
): Parameters<PerceptionCache['get']>[0] {
  const { frame_paths, event_id: _event_id, ...stable } = params;
  return {
    operation: 'describe',
    mediaSha256: hashObject(stable),
    backend: model.identity.backend,
    ...(model.identity.model === undefined ? {} : { model: model.identity.model }),
    ...(model.identity.modelVersion === undefined
      ? {}
      : { modelVersion: model.identity.modelVersion }),
    parameters: { with_frames: frame_paths.length > 0 },
    pipelineVersion: PIPELINE_VERSION,
  };
}

async function describeCached(
  model: ContextModel,
  params: Parameters<ContextModel['describe']>[0],
  cache: PerceptionCache | undefined,
): Promise<Awaited<ReturnType<ContextModel['describe']>>> {
  const key = describeKey(model, params);
  const hit = cache?.get<Awaited<ReturnType<ContextModel['describe']>>>(key);
  if (hit) return hit;
  const result = await model.describe(params);
  cache?.set(key, result);
  return result;
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
  flags: { includeFrames: boolean },
) {
  const previous = index > 0 ? all[index - 1] : undefined;
  const next = all[index + 1];

  const framePaths = flags.includeFrames ? framesFor(skeleton, options) : [];

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

function framesFor(skeleton: Skeleton, options: BuildEventsOptions): string[] {
  const prepared = options.derived?.get(skeleton.draft.asset_id);
  if (!prepared?.frames_dir) return [];
  const fps = options.frameFps ?? 1;

  // Four frames: the start, two through the middle and the end. More rarely
  // changes the answer and every one of them costs money on a hosted model.
  const span = skeleton.draft.end_ms - skeleton.draft.start_ms;
  const points = [0.1, 0.35, 0.65, 0.9].map(
    (fraction) => skeleton.draft.start_ms + span * fraction,
  );
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
  };
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
