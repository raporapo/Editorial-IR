import { describe, expect, it } from 'vitest';
import { compileProject } from '@editorial-ir/core';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { HeuristicContextModel, type ContextModel } from '@editorial-ir/perception';
import type { DescribeParams, DescribeResult } from '@editorial-ir/contracts';
import { exampleSuite, makeExampleProject } from './support/project.js';

/**
 * What a second run costs.
 *
 * The expensive stages are understanding and judgement, and both are keyed on
 * what they actually depend on. Editing an annotation or changing the target
 * duration must not re-run a vision-language model over three hundred events —
 * that is the difference between a tool someone uses daily and one they run
 * once.
 */
class CountingContextModel implements ContextModel {
  readonly identity;
  calls = 0;

  constructor(private readonly inner = new HeuristicContextModel()) {
    this.identity = { ...inner.identity, backend: 'counting' };
  }

  async describe(params: DescribeParams): Promise<DescribeResult> {
    this.calls++;
    return this.inner.describe(params);
  }
}

class CountingDecision extends HeuristicDecisionBackend {
  calls = 0;

  override async score(...args: Parameters<HeuristicDecisionBackend['score']>) {
    this.calls++;
    return super.score(...args);
  }
}

async function project() {
  const store = await makeExampleProject();
  const context = new CountingContextModel();
  const decision = new CountingDecision();
  const suite = { ...exampleSuite(), context };
  const compile = () => compileProject({ store, suite, decision });
  return { store, context, decision, compile };
}

describe('running it again', () => {
  it('costs nothing when nothing changed', async () => {
    const { context, decision, compile } = await project();

    await compile();
    const understood = context.calls;
    const judged = decision.calls;
    expect(understood).toBeGreaterThan(50);
    expect(judged).toBeGreaterThan(50);

    await compile();
    // Not one call to either. With a hosted model this is the difference
    // between free and a full pass.
    expect(context.calls).toBe(understood);
    expect(decision.calls).toBe(judged);
  }, 60_000);

  it('costs nothing when only the target duration changed', async () => {
    const { store, context, decision, compile } = await project();
    await compile();
    const before = { understood: context.calls, judged: decision.calls };

    const projectContext = store.readContext();
    store.writeContext({
      ...projectContext,
      editing_goal: { ...projectContext.editing_goal, target_duration_ms: 40_000 },
    });

    await compile();
    // How long the piece should be has nothing to do with what happened in it,
    // or with what any of it is worth.
    expect(context.calls).toBe(before.understood);
    expect(decision.calls).toBe(before.judged);
  }, 60_000);

  it('re-understands everything when the occasion changed, because it should', async () => {
    const { store, context, compile } = await project();
    await compile();
    const before = context.calls;

    const projectContext = store.readContext();
    store.writeContext({
      ...projectContext,
      background: { ...projectContext.background, occasion: '友人との旅行' },
    });

    await compile();
    // The occasion is shown to the model and changes what the events mean, so
    // caching it would be wrong rather than clever.
    expect(context.calls).toBeGreaterThan(before);
  }, 60_000);

  it('re-judges an event whose annotation changed, and no others', async () => {
    const { store, decision, compile } = await project();
    const first = await compile();
    const before = decision.calls;

    const target = first.ir.events[5]!.id;
    store.writeAnnotations([
      {
        id: 'ann_0001',
        type: 'essential',
        target: { kind: 'event', event_id: target },
        anchor: [],
        priority: 0,
        created_at: '2026-05-17T09:00:00.000Z',
      },
    ]);

    await compile();
    const spent = decision.calls - before;
    // One event's state changed, so one event is re-judged. Ten questions,
    // asked one at a time by the rule-based backend.
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(before / 4);
  }, 60_000);

  it('serves perception from the cache even before anything is persisted', async () => {
    const { store, compile } = await project();
    await compile();
    const hitsAfterFirst = store.cache.hits;

    const second = await compile();
    // Nothing was written to the project between the two runs, so the
    // observation document is reassembled — but every model call behind it is a
    // cache hit, which is where the time and the money are.
    expect(second.report.reusedObservations).toBe(false);
    expect(store.cache.hits).toBeGreaterThan(hitsAfterFirst);
  }, 60_000);

  it('skips reassembly entirely once the observations are stored', async () => {
    const { store, compile } = await project();
    const first = await compile();
    // What `oea analyze` does at the end of a run.
    store.writeObservations(first.observations);

    const second = await compile();
    expect(second.report.reusedObservations).toBe(true);
  }, 60_000);
});

/**
 * What a second run still has to say about itself.
 *
 * Reuse is the normal path — `oea annotate` ends by telling you to take it —
 * and it must not cost the representation anything it is supposed to carry.
 */
