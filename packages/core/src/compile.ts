import {
  IR_VERSION,
  PIPELINE_VERSION,
  type EditorialIR,
  type EmbeddingSet,
  type MediaAsset,
  type ObservationTimeline,
  type PrepareResult,
  type Project,
  type ProjectContext,
  type SemanticEvent,
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
import { buildEventGraph } from './graph.js';
import { continuityOverrides } from './annotations.js';
import { ModelRunRecorder } from './model-runs.js';
import { CostBudget, type EscalationPolicy } from './budget.js';
import { hashObject } from './fingerprint.js';

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
  /** Assets a stage could not read, and why. */
  failures: { stage: string; assetId: string; reason: string }[];
  totalCostUsd: number;
  /** True when anything in this compile sent media off the machine. */
  mediaLeftDevice: boolean;
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

  if (reusable && stored) {
    observations = stored;
    // The runs that produced these observations came back with them, so the
    // model_run_id on every utterance, shot and frame still resolves, and the
    // privacy report still names every model that touched the media. They were
    // recorded only in the IR of the compile that made them, and a reuse — the
    // normal path, and the one `oea annotate` tells you to take — left the whole
    // perception half of the provenance trail pointing at nothing.
    runs.adopt(stored.model_runs);
    // Frame vectors are not persisted, so a reused observation set has none.
    // Segmentation falls back to the signals it does have, which is why the
    // scorer renormalises rather than assuming a missing signal means "same".
    //
    // It said so only when no vision model was configured at all, which is the
    // case where nothing was lost. With one configured, a reuse quietly dropped
    // the frame vectors — visual search fell back to the words attached to the
    // picture, boundaries were found without it, and the report said everything
    // was available. Saying nothing is what makes a silent downgrade silent.
    unavailable = [
      availableCapabilities(options.suite).includes('visual')
        ? {
            stage: 'visual',
            reason: 'this run reused an earlier analysis, which does not keep frame vectors',
          }
        : { stage: 'visual', reason: 'no model is configured for it' },
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
    derived = observed.derived;
    unavailable = observed.unavailable;
    failures = observed.failures;
  }

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
  try {
    embedded = await buildEmbeddings(built.events, context, options.suite.text, { frameVectors });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push({
      stage: 'embed',
      assetId: '(the whole index)',
      reason: `${reason} — indexed lexically instead, so search matches words rather than meaning`,
    });
    embedded = await buildEmbeddings(built.events, context, new HashingTextEmbedding(), {
      frameVectors,
    });
  }
  const vectorIndex = new FlatVectorIndex();
  vectorIndex.add(embedded.records);
  // Redundancy is a question about the whole set, which is why the index has to
  // exist before the decision layer runs.
  const similarities = vectorIndex.maxSimilarities('event');

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
  const { chapters, assignments } = buildChapters(built.events, options.chapters ?? {});
  const eventsWithChapters: SemanticEvent[] = built.events.map((event) => {
    const chapterId = assignments.get(event.id);
    return chapterId ? { ...event, chapter_id: chapterId } : event;
  });

  const relations = buildEventGraph(eventsWithChapters, {
    continuityOverrides: continuityOverrides(annotations),
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

  const ir: EditorialIR = {
    ir_version: IR_VERSION,
    pipeline_version: PIPELINE_VERSION,
    generated_at: generatedAt,
    fingerprint,
    project: { ...project, status: 'analyzed', ir_version: IR_VERSION, updated_at: generatedAt },
    context,
    assets,
    placements,
    chapters,
    events,
    editorial: assessed.editorial,
    relations,
    annotations,
    conflicts: built.conflicts,
    model_runs: runs.all(),
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
      failures,
      totalCostUsd: runs.totalCostUsd(),
      mediaLeftDevice: runs.anyMediaLeftDevice(),
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
