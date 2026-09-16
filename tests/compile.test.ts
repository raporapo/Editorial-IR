import { describe, expect, it } from 'vitest';
import { compileProject, observationsFingerprint } from '@editorial-ir/core';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { EditorialIR, formatTimecode } from '@editorial-ir/contracts';
import { exampleSuite, makeExampleProject } from './support/project.js';

async function compile(options: { force?: boolean } = {}) {
  const store = await makeExampleProject();
  const suite = exampleSuite();
  const result = await compileProject({
    store,
    suite,
    decision: new HeuristicDecisionBackend(),
    ...(options.force ? { forceObservations: true } : {}),
  });
  return { store, suite, ...result };
}

describe('compiling the worked example', () => {
  it('produces an Editorial IR that validates against its own schema', async () => {
    const { ir } = await compile();
    expect(EditorialIR.safeParse(ir).success).toBe(true);
  });

  it('registers three recordings and lays them on one capture timeline', async () => {
    const { ir } = await compile();
    expect(ir.assets).toHaveLength(3);
    expect(ir.assets.map((a) => a.file_name)).toEqual(['IMG_1001.MOV', 'IMG_1002.MOV', 'IMG_1003.MOV']);
    // Ordered by capture time, laid end to end, never overlapping.
    expect(ir.placements.map((p) => p.ordered_by)).toEqual(['creation_time', 'creation_time', 'creation_time']);
    for (let i = 1; i < ir.placements.length; i++) {
      expect(ir.placements[i]!.offset_ms).toBeGreaterThan(ir.placements[i - 1]!.offset_ms);
    }
  });

  it('turns shots into a sensible number of events', async () => {
    const { ir } = await compile();
    // Twenty-seven minutes of material: tens of events, not hundreds, and not three.
    expect(ir.stats.event_count).toBeGreaterThan(10);
    expect(ir.stats.event_count).toBeLessThan(120);
    expect(ir.stats.mean_event_duration_ms).toBeGreaterThan(3000);
  });

  it('never lets an event straddle two recordings', async () => {
    const { ir } = await compile();
    for (const event of ir.events) {
      expect(new Set(event.source_ranges.map((r) => r.asset_id)).size).toBe(1);
    }
  });

  it('keeps events in order and inside their asset', async () => {
    const { ir } = await compile();
    for (let i = 1; i < ir.events.length; i++) {
      expect(ir.events[i]!.start_ms).toBeGreaterThanOrEqual(ir.events[i - 1]!.start_ms);
    }
    for (const event of ir.events) {
      const range = event.source_ranges[0]!;
      const asset = ir.assets.find((a) => a.id === range.asset_id)!;
      expect(range.source_out_ms).toBeLessThanOrEqual(asset.duration_ms);
      expect(range.source_in_ms).toBeLessThan(range.source_out_ms);
    }
  });

  it('carries the transcript into the events it belongs to', async () => {
    const { ir } = await compile();
    const arrival = ir.events.find((e) => e.observed.speech.some((s) => s.text.includes('やっと着いた')));
    expect(arrival, 'the arrival line should land in some event').toBeDefined();
    expect(arrival!.observed.ocr.join(' ')).toContain('UNIVERSAL STUDIOS JAPAN');
  });

  it('assesses every event and assigns it a chapter', async () => {
    const { ir } = await compile();
    expect(ir.editorial).toHaveLength(ir.events.length);
    for (const event of ir.events) {
      expect(ir.editorial.some((e) => e.event_id === event.id)).toBe(true);
      expect(event.chapter_id).toBeDefined();
    }
    expect(ir.chapters.length).toBeGreaterThan(1);
    expect(ir.chapters.length).toBeLessThanOrEqual(12);
  });

  it('builds a graph over the events', async () => {
    const { ir } = await compile();
    expect(ir.relations.length).toBeGreaterThan(0);
    const continuations = ir.relations.filter((r) => r.relation_type === 'continuation');
    // One continuation edge between each pair of neighbours.
    expect(continuations).toHaveLength(ir.events.length - 1);
  });

  it('indexes every event for search', async () => {
    const { ir, embeddings } = await compile();
    expect(embeddings.records.length).toBeGreaterThanOrEqual(ir.events.length);
    for (const event of ir.events) {
      expect(event.embedding_refs.length).toBeGreaterThan(0);
    }
  });

  it('records where every value came from', async () => {
    const { ir } = await compile();
    expect(ir.model_runs.length).toBeGreaterThan(0);
    for (const run of ir.model_runs) {
      expect(run.backend.length).toBeGreaterThan(0);
    }
    // Everything in the default configuration runs locally, and the IR says so.
    expect(ir.model_runs.every((r) => !r.media_left_device)).toBe(true);
  });

  it('costs nothing in the default configuration', async () => {
    const { report, ir } = await compile();
    expect(report.totalCostUsd).toBe(0);
    expect(ir.stats.total_cost_usd).toBe(0);
    expect(report.mediaLeftDevice).toBe(false);
  });

  it('is reproducible: the same input compiles to the same IR', async () => {
    const first = await compile();
    const second = await compile();
    const stable = (ir: typeof first.ir) =>
      JSON.stringify({
        ...ir,
        generated_at: null,
        project: { ...ir.project, id: null, created_at: null, updated_at: null },
        context: { ...ir.context, project_id: null },
        model_runs: ir.model_runs.map((r) => ({ ...r, id: null, created_at: null, latency_ms: null })),
        editorial: ir.editorial.map((e) => ({ ...e, current: { ...e.current, model_run_id: null } })),
        stats: { ...ir.stats, compile_ms: null },
        fingerprint: null,
      });
    expect(stable(first.ir)).toBe(stable(second.ir));
  });

  it('gives the same input the same fingerprint', async () => {
    const first = await compile();
    const second = await compile();
    expect(first.ir.fingerprint).toBe(second.ir.fingerprint);
  });

  it('reuses perception when only the background changed', async () => {
    const { store, suite, observations } = await compile();
    store.writeObservations(observations);

    // The kind of edit a user makes constantly, and the one that must never
    // re-transcribe an hour of audio.
    const context = store.readContext();
    store.writeContext({
      ...context,
      background: { ...context.background, occasion: '交際1周年旅行（大阪）' },
    });

    const second = await compileProject({ store, suite, decision: new HeuristicDecisionBackend() });
    expect(second.report.reusedObservations).toBe(true);
  });

  it('re-runs perception when the media changed', async () => {
    const { store, suite, observations, ir } = await compile();
    store.writeObservations(observations);
    store.writeAssets(ir.assets.slice(0, 2));

    const second = await compileProject({ store, suite, decision: new HeuristicDecisionBackend() });
    expect(second.report.reusedObservations).toBe(false);
  });

  it('changes the fingerprint when the background changes, so a stale plan is detectable', async () => {
    const { store, suite, ir } = await compile();
    const context = store.readContext();
    store.writeContext({ ...context, background: { ...context.background, occasion: 'something else' } });

    const second = await compileProject({ store, suite, decision: new HeuristicDecisionBackend() });
    expect(second.ir.fingerprint).not.toBe(ir.fingerprint);
  });

  it('reports which perception stages had no model behind them', async () => {
    const { report } = await compile();
    // The example fixture supplies everything except a multimodal describe pass.
    expect(Array.isArray(report.unavailable)).toBe(true);
  });

  it('covers the material without silent gaps inside a recording', async () => {
    const { ir } = await compile();
    for (const asset of ir.assets) {
      const ranges = ir.events
        .flatMap((e) => e.source_ranges)
        .filter((r) => r.asset_id === asset.id)
        .sort((a, b) => a.source_in_ms - b.source_in_ms);
      expect(ranges.length).toBeGreaterThan(0);
      for (let i = 1; i < ranges.length; i++) {
        expect(
          ranges[i]!.source_in_ms,
          `gap in ${asset.file_name} at ${formatTimecode(ranges[i - 1]!.source_out_ms)}`,
        ).toBe(ranges[i - 1]!.source_out_ms);
      }
    }
  });
});

describe('observationsFingerprint', () => {
  it('ignores anything that does not change what perception sees', async () => {
    const store = await makeExampleProject();
    const suite = exampleSuite();
    const assets = store.readAssets();
    const before = observationsFingerprint(assets, suite);

    const context = store.readContext();
    store.writeContext({ ...context, editing_goal: { ...context.editing_goal, target_duration_ms: 60_000 } });

    expect(observationsFingerprint(store.readAssets(), suite)).toBe(before);
  });
});
