import { z } from 'zod';
import { Iso8601, Milliseconds, obj, compareText } from './primitives.js';
import { AssetPlacement, MaterialProfile, MediaAsset } from './media.js';
import { Project, ProjectContext, UserAnnotation } from './project.js';
import { Chapter, SemanticEvent } from './event.js';
import { EditorialAssessment } from './editorial.js';
import { EventRelation } from './relation.js';
import { Conflict } from './provenance.js';
import { ModelRun } from './model-run.js';
import { AnalysisQuality } from './quality.js';
import { EmbeddingKind } from './embedding.js';
import { IR_VERSION } from './version.js';

/**
 * Editorial IR — the artefact this whole project exists to produce.
 *
 * It is what you get when you compile raw media plus user background into
 * something an editor, human or otherwise, can reason about without ever
 * touching the video again. Once it exists, "make a 3 minute travel vlog" and
 * "make a 30 second short" are two cheap reads of the same structure rather than
 * two expensive passes over an hour of footage.
 *
 * What it holds: time, sources, observations, meaning, people, places, events,
 * affect, narrative role, user knowledge, continuity, importance, provenance and
 * confidence.
 *
 * What it must never hold: anything specific to one editing application — no
 * Premiere object ids, no AviUtl effect syntax, no GUI coordinates, no API
 * payloads. That boundary is what makes a second NLE a new adapter rather than a
 * new product.
 */

/** Per-event editorial view: the assessment in force plus its alternatives. */
export const EventEditorial = obj({
  event_id: z.string(),
  /** The assessment the planner uses. */
  current: EditorialAssessment,
  /** Earlier or alternative backends' verdicts, newest first. Never discarded. */
  history: z.array(EditorialAssessment).default([]),
}).meta({ id: 'EventEditorial' });
export type EventEditorial = z.infer<typeof EventEditorial>;

export const IrStats = obj({
  asset_count: z.int().min(0),
  total_media_duration_ms: Milliseconds,
  event_count: z.int().min(0),
  chapter_count: z.int().min(0),
  relation_count: z.int().min(0),
  utterance_count: z.int().min(0),
  shot_count: z.int().min(0),
  /** Mean event duration, a quick sanity check on segmentation. */
  mean_event_duration_ms: Milliseconds,
  /** Sum of `cost_usd` across every model run that contributed. */
  total_cost_usd: z.number().min(0),
  /** Wall-clock time spent compiling. */
  compile_ms: Milliseconds,
  /** Which embedding aspects are populated. */
  embedding_kinds: z.array(EmbeddingKind).default([]),
}).meta({ id: 'IrStats' });
export type IrStats = z.infer<typeof IrStats>;

export const EditorialIR = obj({
  ir_version: z.string().default(IR_VERSION),
  pipeline_version: z.string(),
  generated_at: Iso8601,
  /**
   * Hash over the inputs that produced this IR (media hashes, context, model
   * identities, pipeline version). Plans record it so that a plan built against
   * a stale IR can be detected instead of silently applied.
   */
  fingerprint: z.string(),

  project: Project,
  context: ProjectContext,

  assets: z.array(MediaAsset).default([]),
  placements: z.array(AssetPlacement).default([]),
  /** What kind of material each asset is, and why that was decided. */
  materials: z.array(MaterialProfile).default([]),

  chapters: z.array(Chapter).default([]),
  events: z.array(SemanticEvent).default([]),
  editorial: z.array(EventEditorial).default([]),
  relations: z.array(EventRelation).default([]),

  /** User overrides, kept beside model output rather than folded into it. */
  annotations: z.array(UserAnnotation).default([]),
  /** Places where the user and the media disagree. Recorded, never auto-resolved. */
  conflicts: z.array(Conflict).default([]),

  model_runs: z.array(ModelRun).default([]),
  /**
   * Which stages ran a real model and which ran a stand-in.
   *
   * Required, and deliberately not defaulted: an IR that cannot say how it was
   * produced should fail to load rather than be assumed to be good.
   */
  quality: AnalysisQuality,
  stats: IrStats,
}).meta({ id: 'EditorialIR', title: 'EditorialIR' });
export type EditorialIR = z.infer<typeof EditorialIR>;

/* -------------------------------------------------------------------------- */
/* Read helpers                                                                */
/* -------------------------------------------------------------------------- */

export function eventById(ir: EditorialIR, id: string): SemanticEvent | undefined {
  return ir.events.find((e) => e.id === id);
}

export function assessmentFor(ir: EditorialIR, eventId: string): EditorialAssessment | undefined {
  return ir.editorial.find((e) => e.event_id === eventId)?.current;
}

export function chapterById(ir: EditorialIR, id: string): Chapter | undefined {
  return ir.chapters.find((c) => c.id === id);
}

export function assetById(ir: EditorialIR, id: string): MediaAsset | undefined {
  return ir.assets.find((a) => a.id === id);
}

/** Events in capture order. The IR stores them sorted; this makes that explicit. */
export function eventsInOrder(ir: EditorialIR): SemanticEvent[] {
  return [...ir.events].sort((a, b) => a.start_ms - b.start_ms || compareText(a.id, b.id));
}

export function neighboursOf(
  ir: EditorialIR,
  eventId: string,
): { previous?: SemanticEvent; next?: SemanticEvent } {
  const ordered = eventsInOrder(ir);
  const i = ordered.findIndex((e) => e.id === eventId);
  if (i < 0) return {};
  const result: { previous?: SemanticEvent; next?: SemanticEvent } = {};
  const prev = i > 0 ? ordered[i - 1] : undefined;
  const next = ordered[i + 1];
  if (prev) result.previous = prev;
  if (next) result.next = next;
  return result;
}

/** Total duration of the material, not of any edit derived from it. */
export function totalCaptureDurationMs(ir: EditorialIR): number {
  return ir.assets.reduce((sum, a) => sum + a.duration_ms, 0);
}
