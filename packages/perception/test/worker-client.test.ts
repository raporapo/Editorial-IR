import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PythonWorkerClient } from '../src/index.js';

const WORKER = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url));

const clients: PythonWorkerClient[] = [];

function makeClient(mode = 'normal', options: Record<string, unknown> = {}): PythonWorkerClient {
  const client = new PythonWorkerClient({
    command: process.execPath,
    args: [WORKER, mode],
    timeoutMs: 10_000,
    ...options,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close(500)));
});

describe('PythonWorkerClient', () => {
  it('round-trips a request and validates the reply', async () => {
    const client = makeClient();
    const result = await client.request('probe', { path: '/tmp/a.mov' });
    expect(result.duration_ms).toBe(1234);
  });

  it('reports progress without confusing it for a reply', async () => {
    const progress: number[] = [];
    const client = makeClient('normal', {
      onProgress: (event: { progress?: number }) => {
        if (event.progress !== undefined) progress.push(event.progress);
      },
    });
    await client.request('probe', { path: '/tmp/a.mov' });
    expect(progress).toEqual([0.5]);
  });

  it('correlates concurrent requests by id', async () => {
    const client = makeClient();
    const [a, b] = await Promise.all([
      client.request('embed_text', { texts: ['one'], role: 'passage' }),
      client.request('probe', { path: '/tmp/a.mov' }),
    ]);
    expect(a.vectors).toHaveLength(1);
    expect(b.duration_ms).toBe(1234);
  });

  it('turns a worker error into a coded failure', async () => {
    const client = makeClient();
    await expect(client.request('transcribe', { audio_path: '/tmp/a.wav' })).rejects.toThrow(
      /missing_dependency/,
    );
  });

  it('rejects a malformed result instead of letting it reach the compiler', async () => {
    const client = makeClient();
    await expect(client.request('detect_shots', { path: '/tmp/a.mov' })).rejects.toThrow(
      /failed validation/,
    );
  });

  it('survives a dependency printing to stdout', async () => {
    const logs: string[] = [];
    const client = makeClient('noise', { onLog: (line: string) => void logs.push(line) });
    const result = await client.request('probe', { path: '/tmp/a.mov' });
    expect(result.duration_ms).toBe(1234);
    expect(logs.some((l) => l.includes('Downloading model'))).toBe(true);
  });

  it('times out rather than hanging the run forever', async () => {
    const client = makeClient('slow', { timeoutMs: 150 });
    await expect(client.request('probe', { path: '/tmp/a.mov' })).rejects.toThrow(/timed out/);
  });

  it('fails pending requests when the worker dies', async () => {
    // 'slow' never answers a probe, so the request is still in flight when the
    // worker is told to exit.
    const client = makeClient('slow');
    await client.request('health', {});
    const pending = client.request('probe', { path: '/tmp/a.mov' });
    void client.request('shutdown', {}).catch(() => undefined);
    await expect(pending).rejects.toThrow(/worker exited|not running/);
  });

  it('reports an unusable command clearly', async () => {
    const client = new PythonWorkerClient({ command: '/nonexistent/python', timeoutMs: 2000 });
    clients.push(client);
    await expect(client.request('health', {})).rejects.toThrow(/perception worker/);
  });

  it('shuts down cleanly', async () => {
    const client = makeClient();
    await client.request('health', {});
    expect(client.running).toBe(true);
    await client.close(2000);
    expect(client.running).toBe(false);
  });
});

describe('version skew', () => {
  it('settles a request whose reply it cannot read, rather than hanging', async () => {
    // A worker from a future version answering with a shape this one does not
    // know. Leaving the request pending would turn a protocol mismatch into a
    // hang, which is far worse than an error.
    const client = makeClient('normal');
    const pending = client.request('detect_shots', {
      path: '/tmp/a.mov',
      threshold: 0.3,
      min_shot_ms: 800,
    });
    await expect(pending).rejects.toThrow(/failed validation|cannot read/);
  });
});
