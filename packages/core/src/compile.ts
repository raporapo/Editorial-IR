import {
  IR_VERSION,
  PIPELINE_VERSION,
  analysisQuality,
  type AnalysisSavings,
  type EditorialIR,
  type EmbeddingSet,
  type MediaAsset,
  type ObservationTimeline,
  type PrepareResult,
  type Project,
  type ProjectContext,
  type SemanticEvent,
  type StandIn,
  type StandInReason,
  type UserAnnotation,
} from '@editorial-ir/contracts';
import type { ContextModel, PerceptionSuite } from '@editorial-ir/perception';
import {
  HashingTextEmbedding,
  HeuristicContextModel,
  ModelScheduler,
  availableCapabilities,
} from '@editorial-ir/perception';
import type { EditorialDecisionModel } from '@editorial-ir/decision';
import { FlatVectorIndex } from '@editorial-ir/index';
import type { ProjectStore } from './store.js';
import { placeAssets } from './ingest.js';
import { frameSimilarityFrom, observeAssets, type UnavailableStage } from './observe.js';
import { segmentAssets, type SegmentationOptions } from './segment.js';
import { buildSemanticEvents } from './context-builder.js';
import { buildEmbeddings, attachEmbeddingRefs } from './embed.js';
import { assessEvents } from './assess-stage.js';
import { buildChapters, type ChapterOptions } from './chapters.js';
import { buildEventGraph, hasDistinctiveContent } from './graph.js';
import { classifyMaterials } from './materials.js';
import { continuityOverrides } from './annotations.js';
import { ModelRunRecorder } from './model-runs.js';
import { CostBudget, type EscalationPolicy } from './budget.js';
import { hashObject } from './fingerprint.js';
import { inactiveSpans, totalInactiveMs } from './activity.js';

/**
 * Compiling raw media and user background into an Editorial IR.
 *
 * The order is not arbitrary. Perception is cached on media hashes so it
 * survives everything else changing. Embeddings come before the decision layer
 * because redundancy is a question about the whole set and cannot be answered
 * one event at a time. Chapters come after events because a chapter is a
 * statement about events, not about time. User knowledge is applied last at
 * every stage, so a model never gets the final word over a person.
 */
export interface CompileOptions {
  store: ProjectStore;
  suite: PerceptionSuite;
  decision: EditorialDecisionModel;

  /** A stronger model for the events worth spending on. */
  escalationContext?: ContextModel;
  escalationDecision?: EditorialDecisionModel;
  escalation?: EscalationPolicy;
  /** Hard ceiling on spend for this compile. */
  budgetUsd?: number;

  segmentation?: SegmentationOptions;
  chapters?: ChapterOptions;
  /**
   * Why any stand-in in this run is a stand-in.
   *
   * The backends declare *that* they are standing in; only the caller knows
   * whether that is because nothing was configured or because the run asked for
   * the no-model path. Defaults to the pessimistic reading.
   */
  standInReason?: StandInReason;
  /** Re-run perception even when nothing that affects it changed. */
  forceObservations?: boolean;
  frameFps?: number;
  onProgress?: (stage: string, message: string, done: number, total: number) => void;
  now?: () => string;
}

export interface CompileReport {
  reusedObservations: boolean;
  cacheHits: number;
  cacheMisses: number;
  escalatedContext: string[];
  escalatedDecision: string[];
  escalationLimitedBy: string;
  /** Perception stages the analysis went without, and why. */
  unavailable: UnavailableStage[];
  /** Stages that ran on a stand-in, exactly as recorded on the IR. */
  standIns: StandIn[];
  /** Assets a stage could not read, and why. */
  failures: { stage: string; assetId: string; reason: string }[];
  totalCostUsd: number;
  /** True when anything in this compile sent media off the machine. */
  mediaLeftDevice: boolean;
  /** Model work not done because the footage was still and silent. Absent when none was. */
  savings?: AnalysisSavings;
  elapsedMs: number;
}

export interface CompileResult {
  ir: EditorialIR;
  embeddings: EmbeddingSet;
  observations: ObservationTimeline;
  report: CompileReport;
}

