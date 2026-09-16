import {
  EditorialError,
  type BooleanRequest,
  type BooleanResult,
  type ChoiceRequest,
  type ChoiceResult,
  type EventState,
  type ScoreRequest,
  type ScoreResult,
} from '@editorial-ir/contracts';
import type { DecisionBackendIdentity, EditorialDecisionModel } from '../types.js';
import { argmax, normalise, prune } from '../distribution.js';
import { expectedUnitValue } from '@editorial-ir/contracts';

/**
 * An adapter for an external system-one decision service.
 *
 * The project is designed so that a fast, well-calibrated judgement API can be
 * dropped in where the rules currently sit — the three primitives were chosen to
 * match what such services offer. This is that seam.
 *
 * Two things about it are deliberate:
 *
 * - It is never required. Every test, every default configuration and the
 *   documented quick start run without it, and the same Editorial IR comes out.
 *   A project whose output quality depends on one vendor's API being up is not
 *   an open-source project in any useful sense.
 * - The endpoint paths are configuration rather than constants, because the
 *   remote contract is not ours and pinning it in code would make a change at
 *   the other end a release here.
 *
 * The expected shapes are documented in `docs/decision-backends.md`.
 */
export interface JevBackendOptions {
  baseUrl: string;
  apiKey?: string;
  /** Paths appended to `baseUrl`, one per primitive. */
  paths?: { choice?: string; score?: string; boolean?: string };
  timeoutMs?: number;
  baseConfidence?: number;
  costPerEventUsd?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_PATHS = { choice: '/choice', score: '/score', boolean: '/boolean' };

export class JevBackend implements EditorialDecisionModel {
  readonly identity: DecisionBackendIdentity;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly paths: Required<NonNullable<JevBackendOptions['paths']>>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: JevBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.paths = { ...DEFAULT_PATHS, ...options.paths };
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl;
    this.identity = {
      backend: 'jev',
      locality: 'remote_api',
      // Only the structured event state is sent: no frames, no audio.
      mediaLeavesDevice: false,
      baseConfidence: options.baseConfidence ?? 0.8,
      ...(options.costPerEventUsd === undefined ? {} : { costPerEventUsd: options.costPerEventUsd }),
      parameters: { base_url: this.baseUrl },
    };
  }

  async choice(state: EventState, request: ChoiceRequest): Promise<ChoiceResult> {
    const body = await this.post<{ selected?: string; probabilities?: Record<string, number> }>(
      this.paths.choice,
      { state, question: request.question, options: request.options.map((o) => o.value), option_descriptions: request.options },
    );
    const probabilities = prune(
      normalise(body.probabilities ?? Object.fromEntries(request.options.map((o) => [o.value, 1]))),
    );
    const selected = body.selected ?? argmax(probabilities);
    if (!request.options.some((o) => o.value === selected)) {
      throw new EditorialError('decision_failed', `decision service chose an option that was not offered`, {
        selected,
        offered: request.options.map((o) => o.value),
      });
    }
    return { selected, probabilities };
  }

  async score(state: EventState, request: ScoreRequest): Promise<ScoreResult> {
    const body = await this.post<{ level?: number; probabilities?: number[] }>(this.paths.score, {
      state,
      question: request.question,
      levels: request.levels,
    });
    const count = request.levels.length;
    const probabilities = body.probabilities ?? [];
    if (probabilities.length === count) {
      const total = probabilities.reduce((a, b) => a + b, 0) || 1;
      const normalised = probabilities.map((p) => Math.max(0, p) / total);
      return {
        level: normalised.indexOf(Math.max(...normalised)),
        // Recomputed locally so that the stored value always matches the stored
        // distribution, whatever the service reported.
        value: expectedUnitValue(normalised, count),
        probabilities: normalised,
      };
    }
    const level = Math.min(count - 1, Math.max(0, Math.round(body.level ?? 0)));
    return { level, value: count > 1 ? level / (count - 1) : 0, probabilities: [] };
  }

  async booleanProbability(state: EventState, request: BooleanRequest): Promise<BooleanResult> {
    const body = await this.post<{ probability?: number }>(this.paths.boolean, {
      state,
      statement: request.statement,
    });
    return { probability: Math.min(1, Math.max(0, body.probability ?? 0.5)) };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await doFetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new EditorialError('decision_failed', `decision service returned ${response.status}`, {
          path,
          status: response.status,
        });
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
