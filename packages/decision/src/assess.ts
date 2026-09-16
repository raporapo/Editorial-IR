import {
  EDITORIAL_FLAGS,
  EDITORIAL_METRICS,
  NEUTRAL_FLAGS,
  NEUTRAL_METRICS,
  type EditorialFlag,
  type EditorialMetric,
  type EventState,
  type NarrativeRole,
  type NarrativeRoleAssessment,
} from '@editorial-ir/contracts';
import type { BatchAnswers, EditorialDecisionModel } from './types.js';
import { FLAG_QUESTIONS, METRIC_QUESTIONS, NARRATIVE_ROLE_QUESTION } from './questions.js';

/**
 * Runs the full question set over one event.
 *
 * The result is everything the editorial layer of the IR needs, minus the
 * bookkeeping (ids, model run) that only the compiler can supply.
 */
export interface AssessmentDraft {
  metrics: Record<EditorialMetric, number>;
  flags: Record<EditorialFlag, number>;
  narrative_role: NarrativeRoleAssessment;
  confidence: number;
  rationale?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface AssessOptions {
  /** Restrict the metrics asked about. Defaults to all of them. */
  metrics?: readonly EditorialMetric[];
  flags?: readonly EditorialFlag[];
  includeNarrativeRole?: boolean;
  /** Parallel questions when the backend has no batch path. */
  concurrency?: number;
}

export async function assessEvent(
  model: EditorialDecisionModel,
  state: EventState,
  options: AssessOptions = {},
): Promise<AssessmentDraft> {
  const metrics = options.metrics ?? EDITORIAL_METRICS;
  const flags = options.flags ?? EDITORIAL_FLAGS;
  const includeRole = options.includeNarrativeRole ?? true;

  if (model.assessAll) {
    const answers = await model.assessAll(state, {
      scores: metrics.map((m) => METRIC_QUESTIONS[m]),
      booleans: flags.map((f) => FLAG_QUESTIONS[f]),
      ...(includeRole ? { choice: NARRATIVE_ROLE_QUESTION } : {}),
    });
    return fromBatch(answers, metrics, flags, model.identity.baseConfidence);
  }

  const concurrency = Math.max(1, options.concurrency ?? 4);

  const metricValues = { ...NEUTRAL_METRICS };
  await mapWithConcurrency(metrics, concurrency, async (metric) => {
    const result = await model.score(state, METRIC_QUESTIONS[metric]);
    metricValues[metric] = result.value;
  });

  const flagValues = { ...NEUTRAL_FLAGS };
  await mapWithConcurrency(flags, concurrency, async (flag) => {
    const result = await model.booleanProbability(state, FLAG_QUESTIONS[flag]);
    flagValues[flag] = result.probability;
  });

  let role: NarrativeRoleAssessment = { selected: 'context', probabilities: {} };
  if (includeRole) {
    const choice = await model.choice(state, NARRATIVE_ROLE_QUESTION);
    role = {
      selected: choice.selected as NarrativeRole,
      probabilities: choice.probabilities as Partial<Record<NarrativeRole, number>>,
    };
  }

  return {
    metrics: metricValues,
    flags: flagValues,
    narrative_role: role,
    confidence: model.identity.baseConfidence,
  };
}

function fromBatch(
  answers: BatchAnswers,
  metrics: readonly EditorialMetric[],
  flags: readonly EditorialFlag[],
  baseConfidence: number,
): AssessmentDraft {
  const metricValues = { ...NEUTRAL_METRICS };
  for (const metric of metrics) {
    const answer = answers.scores[metric];
    // A backend that skipped a question leaves the neutral value in place
    // rather than making one up; neutral is visible in the IR, a fabrication is not.
    if (answer) metricValues[metric] = answer.value;
  }

  const flagValues = { ...NEUTRAL_FLAGS };
  for (const flag of flags) {
    const answer = answers.booleans[flag];
    if (answer) flagValues[flag] = answer.probability;
  }

  const role: NarrativeRoleAssessment = answers.choice
    ? {
        selected: answers.choice.selected as NarrativeRole,
        probabilities: answers.choice.probabilities as Partial<Record<NarrativeRole, number>>,
      }
    : { selected: 'context', probabilities: {} };

  return {
    metrics: metricValues,
    flags: flagValues,
    narrative_role: role,
    confidence: answers.confidence ?? baseConfidence,
    ...(answers.rationale ? { rationale: answers.rationale } : {}),
    ...(answers.inputTokens === undefined ? {} : { inputTokens: answers.inputTokens }),
    ...(answers.outputTokens === undefined ? {} : { outputTokens: answers.outputTokens }),
    ...(answers.costUsd === undefined ? {} : { costUsd: answers.costUsd }),
  };
}

/** Bounded parallelism, in input order, so runs stay reproducible. */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      await worker(item, index);
    }
  });
  await Promise.all(runners);
}