export async function compileProject(options: CompileOptions): Promise<CompileResult> {
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date().toISOString());
  const { store } = options;

  const project = store.readProject();
  const context = store.readContext();
  const assets = store.readAssets();
  const annotations = store.readAnnotations();

  if (assets.length === 0) {
    throw new (await import('@editorial-ir/contracts')).EditorialError(
      'invalid_input',
      'this project has no media yet. Run "oea ingest <path>" first.',
    );
  }

  const runs = new ModelRunRecorder(now);
  const budget = new CostBudget(options.budgetUsd ?? Infinity);
  const placements = placeAssets(assets);

  // ---- perception ----------------------------------------------------------
  const expectedFingerprint = observationsFingerprint(assets, options.suite);
  const stored = store.readObservations();
  const reusable =
    !options.forceObservations &&
    stored !== undefined &&
    stored.fingerprint === expectedFingerprint &&
    // An incomplete set is not the set. The fingerprint is over the media and
    // the models, so it matches whether or not a stage actually managed to run
    // — which meant a run that could not read one asset stored the gap and
    // every run afterwards reported that nothing was missing. The per-asset
    // cache survives, so re-observing costs only what failed.
    stored.failures.length === 0 &&
    stored.pipeline_version === PIPELINE_VERSION;

  let observations: ObservationTimeline;
  let frameVectors = new Map<string, number[]>();
  let derived = new Map<string, PrepareResult>();
  let unavailable: UnavailableStage[] = [];
  let failures: { stage: string; assetId: string; reason: string }[] = [];
  // Only a fresh observation pass skips OCR reads; a reused one skipped them
  // when it was made, and counting them again would claim a saving twice.
  let framesNotAnalysed = 0;

  if (reusable && stored) {
    observations = stored;
    // Frame vectors come back with them. Without this the second compile of an
    // unchanged project produced a different IR under the same fingerprint:
    // every event's boundary confidence moved, because segmentation lost the
    // visual signal, and the visual index changed out of the vision model's
    // space into hashed text — 73 records at cosine 0 to the ones they replaced.
    frameVectors = store.readFrameVectors(expectedFingerprint) ?? new Map<string, number[]>();
    // The runs that produced these observations came back with them, so the
    // model_run_id on every utterance, shot and frame still resolves, and the
    // privacy report still names every model that touched the media. They were
    // recorded only in the IR of the compile that made them, and a reuse — the
    // normal path, and the one `oea annotate` tells you to take — left the whole
    // perception half of the provenance trail pointing at nothing.
    runs.adopt(stored.model_runs);
    // A project analysed before this sidecar existed has observations and no
    // vectors, and there is nothing to be done about that but say so — the
    // alternative was saying nothing, which is what made the downgrade silent.
    unavailable = !availableCapabilities(options.suite).includes('visual')
      ? [{ stage: 'visual', reason: 'no model is configured for it' }]
      : frameVectors.size > 0
        ? []
        : [
            {
              stage: 'visual',
              reason: 'the analysis it reused was made before frame vectors were kept',
            },
          ];
  } else {
    const observed = await observeAssets(assets, {
      projectRoot: store.paths.root,
      workDir: store.paths.workDir,
      suite: options.suite,
      cache: store.cache,
      context,
      runs,
      scheduler: new ModelScheduler(),
      ...(options.frameFps === undefined ? {} : { frameFps: options.frameFps }),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    observations = {
      ...observed.observations,
      project_id: project.id,
      fingerprint: expectedFingerprint,
      generated_at: now(),
      // Recorded with the observations rather than only in the IR, because the
      // run that produced an observation is a fact about that observation.
      model_runs: runs.all(),
      // And what it could not read, so the next run knows this set has a hole
      // in it rather than matching a fingerprint and calling it complete.
      failures: observed.failures.map((failure) => ({
        stage: failure.stage,
        asset_id: failure.assetId,
        reason: failure.reason,
      })),
    };
    frameVectors = observed.frameVectors;
    // Written here rather than left to the caller, because they mean something
    // only beside the observations of this exact fingerprint: the two are
    // stored together or not at all. Held in memory and thrown away, they made
    // the second compile of an unchanged project produce a different IR under
    // an identical fingerprint — 70 of 73 events' boundary confidence moved,
    // and the visual index left the vision model's space for hashed text.
    store.writeFrameVectors(expectedFingerprint, frameVectors);
    derived = observed.derived;
    unavailable = observed.unavailable;
    failures = observed.failures;
    framesNotAnalysed = observed.framesNotAnalysed;
  }

  // ---- still and silent ----------------------------------------------------
  // Recomputed from the observations on every compile rather than stored, so a
  // reused analysis gets exactly the mask a fresh one would, and a change to the
  // rule never needs a re-analysis. Read only after segmentation has cut the
  // events: it decides where not to spend, never where anything begins or ends.
  const inactive = inactiveSpans(observations, assets);

  // ---- what kind of material ----------------------------------------------
  // Decided from the observations whether they were made now or reused, for the
  // same reason as the mask: a reused analysis must get exactly the kinds a
  // fresh one would. The user's word in context.yaml wins over every rule.
  const materials = classifyMaterials(assets, observations, context);

  // ---- segmentation --------------------------------------------------------
  options.onProgress?.('segment', 'finding events', 0, 1);
  const drafts = segmentAssets(
    assets,
    observations,
    annotations,
    options.segmentation ?? {},
    frameVectors.size > 0 ? frameSimilarityFrom(frameVectors) : undefined,
    // A boundary the user asked for is written in capture time; segmentation
    // works in each asset's own time. Without the placements it cannot convert.
    placements,
    materials,
  );

  // ---- meaning -------------------------------------------------------------
  // A suite with no context model gets the rule-based one rather than no
  // descriptions at all. Leaving it to the caller meant the CLI and the tests
  // compiled the same footage differently, which is the kind of difference that
  // makes a golden file useless.
  const baseContextModel = options.suite.context ?? new HeuristicContextModel();

  const built = await buildSemanticEvents(drafts, {
    assets,
    placements,
    observations,
    context,
    annotations,
    runs,
    baseModel: baseContextModel,
    ...(options.escalationContext ? { escalationModel: options.escalationContext } : {}),
    ...(options.escalation ? { escalation: options.escalation } : {}),
    budget,
    derived,
    now,
    cache: store.cache,
    inactive,
    ...(options.frameFps === undefined ? {} : { frameFps: options.frameFps }),
    ...(options.onProgress
      ? { onProgress: (stage, done, total) => options.onProgress?.(stage, '', done, total) }
      : {}),
  });

  // ---- search ---------------------------------------------------------------
  options.onProgress?.('embed', 'indexing', 0, 1);
  // A search index that could not be built is worth less than the analysis.
  //
  // A configured embedding service that is down — a closed port, a container
  // restarting, a typo in the URL — threw out of the compile, so nothing was
  // written and the user lost the whole run over the stage that makes search
  // slightly better. The hashing encoder is documented as the guaranteed path
  // and is what an unconfigured install uses; falling back to it is the
  // difference between lexical search and no project.
  //
  // The whole set is re-embedded rather than the failed part patched, because
  // two encoders in one index is the bug this file's own header warns about:
  // vectors from two spaces, ranked against each other, with nothing able to
  // tell.
  let embedded;
  // Which encoder the index actually came from, and whether that was the plan.
  // Read below to decide the analysis tier: a run that configured a real
  // embedding and lost it partway is degraded, not unconfigured.
  let embeddingUsed = options.suite.text;
  let embeddingFellBack = false;
  try {
    embedded = await buildEmbeddings(built.events, context, options.suite.text, {
      frameVectors,
      runs,
      // The frame vectors came from the vision model, not from the text
      // encoder, and the records made out of them should say so.
      ...(runs.forStage('visual') === undefined ? {} : { visualRunId: runs.forStage('visual') }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push({
      stage: 'embed',
      assetId: '(the whole index)',
      reason: `${reason} — indexed lexically instead, so search matches words rather than meaning`,
    });
    // The fallback records itself, so the IR never claims a vector came from a
    // model that did not answer.
    const rescue = new HashingTextEmbedding();
    embeddingUsed = rescue;
    embeddingFellBack = true;
    embedded = await buildEmbeddings(built.events, context, rescue, {
      frameVectors,
      runs,
      // The frame vectors came from the vision model, not from the text
      // encoder, and the records made out of them should say so.
      ...(runs.forStage('visual') === undefined ? {} : { visualRunId: runs.forStage('visual') }),
    });
  }
  const vectorIndex = new FlatVectorIndex();
  vectorIndex.add(embedded.records);
  // Redundancy is a question about the whole set, which is why the index has to
  // exist before the decision layer runs.
  //
  // Calibrated against this corpus when the vectors came from a model, raw when
  // they came from the lexical vectoriser. The rules turn this into redundancy
  // with `(similarity - 0.6) / 0.4`, a constant whose scale is n-gram overlap —
  // which is a real, known scale for the lexical path and means nothing at all
  // for a model. Measured on a 62-minute project embedded with
  // multilingual-e5-large: the *least* similar pair of events scored 0.747,
  // giving redundancy 0.368, and the median pair 0.813, giving 0.533 — past the
  // 0.5 line that skill rules read as "redundant". More than half the footage
  // was marked as repeating itself, on material where nothing repeated, and
  // that decides which clips get dropped.
  //
  // The lexical path keeps the constant deliberately: its similarity *is* shared
  // n-grams, the constant was written for that, and there is no defect there to
  // fix. Changing a documented worked example needs a bug behind it.
  const similarities = embeddingUsed.lexical
    ? vectorIndex.maxSimilarities('event')
    : vectorIndex.calibratedMaxSimilarities('event').maxima;
  // An event nothing could be read from has nothing to compare. Its vector is
  // the embedding of a fallback sentence every such event shares, so every one
  // of them scored 1.0 against the others and was judged fully redundant: an
  // edited programme with no transcript and a folder of clips both planned no
  // clips at all offline. Unknown is the honest answer, and the rules have a
  // prior for it.
  //
  // Except where the footage was measured still and silent throughout. Two
  // such stretches do show the same nothing, and saying otherwise put a frozen
  // minute and a black one into the cut of a camera left running, ahead of the
  // stretch where somebody came back and spoke.
  const measuredNothing = new Set(built.savings.quietEvents);
  for (const event of built.events) {
    if (!hasDistinctiveContent(event) && !measuredNothing.has(event.id)) {
      similarities.delete(event.id);
    }
  }

  // ---- judgement -----------------------------------------------------------
  const assessed = await assessEvents(built.events, {
    context,
    runs,
    baseModel: options.decision,
    ...(options.escalationDecision ? { escalationModel: options.escalationDecision } : {}),
    ...(options.escalation ? { escalation: options.escalation } : {}),
    budget,
    cache: store.cache,
    similarities,
    quietEvents: built.savings.quietEvents,
    ...(options.onProgress
      ? { onProgress: (stage, done, total) => options.onProgress?.(stage, '', done, total) }
      : {}),
  });

  // A model that refused costs its own stage and nothing else, and says so.
  // Both of these used to throw out of the compile, so one 500 from an optional
  // endpoint threw away every minute of transcription and cheap judgement that
  // had already succeeded, and the user got no timeline and no plan at all.
  for (const failure of built.failures) {
    failures.push({
      stage: failure.stage,
      assetId: failure.eventId,
      reason: `${failure.reason} — kept the description it already had`,
    });
  }
  for (const failure of assessed.failures) {
    failures.push({
      stage: 'reassess',
      assetId: failure.eventId,
      reason: `${failure.reason} — the rule-based judgement stands`,
    });
  }

  // ---- structure -----------------------------------------------------------
  const { chapters, assignments } = buildChapters(built.events, options.chapters ?? {}, {
    // Real capture times, so a folder of clips shot minutes apart is one
    // outing and two recordings hours apart are two.
    assets,
    materials,
  });
  const eventsWithChapters: SemanticEvent[] = built.events.map((event) => {
    const chapterId = assignments.get(event.id);
    return chapterId ? { ...event, chapter_id: chapterId } : event;
  });

  const relations = buildEventGraph(eventsWithChapters, {
    continuityOverrides: continuityOverrides(annotations),
    // Built after judgement, which is what makes this available — and what lets
    // the graph carry the dependency the planner already acts on.
    requiresPreviousContext: (eventId) =>
      assessed.editorial.find((entry) => entry.event_id === eventId)?.current.flags
        .requires_previous_context,
    similarity: (a, b) => {
      const vectorA = vectorIndex.get(a, 'event');
      const vectorB = vectorIndex.get(b, 'event');
      if (!vectorA || !vectorB) return undefined;
      let dot = 0;
      for (let i = 0; i < Math.min(vectorA.length, vectorB.length); i++) {
        dot += (vectorA[i] ?? 0) * (vectorB[i] ?? 0);
      }
      return dot;
    },
  });

  const events = attachEmbeddingRefs(eventsWithChapters, embedded.records);

  // ---- how good is this? ---------------------------------------------------
  // Asked of the backends that actually ran, not of the flags that selected
  // them. A stage that fell back partway through (the embedding rescue above)
  // is a different answer from one that never had a model, and both are
  // different from a run that asked for neither.
  const declaredReason: StandInReason = options.standInReason ?? 'not_configured';
  const standIns: StandIn[] = [];
  const noteStandIn = (
    stage: StandIn['stage'],
    declaration: { insteadOf: string; remedy?: string } | undefined,
    used: string,
    reason: StandInReason = declaredReason,
  ): void => {
    if (!declaration) return;
    standIns.push({
      stage,
      used,
      instead_of: declaration.insteadOf,
      reason,
      ...(declaration.remedy ? { remedy: declaration.remedy } : {}),
    });
  };

  noteStandIn(
    'description',
    baseContextModel.identity.standIn,
    baseContextModel.identity.model ?? baseContextModel.identity.backend,
  );
  noteStandIn(
    'judgement',
    options.decision.identity.standIn,
    options.decision.identity.model ?? options.decision.identity.backend,
  );

  // A model that was there and then was not.
  //
  // The backends declare what they *are*; they cannot declare what happened to
  // them halfway through. A real run against a local model server found this:
  // the server went away, every description fell back to the template, the
  // failures were all dutifully reported — and the tier still read `standard`,
  // because the context model wired at the start was a real one and never said
  // otherwise. An IR whose every description is a template is not a
  // full-strength analysis whatever was configured when it began.
  //
  // Counted rather than flagged, because one failed call out of eighty is a
  // blip and eighty out of eighty is a different artefact. The line is drawn at
  // half: past that, most of what the IR says came from the fallback.
  // Judgement, the same way: asked of what the answers actually were.
  //
  // A decision model wrapped in a fallback keeps the primary's identity, so it
  // declares no stand-in — and a server that rejected every single request
  // produced an IR judged entirely by rules and stamped `standard`.
  const decisionAnswers = (options.decision as { answers?: { primary: number; fallback: number } })
    .answers;
  if (
    decisionAnswers !== undefined &&
    decisionAnswers.fallback > 0 &&
    decisionAnswers.fallback >= decisionAnswers.primary
  ) {
    standIns.push({
      stage: 'judgement',
      used: 'the rules',
      instead_of: options.decision.identity.model ?? 'the configured model',
      reason: 'failed_during_run',
      remedy: `${decisionAnswers.fallback} of ${decisionAnswers.fallback + decisionAnswers.primary} answers came from the rules; check the model endpoint`,
    });
  }

  // Counted from what the events actually got, not from the error list. The
  // error list stops after a handful of identical failures — and so does the
  // loop, so a run where every description came from the template reported
  // three failures and looked like a run where three did.
  if (
    baseContextModel.identity.standIn === undefined &&
    built.events.length > 0 &&
    built.describedByFallback * 2 >= built.events.length
  ) {
    standIns.push({
      stage: 'description',
      used: 'the observation summary',
      instead_of: baseContextModel.identity.model ?? 'the configured model',
      reason: 'failed_during_run',
      remedy: `${built.describedByFallback} of ${built.events.length} events fell back; check the model endpoint`,
    });
  }
  noteStandIn(
    'text_embedding',
    embeddingUsed.identity.standIn,
    embeddingUsed.identity.model ?? embeddingUsed.identity.backend,
    embeddingFellBack ? 'failed_during_run' : declaredReason,
  );

  // ---- assemble ------------------------------------------------------------
  const generatedAt = now();
  const fingerprint = irFingerprint({
    assets,
    context,
    annotations,
    observationsFingerprint: expectedFingerprint,
    decisionBackend: options.decision.identity.backend,
    decisionModel: options.decision.identity.model,
  });

  // What the still, silent footage saved. Absent rather than zero when there
  // was none, so an IR of footage with no such stretch is unchanged by all this.
  const inactiveMs = totalInactiveMs(inactive);
  const savings: AnalysisSavings | undefined =
    inactiveMs > 0
      ? {
          inactive_ms: inactiveMs,
          describe_calls_skipped: built.savings.describeCallsSkipped,
          judge_calls_skipped: assessed.judgeCallsSkipped,
          frames_not_sent: built.savings.framesNotSent,
          frames_not_analysed: framesNotAnalysed,
          estimated_tokens_avoided:
            built.savings.estimatedTokensAvoided + assessed.estimatedTokensAvoided,
        }
      : undefined;

  const ir: EditorialIR = {
    ir_version: IR_VERSION,
    pipeline_version: PIPELINE_VERSION,
    generated_at: generatedAt,
    fingerprint,
    project: { ...project, status: 'analyzed', ir_version: IR_VERSION, updated_at: generatedAt },
    context,
    assets,
    placements,
    materials,
    chapters,
    events,
    editorial: assessed.editorial,
    relations,
    annotations,
    conflicts: built.conflicts,
    model_runs: runs.all(),
    quality: { ...analysisQuality(standIns), ...(savings ? { savings } : {}) },
    stats: {
      asset_count: assets.length,
      total_media_duration_ms: assets.reduce((sum, a) => sum + a.duration_ms, 0),
      event_count: events.length,
      chapter_count: chapters.length,
      relation_count: relations.length,
      utterance_count: observations.utterances.length,
      shot_count: observations.shots.length,
      mean_event_duration_ms:
        events.length === 0
          ? 0
          : Math.round(events.reduce((sum, e) => sum + (e.end_ms - e.start_ms), 0) / events.length),
      total_cost_usd: runs.totalCostUsd(),
      compile_ms: Date.now() - startedAt,
      embedding_kinds: embedded.kinds,
    },
  };

  return {
    ir,
    embeddings: { project_id: project.id, generated_at: generatedAt, records: embedded.records },
    observations,
    report: {
      reusedObservations: reusable,
      cacheHits: store.cache.hits,
      cacheMisses: store.cache.misses,
      escalatedContext: built.escalated,
      escalatedDecision: assessed.escalated,
      escalationLimitedBy: built.escalationLimitedBy,
      unavailable,
      standIns,
      failures,
      totalCostUsd: runs.totalCostUsd(),
      mediaLeftDevice: runs.anyMediaLeftDevice(),
      ...(savings ? { savings } : {}),
      elapsedMs: Date.now() - startedAt,
    },
  };
}

/**
 * What perception depends on: the media itself and the models that will look at
 * it. Not the project background, not the target duration, not the skill.
 */
export function observationsFingerprint(
  assets: readonly MediaAsset[],
  suite: PerceptionSuite,
): string {
  const identityOf = (
    model: { identity: { backend: string; model?: string; modelVersion?: string } } | undefined,
  ) =>
    model
      ? [model.identity.backend, model.identity.model ?? '', model.identity.modelVersion ?? '']
      : null;

  return hashObject({
    pipeline: PIPELINE_VERSION,
    media: [...assets].map((a) => a.sha256).sort(),
    speech: identityOf(suite.speech),
    shots: identityOf(suite.shots),
    visual: identityOf(suite.visual),
    audio: identityOf(suite.audio),
    ocr: identityOf(suite.ocr),
    // Only when there is one, so a suite without it fingerprints as it always did.
    ...(suite.video ? { video: identityOf(suite.video) } : {}),
  });
}

/**
 * What the IR depends on. A plan records this, so a plan built against an IR
 * that has since been recompiled can be detected instead of silently applied.
 */
export function irFingerprint(parts: {
  assets: readonly MediaAsset[];
  context: ProjectContext;
  annotations: readonly UserAnnotation[];
  observationsFingerprint: string;
  decisionBackend: string;
  decisionModel?: string;
}): string {
  return hashObject({
    ir_version: IR_VERSION,
    observations: parts.observationsFingerprint,
    context: { background: parts.context.background, goal: parts.context.editing_goal },
    annotations: [...parts.annotations].map((a) => ({ ...a, created_at: undefined })),
    decision: [parts.decisionBackend, parts.decisionModel ?? ''],
  });
}

export type { Project };
