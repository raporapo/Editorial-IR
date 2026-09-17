import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PythonWorkerClient, workerHealth } from '@editorial-ir/perception';
import { HashingTextEmbedding } from '@editorial-ir/perception';

/**
 * The TypeScript client against the real Python worker.
 *
 * Every other test of this boundary mocks one side. This one does not: it starts
 * the shipped worker and talks to it over the real protocol. It is the only
 * place that would catch the two implementations having drifted — a renamed
 * field, a changed default, a result that no longer validates — which is exactly
 * the failure a schema-first boundary exists to prevent and exactly the one that
 * unit tests on either side cannot see.
 *
 * It needs Python and nothing else: no models, no ffmpeg, no network.
 */
const WORKER_SRC = fileURLToPath(new URL('../services/perception/src', import.meta.url));

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeIfPython = pythonAvailable() ? describe : describe.skip;

function makeClient(): PythonWorkerClient {
  return new PythonWorkerClient({
    command: 'python3',
    args: ['-m', 'editorial_perception'],
    env: { PYTHONPATH: WORKER_SRC },
    timeoutMs: 30_000,
  });
}

describeIfPython('the Python worker, over the real protocol', () => {
  it('reports what it can actually do', async () => {
    const client = makeClient();
    try {
      const health = await client.request('health', {});
      expect(health.protocol_version).toBe('0.1.0');
      // Answered by importing, not by claiming.
      expect(typeof health.capabilities.probe).toBe('boolean');
      expect(health.capabilities.embed_text).toBe(true);
      expect(health.python_version).toMatch(/^3\./);
    } finally {
      await client.close(2000);
    }
  }, 30_000);

  it('produces text vectors the TypeScript side can use directly', async () => {
    const client = makeClient();
    try {
      const texts = ['やっと着いた', 'night view', ''];
      const result = await client.request('embed_text', { texts, role: 'passage' });

      expect(result.dim).toBe(256);
      expect(result.vectors).toHaveLength(3);

      // The same vectors, to the last decimal. An index built by one side and
      // queried by the other has to land in the same space.
      const local = new HashingTextEmbedding();
      const expected = await local.embed(texts);
      for (const [index, vector] of result.vectors.entries()) {
        expect(vector).toHaveLength(256);
        for (let i = 0; i < vector.length; i++) {
          expect(vector[i]).toBeCloseTo(expected[index]![i]!, 9);
        }
      }
    } finally {
      await client.close(2000);
    }
  }, 30_000);

  it('reports a bad request without dying', async () => {
    const client = makeClient();
    try {
      await expect(client.request('probe', {})).rejects.toThrow(/bad_request/);
      // Still alive afterwards, which is the point.
      const health = await client.request('health', {});
      expect(health.worker_version).toBeTruthy();
    } finally {
      await client.close(2000);
    }
  }, 30_000);

  it('reports an unsupported op rather than hanging', async () => {
    const client = makeClient();
    try {
      // @ts-expect-error deliberately not a real op, to check the reply shape
      await expect(client.request('teleport', {})).rejects.toThrow(/unsupported_op/);
    } finally {
      await client.close(2000);
    }
  }, 30_000);

  it('reports honestly what it cannot do, rather than failing when asked', async () => {
    // The worker declares its capabilities, and the CLI wires only the models it
    // says it has. Wiring one it has just said it cannot run turns "this stage
    // is unavailable" into "the whole analysis failed" — which is what happened:
    // `--perception python` on a machine with no vision model died at the first
    // event instead of producing an IR, contradicting the one promise every
    // layer of this project makes about degrading.
    const client = makeClient();
    try {
      const health = await workerHealth(client);
      expect(health.capabilities).toBeTruthy();

      // A bare install has no models, so most of these are false — and false is
      // an answer, not a failure.
      const values = Object.values(health.capabilities as Record<string, unknown>);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) expect(typeof value).toBe('boolean');
    } finally {
      await client.close(2000);
    }
  }, 30_000);

  it('shuts down when asked', async () => {
    const client = makeClient();
    await client.request('health', {});
    expect(client.running).toBe(true);
    await client.close(5000);
    expect(client.running).toBe(false);
  }, 30_000);
});

/**
 * What a timeout leaves behind.
 *
 * The worker is strictly serial and has no cancellation, so giving up on a
 * request does not give the worker back. It stands in for a slow file with a
 * stub that never answers one particular op.
 */
describeIfPython('a request that times out', () => {
  const STALLING = fileURLToPath(new URL('./support/stalling-worker.py', import.meta.url));

  function stallingClient(): PythonWorkerClient {
    return new PythonWorkerClient({ command: 'python3', args: [STALLING] });
  }

  it('does not leave the next request queued behind it', async () => {
    const client = stallingClient();
    try {
      await expect(client.request('probe', { path: '/nope' }, { timeoutMs: 300 })).rejects.toThrow(
        /timed out/,
      );

      // Without a restart this waits behind the abandoned probe and times out
      // too — and so does everything after it, for the rest of the run.
      const started = Date.now();
      const health = await client.request('health', {}, { timeoutMs: 5000 });
      expect(health.worker_version).toBe('stalling');
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await client.close(2000);
    }
  }, 30_000);

  it('fails everything the abandoned worker was still holding', async () => {
    const client = stallingClient();
    try {
      const first = client.request('probe', { path: '/nope' }, { timeoutMs: 300 });
      const second = client.request('probe', { path: '/nope-either' }, { timeoutMs: 20_000 });
      await expect(first).rejects.toThrow(/timed out/);
      // Queued behind the first and therefore already lost. Saying so beats
      // letting it discover that twenty seconds later.
      await expect(second).rejects.toThrow(/restarted/);
    } finally {
      await client.close(2000);
    }
  }, 30_000);
});