describe('what survives reusing an analysis', () => {
  it('keeps the runs its observations point at', async () => {
    const { store, compile } = await project();
    const first = await compile();
    // What the CLI does after a compile, and what makes the next one a reuse.
    store.writeObservations(first.observations);
    const perceptionStages = first.ir.model_runs
      .map((run) => run.stage)
      .filter((stage) => stage !== 'context' && stage !== 'decision');
    expect(perceptionStages.length).toBeGreaterThan(0);

    const second = await compile();
    const known = new Set(second.ir.model_runs.map((run) => run.id));
    const observations = store.readObservations()!;
    const referenced = [
      ...observations.utterances,
      ...observations.shots,
      ...observations.audio_events,
      ...observations.ocr,
      ...observations.frame_features,
      ...observations.audio_profiles,
    ]
      .map((observation) => observation.model_run_id)
      .filter((id): id is string => id !== undefined);

    expect(referenced.length).toBeGreaterThan(0);
    // Every one of these pointed at nothing: the runs lived only in the IR of
    // the compile that made them, so re-analysing left the whole perception
    // half of the provenance trail — and of the privacy report — dangling.
    expect([...new Set(referenced)].filter((id) => !known.has(id))).toEqual([]);
    for (const stage of perceptionStages) {
      expect(second.ir.model_runs.map((run) => run.stage)).toContain(stage);
    }
  }, 60_000);

  it('does not lose the visual stage to a reuse', async () => {
    // A reuse used to throw the frame vectors away, and the report said "no
    // model configured", which was a true sentence about a different situation.
    // The vectors are kept now, so there is nothing to report — and the reason,
    // where there is one, belongs to the entry rather than to whoever prints it.
    const { store, compile } = await project();
    const first = await compile();
    store.writeObservations(first.observations);
    const second = await compile();

    expect(first.report.unavailable.map((entry) => entry.stage)).not.toContain('visual');
    expect(second.report.unavailable.map((entry) => entry.stage)).not.toContain('visual');
  }, 60_000);
});

/**
 * The same project, compiled twice.
 *
 * Reusing an observation set is the normal path, and it produced a materially
 * different analysis: frame vectors were held in memory and thrown away, so the
 * second compile segmented without the visual signal and indexed the visual
 * aspect out of the vision model's space and into hashed text. Both carried the
 * identical fingerprint — it is computed over the media and the models, not
 * over what was produced — so nothing downstream could tell them apart.
 */
describe('compiling an unchanged project again', () => {
  it('produces the same events and the same index', async () => {
    const { store, compile } = await project();
    const first = await compile();
    store.writeObservations(first.observations);

    const second = await compile();
    expect(second.report.reusedObservations).toBe(true);
    expect(second.ir.fingerprint).toBe(first.ir.fingerprint);

    expect(second.ir.events).toEqual(first.ir.events);
    expect(second.ir.relations).toEqual(first.ir.relations);

    // A model run's id is deliberately random — `newId` is for "documents that
    // could collide if produced independently", and a run is one — so the
    // vectors are compared as vectors, and the runs they point at are compared
    // as runs.
    const vectorsOf = (records: typeof first.embeddings.records) =>
      records.map(({ model_run_id: _run, ...rest }) => rest);
    expect(vectorsOf(second.embeddings.records)).toEqual(vectorsOf(first.embeddings.records));

    const named = (ir: typeof first.ir, records: typeof first.embeddings.records) =>
      records.map((record) => {
        const run = ir.model_runs.find((r) => r.id === record.model_run_id);
        return `${record.id} <- ${run?.stage}:${run?.backend}:${run?.model ?? ''}`;
      });
    expect(named(second.ir, second.embeddings.records)).toEqual(
      named(first.ir, first.embeddings.records),
    );
  }, 60_000);

  it('keeps the frame vectors, and only for the analysis they belong to', async () => {
    const { store, compile } = await project();
    const first = await compile();
    store.writeObservations(first.observations);

    const kept = store.readFrameVectors(first.observations.fingerprint);
    expect(kept?.size).toBeGreaterThan(0);
    // Vectors from some other analysis are not a cache hit, they are the wrong
    // answer, so they are only handed back for the fingerprint that made them.
    expect(store.readFrameVectors('some other analysis')).toBeUndefined();
  }, 60_000);

  it('says so when it reused an analysis that has none', async () => {
    const { store, compile } = await project();
    const first = await compile();
    store.writeObservations(first.observations);
    // A project analysed before the sidecar existed.
    store.writeFrameVectors(first.observations.fingerprint, new Map());

    const second = await compile();
    const visual = second.report.unavailable.find((entry) => entry.stage === 'visual');
    expect(visual?.reason).toMatch(/before frame vectors were kept/);
  }, 60_000);
});
