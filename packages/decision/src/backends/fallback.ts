import type {
  BooleanRequest,
  BooleanResult,
  ChoiceRequest,
  ChoiceResult,
  EventState,
  ScoreRequest,
  ScoreResult,
} from '@editorial-ir/contracts';
import type {
  BatchAnswers,
  BatchRequest,
  DecisionBackendIdentity,
  EditorialDecisionModel,
} from '../types.js';
import { assessViaPrimitives } from './primitive-batch.js';

/**
 * Wraps a backend so that a failure degrades instead of ending the run.
 *
 * Compiling an hour of footage is minutes of work. Losing all of it because a
 * model server restarted at event four hundred is not an acceptable failure
 * mode, and neither is silently pretending the answer was good: the fallback's
 * answers arrive with the fallback's own confidence, which is visible in the IR
 * and read by the escalation policy.
 */
export interface FallbackOptions {
  onFallback?: (error: unknown, questionId: string) => void;
  /** Stop trying the primary backend after this many consecutive failures. 0 disables. */
  giveUpAfter?: number;
}

export class FallbackDecisionBackend implements EditorialDecisionModel {
  readonly identity: DecisionBackendIdentity;
  private consecutiveFailures = 0;
  private abandoned = false;

  constructor(
    private readonly primary: EditorialDecisionModel,
    private readonly fallback: EditorialDecisionModel,
    private readonly options: FallbackOptions = {},
  ) {
    this.identity = {
      ...primary.identity,
      backend: `${primary.identity.backend}+${fallback.identity.backend}`,
    };

    const primaryBatch = primary.assessAll?.bind(primary);
    if (primaryBatch) {
      this.assessAll = (state, request) =>
        this.attempt(
          'assess_all',
          () => primaryBatch(state, request),
          async () => {
            if (fallback.assessAll) return fallback.assessAll(state, request);
            return assessViaPrimitives(fallback, state, request);
          },
        );
    }
  }

  /** True once the primary backend has been given up on for this run. */
  get degraded(): boolean {
    return this.abandoned;
  }

  async choice(state: EventState, request: ChoiceRequest): Promise<ChoiceResult> {
    return this.attempt(
      request.question_id,
      () => this.primary.choice(state, request),
      () => this.fallback.choice(state, request),
    );
  }

  async score(state: EventState, request: ScoreRequest): Promise<ScoreResult> {
    return this.attempt(
      request.question_id,
      () => this.primary.score(state, request),
      () => this.fallback.score(state, request),
    );
  }

  async booleanProbability(state: EventState, request: BooleanRequest): Promise<BooleanResult> {
    return this.attempt(
      request.question_id,
      () => this.primary.booleanProbability(state, request),
      () => this.fallback.booleanProbability(state, request),
    );
  }

  /**
   * Only present when the primary backend has a batch path.
   *
   * Declaring it unconditionally would be worse than useless: callers check for
   * the method to decide how to ask, so a wrapper that always has it would route
   * every backend down a path half of them cannot serve.
   */
  assessAll?: (state: EventState, request: BatchRequest) => Promise<BatchAnswers>;

  private async attempt<T>(
    questionId: string,
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    if (this.abandoned) return fallback();
    try {
      const result = await primary();
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this.consecutiveFailures++;
      this.options.onFallback?.(error, questionId);
      const limit = this.options.giveUpAfter ?? 5;
      if (limit > 0 && this.consecutiveFailures >= limit) this.abandoned = true;
      return fallback();
    }
  }

  async close(): Promise<void> {
    await this.primary.close?.();
    await this.fallback.close?.();
  }
}
