import {
  IR_VERSION,
  PIPELINE_VERSION,
  type EditorialIR,
  type EmbeddingSet,
  type MediaAsset,
  type ObservationTimeline,
  type Project,
  type ProjectContext,
  type SemanticEvent,
  type UserAnnotation,
} from '@editorial-ir/contracts';
import type { ContextModel, PerceptionSuite } from '@editorial-ir/perception';
import { ModelScheduler, availableCapabilities } from '@editorial-ir/perception';
import type { EditorialDecisionModel } from '@editorial-ir/decision';
import { FlatVectorIndex } from '@editorial-ir/index';
import type { ProjectStore } from './store.js';
import { placeAssets } from './ingest.js';
import { frameSimilarityFrom, observeAssets } from './observe.js';
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
  /** Perception stages no configured model provides. */
  unavailable: string[];
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
    stored.pipeline_version === PIPELINE_VERSION;

  let observations: ObservationTimeline;
  let frameVectors = new Map<string, number[]>();
  let derived = new Map<string, import('@editorial-ir/contracts').PrepareResult>();
  let unavailable: string[] = [];
  let failures: { stage: string; assetId: string; reason: string }[] = [];

  if (reusable && stored) {
    observations = stored;
    // Frame vectors are not persisted, so a reused observation set has none.
    // Segmentation falls back to the signals it does have, which is why the
    // scorer renormalises rather than assuming a missing signal means "same".
    unavailable = availableCapabilities(options.suite).includes('visual') ? [] : ['visual'];
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
  );

  // ---- meaning -------------------------------------------------------------
  const built = await buildSemanticEvents(drafts, {
    assets,
    placements,
    observations,
    context,
    annotations,
    runs,
    ...(options.suite.context ? { baseModel: options.suite.context } : {}),
    ...(options.escalationContext ? { escalationModel: options.escalationContext } : {}),
    ...(options.escalation ? { escalation: options.escalation } : {}),
    budget,
    derived,
    ...(options.frameFps === undefined ? {} : { frameFps: options.frameFps }),
    ...(options.onProgress
      ? { onProgress: (stage, done, total) => options.onProgress?.(stage, '', done, total) }
      : {}),
  });

  // ---- search ---------------------------------------------------------------
  options.onProgress?.('embed', 'indexing', 0, 1);
  const embedded = await buildEmbeddings(built.events, context, options.suite.text, { frameVectors });
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
    similarities,
    ...(options.onProgress
      ? { onProgress: (stage, done, total) => options.onProgress?.(stage, '', done, total) }
      : {}),
  });

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
export function observationsFingerprint(assets: readonly MediaAsset[], suite: PerceptionSuite): string {
  const identityOf = (model: { identity: { backend: string; model?: string; modelVersion?: string } } | undefined) =>
    model ? [model.identity.backend, model.identity.model ?? '', model.identity.modelVersion ?? ''] : null;

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
