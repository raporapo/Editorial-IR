import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheKey, type CacheKeyParts } from './fingerprint.js';

/**
 * A content-addressed cache for perception results.
 *
 * Transcribing an hour of audio is minutes of GPU time. Doing it again because
 * the user added a sentence to the project background would be indefensible, so
 * the expensive stages are keyed by what actually determines their output and
 * nothing else.
 */
export interface PerceptionCache {
  get<T>(parts: CacheKeyParts): T | undefined;
  /**
   * The entry, if there is one, without counting a hit or a miss.
   *
   * For asking whether a call that is *not* going to be made would have been
   * free. A skipped call that the cache would have answered saved nothing, and
   * finding that out with `get` counted a miss for every call not made — so the
   * report's "N computed" grew with every saving.
   */
  peek<T>(parts: CacheKeyParts): T | undefined;
  set(parts: CacheKeyParts, value: unknown): void;
  readonly hits: number;
  readonly misses: number;
}

export class FileCache implements PerceptionCache {
  hits = 0;
  misses = 0;

  constructor(private readonly directory: string) {}

  private pathFor(parts: CacheKeyParts): string {
    const key = cacheKey(parts);
    // Two hex characters of fan-out: a project with thousands of entries should
    // not put them all in one directory.
    return join(this.directory, key.slice(0, 2), `${key}.json`);
  }

  get<T>(parts: CacheKeyParts): T | undefined {
    const value = this.peek<T>(parts);
    if (value === undefined) this.misses++;
    else this.hits++;
    return value;
  }

  peek<T>(parts: CacheKeyParts): T | undefined {
    const path = this.pathFor(parts);
    if (!existsSync(path)) return undefined;
    try {
      return (JSON.parse(readFileSync(path, 'utf8')) as { value: T }).value;
    } catch {
      // A truncated entry from an interrupted write is a miss, not a crash.
      return undefined;
    }
  }

  set(parts: CacheKeyParts, value: unknown): void {
    const path = this.pathFor(parts);
    mkdirSync(join(path, '..'), { recursive: true });
    // Write beside and rename, so an interrupted run leaves no half-written
    // entry that would be read back as a valid result.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({
        key: cacheKey(parts),
        operation: parts.operation,
        written_at: new Date().toISOString(),
        value,
      }),
    );
    renameSync(temporary, path);
  }
}

/** A cache that remembers nothing, for tests and for `--no-cache`. */
export class NullCache implements PerceptionCache {
  hits = 0;
  misses = 0;
  get(): undefined {
    this.misses++;
    return undefined;
  }
  peek(): undefined {
    return undefined;
  }
  set(): void {
    // Intentionally empty.
  }
}

/** An in-memory cache, for tests that want to observe reuse. */
export class MemoryCache implements PerceptionCache {
  hits = 0;
  misses = 0;
  private readonly entries = new Map<string, unknown>();

  get<T>(parts: CacheKeyParts): T | undefined {
    const value = this.peek<T>(parts);
    if (value === undefined) this.misses++;
    else this.hits++;
    return value;
  }

  peek<T>(parts: CacheKeyParts): T | undefined {
    return this.entries.get(cacheKey(parts)) as T | undefined;
  }

  set(parts: CacheKeyParts, value: unknown): void {
    this.entries.set(cacheKey(parts), value);
  }
}
