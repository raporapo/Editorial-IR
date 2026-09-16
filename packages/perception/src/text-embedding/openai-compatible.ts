import { EditorialError } from '@editorial-ir/contracts';
import type { ModelIdentity, TextEmbeddingModel } from '../types.js';
import { l2normalize } from './hashing.js';

/**
 * Any embedding service that speaks the OpenAI `/v1/embeddings` shape.
 *
 * That covers the hosted providers and, more usefully, every local server that
 * imitates them — Ollama, vLLM, LM Studio, text-embeddings-inference. One client
 * therefore serves both the bring-your-own-key path and the fully local path,
 * and neither is privileged in the code.
 */
export interface OpenAiCompatibleEmbeddingOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  dim?: number;
  /** Texts per request. Providers differ; 64 is safe. */
  batchSize?: number;
  timeoutMs?: number;
  /** True when the endpoint is not on this machine. Drives the privacy report. */
  remote?: boolean;
  fetchImpl?: typeof fetch;
}

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

export class OpenAiCompatibleTextEmbedding implements TextEmbeddingModel {
  readonly identity: ModelIdentity;
  /** Filled in from the first response, because providers do not all declare it. */
  dim: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: OpenAiCompatibleEmbeddingOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.batchSize = options.batchSize ?? 64;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl;
    this.dim = options.dim ?? 0;
    const remote = options.remote ?? !LOCAL_HOST.test(this.baseUrl);
    this.identity = {
      backend: 'openai-compatible',
      model: options.model,
      locality: remote ? 'remote_api' : 'local',
      mediaLeavesDevice: remote,
      parameters: { base_url: this.baseUrl, model: options.model },
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + this.batchSize))));
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await doFetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new EditorialError('perception_failed', `embedding request failed with ${response.status}`, {
          status: response.status,
          body: (await response.text()).slice(0, 500),
        });
      }
      const payload = (await response.json()) as { data?: { embedding?: number[] }[] };
      const rows = payload.data ?? [];
      if (rows.length !== batch.length) {
        throw new EditorialError('perception_failed', 'embedding response length mismatch', {
          expected: batch.length,
          received: rows.length,
        });
      }
      return rows.map((row) => {
        const vector = row.embedding ?? [];
        if (this.dim === 0) this.dim = vector.length;
        return l2normalize(vector);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
