import type {
  BooleanRequest,
  BooleanResult,
  ChoiceRequest,
  ChoiceResult,
  EventState,
  ExecutionLocality,
  ScoreRequest,
  ScoreResult,
} from '@editorial-ir/contracts';

/**
 * The decision layer, as three primitives.
 *
 * Every backend implements exactly this, and nothing more. A rule-based one, a
 * small local model with structured output and a hosted decision API are
 * interchangeable, which is what keeps any particular one from becoming a
 * dependency of the project rather than an option in it.
 */
export interface EditorialDecisionModel {
  readonly identity: DecisionBackendIdentity;

  /** Pick one option from a closed set, and say how the belief was distributed. */
  choice(state: EventState, request: ChoiceRequest): Promise<ChoiceResult>;

  /** Place the event on a labelled ordinal scale. */
  score(state: EventState, request: ScoreRequest): Promise<ScoreResult>;

  /** Probability that a statement about the event holds. */
  booleanProbability(state: EventState, request: BooleanRequest): Promise<BooleanResult>;

  /**
   * Optional fast path: answer a whole question set for one event at once.
   *
   * A full assessment is ten scores, eight yes/no questions and one choice. Sent
   * one at a time to a hosted model that is nineteen round trips and nineteen
   * copies of the same context, for one event. Backends that can answer in one
   * call should, and {@link assessEvent} uses this whenever it is offered.
   */
  assessAll?(state: EventState, request: BatchRequest): Promise<BatchAnswers>;

  /** Releases any resources the backend holds. */
  close?(): Promise<void>;
}

export interface BatchRequest {
  scores: ScoreRequest[];
  booleans: BooleanRequest[];
  choice?: ChoiceRequest;
}

export interface BatchAnswers {
  scores: Record<string, ScoreResult>;
  booleans: Record<string, BooleanResult>;
  choice?: ChoiceResult;
  /** Free-text justification shown to humans; never used for control flow. */
  rationale?: string;
  /** Overrides the backend's base confidence for this event, when it can tell. */
  confidence?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface DecisionBackendIdentity {
  readonly backend: string;
  readonly model?: string;
  readonly modelVersion?: string;
  readonly locality: ExecutionLocality;
  readonly mediaLeavesDevice: boolean;
  /**
   * How much to trust this backend's answers, in [0,1].
   *
   * Recorded on every assessment and read by the escalation policy: a cheap
   * backend that knows it is cheap is what makes "spend the expensive model only
   * where it matters" a decision rather than a guess.
   */
  readonly baseConfidence: number;
  readonly parameters?: Record<string, unknown>;
  /** Estimated USD per event assessed. Zero for local rule-based work. */
  readonly costPerEventUsd?: number;
}
