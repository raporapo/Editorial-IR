import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Stable hashing of everything the pipeline caches on.
 *
 * The whole incremental story rests on this: the same media plus the same
 * settings must produce the same key, on any machine, in any key order, or the
 * cache is simultaneously useless and dangerous.
 */

/** JSON with object keys sorted, so key order cannot change a hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function hashObject(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Short form for identifiers and log lines. */
export function shortHash(value: unknown, length = 12): string {
  return hashObject(value).slice(0, length);
}

/** Streams a file through sha256, so an 80 GB source does not have to fit in memory. */
export async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * The key a perception result is cached under.
 *
 * Media hash, model identity and pipeline version all participate, because all
 * three change the answer. Leaving out the model would serve a small model's
 * transcript after the user switched to a large one; leaving out the pipeline
 * version would serve results from before a segmentation change.
 */
export interface CacheKeyParts {
  operation: string;
  mediaSha256: string;
  backend: string;
  model?: string;
  modelVersion?: string;
  parameters?: Record<string, unknown>;
  pipelineVersion: string;
}

export function cacheKey(parts: CacheKeyParts): string {
  return hashObject({
    op: parts.operation,
    media: parts.mediaSha256,
    backend: parts.backend,
    model: parts.model ?? null,
    model_version: parts.modelVersion ?? null,
    parameters: parts.parameters ?? {},
    pipeline: parts.pipelineVersion,
  });
}
