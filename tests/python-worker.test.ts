import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PythonWorkerClient,
  WorkerContextModel,
  WorkerSpeechModel,
  workerHealth,
} from '@editorial-ir/perception';
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

/**
 * Where the worker's closer look actually runs.
 *
 * The worker is not always the machine the work happens on: `describe` is an
 * HTTP call to whatever `OEA_VLM_BASE_URL` names, and this process cannot see
 * that variable. The client recorded every worker-backed stage as local, so a
 * run that posted the user's transcripts and background to a hosted endpoint
 * was written into the IR as having stayed here — and the privacy report said
 * so. Provenance is never falsified.
 */
describeIfPython('a closer look the worker runs somewhere else', () => {
  function clientWith(env: Record<string, string>): PythonWorkerClient {
    return new PythonWorkerClient({
      command: 'python3',
      args: ['-m', 'editorial_perception'],
      env: { PYTHONPATH: WORKER_SRC, ...env },
      timeoutMs: 30_000,
    });
  }

  async function localityWith(env: Record<string, string>): Promise<string> {
    const client = clientWith(env);
    try {
      return (await workerHealth(client)).stage_locality.describe ?? 'unknown';
    } finally {
      await client.close(2000);
    }
  }

  it('says remote when its endpoint is somewhere else', async () => {
    expect(
      await localityWith({ OEA_VLM_BASE_URL: 'https://api.example.com/v1', OEA_VLM_MODEL: 'm' }),
    ).toBe('remote_api');
  }, 30_000);

  it('says local when its endpoint is on this machine', async () => {
    expect(
      await localityWith({ OEA_VLM_BASE_URL: 'http://localhost:11434/v1', OEA_VLM_MODEL: 'm' }),
    ).toBe('local');
  }, 30_000);

  it('records what the worker said, not what is convenient', async () => {
    const client = clientWith({});
    try {
      const remote = new WorkerContextModel(client, 'vlm', 'remote_api');
      expect(remote.identity.locality).toBe('remote_api');
      // A remote endpoint can be sent frames, so media may leave with it — the
      // same rule the TypeScript VLM backend follows.
      expect(remote.identity.mediaLeavesDevice).toBe(true);

      const local = new WorkerContextModel(client, 'vlm', 'local');
      expect(local.identity.locality).toBe('local');
      expect(local.identity.mediaLeavesDevice).toBe(false);

      // A worker that did not answer the question leaves this unknown, which is
      // the honest answer rather than the reassuring one.
      expect(new WorkerContextModel(client).identity.locality).toBe('unknown');
    } finally {
      await client.close(2000);
    }
  }, 30_000);
});

/**
 * Which model a worker-backed stage actually used.
 *
 * The perception cache keys on the model's name, and every worker-backed stage
 * reported a placeholder — `asr`, `vlm`, `text-embedding` — because the name is
 * decided by an environment variable inside the worker. So a user unhappy with
 * a transcript who set `OEA_ASR_MODEL=large-v3` and re-ran was served the small
 * model's transcript, under a line saying the analysis had been reused because
 * nothing that affects it had changed. The IR said the stage ran on a model
 * called `asr`, which is not a model.
 */
describeIfPython('which model the worker would use', () => {
  async function models(env: Record<string, string>): Promise<Record<string, string>> {
    const client = new PythonWorkerClient({
      command: 'python3',
      args: ['-m', 'editorial_perception'],
      env: { PYTHONPATH: WORKER_SRC, ...env },
      timeoutMs: 30_000,
    });
    try {
      return (await workerHealth(client)).stage_models;
    } finally {
      await client.close(2000);
    }
  }

  it('names the transcription model, and changes when the user changes it', async () => {
    expect((await models({ OEA_ASR_MODEL: 'small' })).transcribe).toBe('small/int8');
    expect((await models({ OEA_ASR_MODEL: 'large-v3' })).transcribe).toBe('large-v3/int8');
  }, 60_000);

  it('counts the compute type as part of the model, because it changes the output', async () => {
    expect((await models({ OEA_ASR_MODEL: 'small', OEA_ASR_COMPUTE: 'float16' })).transcribe).toBe(
      'small/float16',
    );
  }, 30_000);

  it('names the vision model too', async () => {
    expect((await models({ OEA_VISUAL_MODEL: 'openai/clip-vit-base-patch32' })).embed_frames).toBe(
      'openai/clip-vit-base-patch32',
    );
  }, 30_000);

  it('carries the name onto the identity the cache keys on', async () => {
    const client = new PythonWorkerClient({
      command: 'python3',
      args: ['-m', 'editorial_perception'],
      env: { PYTHONPATH: WORKER_SRC },
    });
    try {
      expect(new WorkerSpeechModel(client, 'large-v3/int8').identity.model).toBe('large-v3/int8');
      // A worker that did not answer leaves the placeholder, which at least does
      // not claim to be a model anyone chose.
      expect(new WorkerSpeechModel(client).identity.model).toBe('asr');
    } finally {
      await client.close(2000);
    }
  }, 30_000);
});
