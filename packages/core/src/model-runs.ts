import {
  compareText,
  newId,
  type ExecutionLocality,
  type ModelRun,
  type PipelineStage,
} from '@editorial-ir/contracts';
import type { ModelIdentity } from '@editorial-ir/perception';

/**
 * Collects the provenance trail for one compile.
 *
 * Every value in an Editorial IR points at a model run rather than naming a
 * model, so this is where model identity actually lives. It is also where the
 * cost and the privacy report come from: `media_left_device` is recorded per run
 * rather than inferred later, because "did any of my footage leave this machine"
 * is a question a user is entitled to a precise answer to.
 */
export interface ModelRunInput {
  stage: PipelineStage;
  backend: string;
  model?: string;
  modelVersion?: string;
  locality?: ExecutionLocality;
  mediaLeavesDevice?: boolean;
  parameters?: Record<string, unknown>;
}

export class ModelRunRecorder {
  private readonly runs = new Map<string, ModelRun>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  /** One run per stage and backend, so a thirty-file project has one ASR run, not thirty. */
  record(input: ModelRunInput): string {
    const key = `${input.stage}:${input.backend}:${input.model ?? ''}`;
    const existing = this.runs.get(key);
    if (existing) return existing.id;

    const run: ModelRun = {
      id: newId('run'),
      stage: input.stage,
      backend: input.backend,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.modelVersion === undefined ? {} : { model_version: input.modelVersion }),
      locality: input.locality ?? 'unknown',
      parameters: input.parameters ?? {},
      cost_usd: 0,
      media_left_device: input.mediaLeavesDevice ?? false,
      created_at: this.now(),
    };
    this.runs.set(key, run);
    return run.id;
  }

  /** Records a run from a perception or decision backend's own identity. */
  fromIdentity(stage: PipelineStage, identity: ModelIdentity): string {
    return this.record({
      stage,
      backend: identity.backend,
      ...(identity.model === undefined ? {} : { model: identity.model }),
      ...(identity.modelVersion === undefined ? {} : { modelVersion: identity.modelVersion }),
      locality: identity.locality,
      mediaLeavesDevice: identity.mediaLeavesDevice,
      ...(identity.parameters === undefined ? {} : { parameters: identity.parameters }),
    });
  }

  /**
   * Takes back runs recorded by an earlier compile.
   *
   * Their ids are kept, because the observations that came back with them point
   * at those ids. A run already held under the same stage and backend wins, so
   * re-recording the same model in this compile does not produce two entries.
   */
  adopt(runs: readonly ModelRun[]): void {
    for (const run of runs) {
      const key = `${run.stage}:${run.backend}:${run.model ?? ''}`;
      if (!this.runs.has(key)) this.runs.set(key, { ...run });
    }
  }

  addCost(runId: string, costUsd: number, inputTokens?: number, outputTokens?: number): void {
    const run = [...this.runs.values()].find((r) => r.id === runId);
    if (!run) return;
    run.cost_usd = Math.round((run.cost_usd + costUsd) * 1_000_000) / 1_000_000;
    if (inputTokens !== undefined) run.input_tokens = (run.input_tokens ?? 0) + inputTokens;
    if (outputTokens !== undefined) run.output_tokens = (run.output_tokens ?? 0) + outputTokens;
  }

  addLatency(runId: string, latencyMs: number): void {
    const run = [...this.runs.values()].find((r) => r.id === runId);
    if (!run) return;
    run.latency_ms = (run.latency_ms ?? 0) + Math.round(latencyMs);
  }

  /** The run recorded for a stage, when there is exactly one to point at. */
  forStage(stage: PipelineStage): string | undefined {
    const matches = [...this.runs.values()].filter((run) => run.stage === stage);
    return matches.length === 1 ? matches[0]!.id : undefined;
  }

  all(): ModelRun[] {
    return [...this.runs.values()].sort(
      (a, b) => compareText(a.stage, b.stage) || compareText(a.id, b.id),
    );
  }

  totalCostUsd(): number {
    return (
      Math.round([...this.runs.values()].reduce((sum, r) => sum + r.cost_usd, 0) * 1_000_000) /
      1_000_000
    );
  }

  /** True when anything in this compile sent media off the machine. */
  anyMediaLeftDevice(): boolean {
    return [...this.runs.values()].some((r) => r.media_left_device);
  }
}
