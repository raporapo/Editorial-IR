import { describe, expect, it } from 'vitest';
import { ModelRunRecorder } from '../src/index.js';

/**
 * The provenance trail.
 *
 * Every value in an Editorial IR points at a model run rather than naming a
 * model, so this is where model identity actually lives — along with the answer
 * to "did any of my footage leave this machine", which a user is entitled to
 * precisely.
 */
const now = () => '2026-05-17T09:00:00.000Z';

describe('ModelRunRecorder', () => {
  it('records one run per stage and backend, not one per file', () => {
    const runs = new ModelRunRecorder(now);
    const first = runs.record({
      stage: 'speech',
      backend: 'python-worker',
      model: 'whisper-small',
    });
    const second = runs.record({
      stage: 'speech',
      backend: 'python-worker',
      model: 'whisper-small',
    });

    // A thirty-file project has one ASR run, not thirty.
    expect(first).toBe(second);
    expect(runs.all()).toHaveLength(1);
  });

  it('keeps different models apart', () => {
    const runs = new ModelRunRecorder(now);
    runs.record({ stage: 'speech', backend: 'python-worker', model: 'small' });
    runs.record({ stage: 'speech', backend: 'python-worker', model: 'large' });
    expect(runs.all()).toHaveLength(2);
  });

  it('adopts a backend’s own identity', () => {
    const runs = new ModelRunRecorder(now);
    const id = runs.fromIdentity('visual', {
      backend: 'python-worker',
      model: 'siglip',
      locality: 'local',
      mediaLeavesDevice: false,
      parameters: { dim: 768 },
    });
    const run = runs.all().find((entry) => entry.id === id)!;
    expect(run.model).toBe('siglip');
    expect(run.parameters).toEqual({ dim: 768 });
  });

  it('accumulates cost and tokens across calls', () => {
    const runs = new ModelRunRecorder(now);
    const id = runs.record({ stage: 'context', backend: 'openai-compatible', model: 'a-model' });
    runs.addCost(id, 0.004, 800, 60);
    runs.addCost(id, 0.004, 700, 55);
    runs.addLatency(id, 1200);

    const run = runs.all()[0]!;
    expect(run.cost_usd).toBeCloseTo(0.008, 6);
    expect(run.input_tokens).toBe(1500);
    expect(run.output_tokens).toBe(115);
    expect(run.latency_ms).toBe(1200);
    expect(runs.totalCostUsd()).toBeCloseTo(0.008, 6);
  });

  it('answers whether anything left the machine', () => {
    const runs = new ModelRunRecorder(now);
    runs.record({ stage: 'speech', backend: 'python-worker', mediaLeavesDevice: false });
    expect(runs.anyMediaLeftDevice()).toBe(false);

    runs.record({ stage: 'context', backend: 'openai-compatible', mediaLeavesDevice: true });
    expect(runs.anyMediaLeftDevice()).toBe(true);
  });

  it('ignores cost added to a run that does not exist', () => {
    const runs = new ModelRunRecorder(now);
    runs.addCost('run_nothing', 5);
    expect(runs.totalCostUsd()).toBe(0);
  });

  it('returns runs in a stable order', () => {
    const runs = new ModelRunRecorder(now);
    runs.record({ stage: 'visual', backend: 'b' });
    runs.record({ stage: 'speech', backend: 'a' });
    expect(runs.all().map((run) => run.stage)).toEqual(['speech', 'visual']);
  });
});
