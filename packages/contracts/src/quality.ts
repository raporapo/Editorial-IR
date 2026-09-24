import { z } from 'zod';
import { Milliseconds, obj } from './primitives.js';

/**
 * How much of this analysis was done by a model, and how much by a stand-in.
 *
 * The pipeline is built so that a missing model costs one stage rather than the
 * whole run. That property is worth keeping, and it has a failure mode: an IR
 * compiled entirely by rules and lexical hashing looks, on disk, exactly like an
 * IR compiled by real models. Every field is populated. Nothing is obviously
 * wrong. It is simply much worse, and nothing says so.
 *
 * That is fine for getting started and unacceptable for judging quality — a
 * benchmark run against a rules-only IR measures the rules, while reporting a
 * number about the product. So the tier travels inside the IR itself rather than
 * living in a log line that the next command cannot see.
 *
 * The tier is derived from what actually ran. It is never set by a flag: a flag
 * says what was asked for, and the interesting question is what was delivered.
 */
export const ANALYSIS_STAGES = [
  'transcription',
  'visual_embedding',
  'audio_events',
  'description',
  'judgement',
  'text_embedding',
] as const;

/**
 * The stages whose stand-in changes the editorial answer rather than merely
 * thinning it.
 *
 * Transcription and visual embedding are absent on purpose. Footage with no
 * speech genuinely has no transcript, and an analysis of silent footage is not
 * degraded for saying so. Description, judgement and text embedding are
 * different: there is always something to describe, always a call to make, and
 * always text to index, so a stand-in there is a substitution rather than an
 * absence.
 */
export const DECISIVE_STAGES = ['description', 'judgement', 'text_embedding'] as const;

export const AnalysisStage = z.enum(ANALYSIS_STAGES).meta({ id: 'AnalysisStage' });
export type AnalysisStage = z.infer<typeof AnalysisStage>;

/** Why a stage ran without the model the standard path wants. */
export const StandInReason = z
  .enum([
    /** No model was configured for this stage. */
    'not_configured',
    /** A model was configured, and the machine could not run or reach it. */
    'unavailable',
    /** The run explicitly asked for the no-model path. */
    'requested',
    /** A model was configured and reachable, and it failed during the run. */
    'failed_during_run',
  ])
  .meta({ id: 'StandInReason' });
export type StandInReason = z.infer<typeof StandInReason>;

export const StandIn = obj({
  stage: AnalysisStage,
  /** What actually produced the values, e.g. `rules`, `hashing`. */
  used: z.string().min(1),
  /** What the standard path would have used, in words a person can act on. */
  instead_of: z.string().min(1),
  reason: StandInReason,
  /** How to get the real thing, when there is a concrete answer. */
  remedy: z.string().optional(),
}).meta({ id: 'StandIn' });
export type StandIn = z.infer<typeof StandIn>;

/**
 * What a backend says about itself when it is not the real thing.
 *
 * Declared by the backend rather than assembled by the caller. A caller that
 * reports its own stand-ins is a caller that can forget one, and a forgotten
 * stand-in is an IR that claims `standard` while a stage was guessing — which is
 * precisely the failure this whole file exists to make impossible.
 */
export interface StandInDeclaration {
  /** What the standard path would have used, in words a person can act on. */
  readonly insteadOf: string;
  /** How to get the real thing. */
  readonly remedy?: string;
}

/**
 * - `standard` — every decisive stage ran a real model.
 * - `degraded` — a real model was configured for every decisive stage and at
 *   least one of them fell back partway through. The IR is usable; it is not
 *   comparable with a `standard` one.
 * - `offline_minimal` — at least one decisive stage had no model at all. Useful,
 *   free, instant, reproducible, and not a measurement of anything.
 */
export const AnalysisTier = z
  .enum(['standard', 'degraded', 'offline_minimal'])
  .meta({ id: 'AnalysisTier' });
export type AnalysisTier = z.infer<typeof AnalysisTier>;

/**
 * Model work deliberately not done, because the material held nothing to find.
 *
 * Separate from `stand_ins` on purpose, and the separation is load-bearing. A
 * stand-in is a stage that ran without the model it wanted; a skip is a model
 * that was available and was not asked, about a span of footage that was both
 * still and silent. Folded together, a project with a long static stretch would
 * look degraded — the tier logic counts descriptions that came from the fallback
 * — when the only thing that happened is that nobody paid to have a closed lens
 * cap described.
 *
 * No time value anywhere depends on this. The spans are metadata beside the
 * media, the media is never cut or re-encoded for it, and event boundaries,
 * source ranges and plan timecodes are the same whether it was applied or not.
 */
export const AnalysisSavings = obj({
  /** Total source time judged both static and silent. */
  inactive_ms: Milliseconds.default(0),
  /** Events described from their observations instead of by the vision-language model. */
  describe_calls_skipped: z.int().min(0).default(0),
  /** Events judged by the rules instead of the decision model. */
  judge_calls_skipped: z.int().min(0).default(0),
  /** Frames that would have been sent to the describe call and were not. */
  frames_not_sent: z.int().min(0).default(0),
  /** Frame timestamps not embedded or read for text, beyond one kept per span. */
  frames_not_analysed: z.int().min(0).default(0),
  /** An estimate, labelled as one: skipped calls times the tokens measured per call. */
  estimated_tokens_avoided: z.int().min(0).default(0),
}).meta({ id: 'AnalysisSavings' });
export type AnalysisSavings = z.infer<typeof AnalysisSavings>;

export const AnalysisQuality = obj({
  tier: AnalysisTier,
  /** Every stage that ran without the model the standard path wants. */
  stand_ins: z.array(StandIn).default([]),
  /** What was not asked of a model because there was nothing there. Absent when off. */
  savings: AnalysisSavings.optional(),
}).meta({ id: 'AnalysisQuality' });
export type AnalysisQuality = z.infer<typeof AnalysisQuality>;

/**
 * The tier a set of stand-ins implies.
 *
 * Deriving it in one place is the point: a caller that could set the tier
 * directly is a caller that can claim `standard` while holding a list of things
 * it did not do, and that claim is the exact thing this field exists to prevent.
 */
export function tierFor(standIns: readonly StandIn[]): AnalysisTier {
  const decisive = standIns.filter((s) => (DECISIVE_STAGES as readonly string[]).includes(s.stage));
  if (decisive.length === 0) return 'standard';
  // A model that was configured and then broke is a different situation from one
  // that was never there: the operator did the right thing and the machine did
  // not. Both are unfit to benchmark; only one is worth reporting as a fault.
  return decisive.every((s) => s.reason === 'failed_during_run') ? 'degraded' : 'offline_minimal';
}

export function analysisQuality(standIns: readonly StandIn[]): AnalysisQuality {
  return { tier: tierFor(standIns), stand_ins: [...standIns] };
}

/** One line per stand-in, for a terminal. */
export function describeStandIn(standIn: StandIn): string {
  const why =
    standIn.reason === 'requested'
      ? 'asked for'
      : standIn.reason === 'not_configured'
        ? 'nothing configured'
        : standIn.reason === 'unavailable'
          ? 'configured but unreachable'
          : 'failed partway through';
  return `${standIn.stage}: ${standIn.used} instead of ${standIn.instead_of} (${why})`;
}
