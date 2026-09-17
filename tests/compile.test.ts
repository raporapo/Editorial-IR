import { describe, expect, it } from 'vitest';
import { compileProject, observationsFingerprint } from '@editorial-ir/core';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { EditorialIR, formatTimecode } from '@editorial-ir/contracts';
import type { ContextModel } from '@editorial-ir/perception';
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
    expect(ir.assets.map((a) => a.file_name)).toEqual([
      'IMG_1001.MOV',
      'IMG_1002.MOV',
      'IMG_1003.MOV',
    ]);
    // Ordered by capture time, laid end to end, never overlapping.
    expect(ir.placements.map((p) => p.ordered_by)).toEqual([
      'creation_time',
      'creation_time',
      'creation_time',
    ]);
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
    const arrival = ir.events.find((e) =>
      e.observed.speech.some((s) => s.text.includes('やっと着いた')),
    );
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
        model_runs: ir.model_runs.map((r) => ({
          ...r,
          id: null,
          created_at: null,
          latency_ms: null,
        })),
        editorial: ir.editorial.map((e) => ({
          ...e,
          current: { ...e.current, model_run_id: null },
        })),
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
    store.writeContext({
      ...context,
      background: { ...context.background, occasion: 'something else' },
    });

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

describe('what the user named', () => {
  it('appears on the events that mention it', async () => {
    // context.yaml is documented as the authority on who is in the footage and
    // where it was shot, and it used to be neither: every event in this example
    // had no people and no places, while the transcript said 今日はUSJだね.
    const { ir } = await compile();

    const withPlace = ir.events.filter((e) => e.entities.value.places.length > 0);
    const withPerson = ir.events.filter((e) => e.entities.value.people.length > 0);
    expect(withPlace.length).toBeGreaterThan(0);
    expect(withPerson.length).toBeGreaterThan(0);

    // Always the id from context.yaml, never the form that matched: one name for
    // one thing, or a skill rule works on some events and not others.
    const declared = new Set(ir.context.background.places.map((place) => place.id));
    for (const event of withPlace) {
      expect(event.entities.value.places.some((place) => declared.has(place))).toBe(true);
    }
  }, 60_000);

  it('is replaced outright by what the user says, never merged with it', async () => {
    // The linker infers "these people are in this event" from what is said and
    // shown. An annotation is the user stating it. Merging the two would be the
    // one thing this project's design forbids everywhere — model inference
    // overwriting, or diluting, what the user told it.
    const store = await makeExampleProject();
    store.writeAnnotations([
      {
        id: 'ann_1',
        type: 'person',
        people: ['me'],
        target: { kind: 'event', event_id: 'evt_0022' },
        priority: 0,
        created_at: '2026-05-17T09:00:00.000Z',
      },
    ] as never);

    const { ir } = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
    });

    const event = ir.events.find((e) => e.id === 'evt_0022')!;
    // Without the annotation the two_people alias links both of them here.
    expect(event.entities.value.people).toEqual(['me']);
    expect(event.entities.provenance).toBe('user_provided');
  }, 60_000);

  it('reaches the search index, so a name finds its footage', async () => {
    // The labels on this footage are in English and the place is named in
    // Japanese, which lexical search can never bridge on its own. The user's own
    // vocabulary is what bridges it.
    const { ir, embeddings } = await compile();
    const texts = ir.events
      .filter((e) => e.entities.value.places.includes('展望台'))
      .map((e) => e.id);
    expect(texts.length).toBeGreaterThan(0);
    expect(embeddings.records.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('the corrections a user can make', () => {
  async function compiledWith(annotations: unknown[]) {
    const store = await makeExampleProject();
    store.writeAnnotations(annotations as never);
    return compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
    });
  }

  const on = (eventId: string) => ({ kind: 'event' as const, event_id: eventId });
  const base = { priority: 0, created_at: '2026-05-17T09:00:00.000Z' };

  it('takes the user’s word on what a moment is for', async () => {
    // "This is the ending" is one of the four corrections the design exists to
    // accept, and it used to be stored and then dropped on the floor: the role
    // lives on the assessment, and the override was being written somewhere only
    // the event builder reads.
    const { ir } = await compiledWith([
      { id: 'ann_1', ...base, type: 'narrative_role', role: 'ending', target: on('evt_0055') },
    ]);

    const entry = ir.editorial.find((e) => e.event_id === 'evt_0055')!;
    expect(entry.current.narrative_role.selected).toBe('ending');
    // The model's answer is kept beside it rather than deleted.
    expect(entry.history).toHaveLength(1);
    expect(entry.history[0]!.narrative_role.selected).not.toBe('ending');
  });

  it('takes the user’s word on how a moment felt', async () => {
    const { ir } = await compiledWith([
      {
        id: 'ann_1',
        ...base,
        type: 'mood',
        mood: { excitement: 0.9, sadness: 0 },
        target: on('evt_0031'),
      },
    ]);

    const event = ir.events.find((e) => e.id === 'evt_0031')!;
    expect(event.affect.value).toEqual({ excitement: 0.9, sadness: 0 });
    expect(event.affect.provenance).toBe('user_provided');
  });

  it('takes the user’s word on who is in it', async () => {
    const { ir } = await compiledWith([
      { id: 'ann_1', ...base, type: 'person', people: ['me', 'partner'], target: on('evt_0031') },
    ]);

    const event = ir.events.find((e) => e.id === 'evt_0031')!;
    expect(event.entities.value.people).toEqual(['me', 'partner']);
    expect(event.entities.provenance).toBe('user_provided');
  });

  it('takes the user’s word on whether two moments run together', async () => {
    const { ir } = await compiledWith([
      {
        id: 'ann_1',
        ...base,
        type: 'continuity',
        strength: 0.95,
        target: { kind: 'event_pair', event_a: 'evt_0031', event_b: 'evt_0032' },
      },
    ]);

    const edge = ir.relations.find(
      (r) =>
        r.relation_type === 'continuation' &&
        r.source_event_id === 'evt_0031' &&
        r.target_event_id === 'evt_0032',
    )!;
    expect(edge.strength).toBe(0.95);
    expect(edge.provenance).toBe('user_provided');
  });
});

describe('observationsFingerprint', () => {
  it('ignores anything that does not change what perception sees', async () => {
    const store = await makeExampleProject();
    const suite = exampleSuite();
    const assets = store.readAssets();
    const before = observationsFingerprint(assets, suite);

    const context = store.readContext();
    store.writeContext({
      ...context,
      editing_goal: { ...context.editing_goal, target_duration_ms: 60_000 },
    });

    expect(observationsFingerprint(store.readAssets(), suite)).toBe(before);
  });
});

/**
 * What a model that refuses costs.
 *
 * "A missing model costs that stage, not the run" is one of the absolutes, and
 * it was written for a model that is absent. A model that is present and throws
 * — a restarted local server, a 502 from a proxy, a dropped connection — took
 * the whole compile with it, so every minute of transcription and every cheap
 * judgement already done was lost and the user got no timeline and no plan.
 */
describe('a model that refuses', () => {
  class Refuses implements ContextModel {
    readonly identity = {
      backend: 'refusing',
      locality: 'remote_api' as const,
      mediaLeavesDevice: false,
    };
    calls = 0;
    describe(): Promise<never> {
      this.calls++;
      return Promise.reject(new Error('503 Service Unavailable'));
    }
  }

  class RefusingJudge extends HeuristicDecisionBackend {
    override readonly identity = {
      ...new HeuristicDecisionBackend().identity,
      backend: 'refusing',
      baseConfidence: 0.9,
    };
    calls = 0;
    override score(..._args: Parameters<HeuristicDecisionBackend['score']>) {
      this.calls++;
      return Promise.reject(new Error('500 Internal Server Error'));
    }
  }

  it('still produces an analysis when the closer look is unreachable', async () => {
    const store = await makeExampleProject();
    const closerLook = new Refuses();
    const result = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
      escalationContext: closerLook,
      escalation: { maxItems: 5, minValue: 0 },
    });

    expect(result.ir.events.length).toBeGreaterThan(50);
    // It gave up rather than asking a dead endpoint once per event.
    expect(closerLook.calls).toBeLessThanOrEqual(3);
    const said = result.report.failures.filter((f) => f.stage === 'inspect');
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]!.reason).toContain('503');
  }, 60_000);

  it('still produces an analysis when the second opinion is unreachable', async () => {
    const store = await makeExampleProject();
    const judge = new RefusingJudge();
    const result = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
      escalationDecision: judge,
      escalation: { maxItems: 5, minValue: 0 },
    });

    expect(result.ir.editorial.length).toBe(result.ir.events.length);
    expect(judge.calls).toBeGreaterThan(0);
    const said = result.report.failures.filter((f) => f.stage === 'reassess');
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]!.reason).toContain('the rule-based judgement stands');
  }, 60_000);
});

describe('an analysis with a hole in it', () => {
  it('is not reused as though it were complete', async () => {
    // The fingerprint is over the media and the models, so it matched whether or
    // not a stage had managed to run: a set stored with one asset's speech
    // missing came back on every later run under "nothing that affects it had
    // changed", and the missing utterances never returned.
    const store = await makeExampleProject();
    const first = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
    });

    store.writeObservations({
      ...first.observations,
      failures: [{ stage: 'speech', asset_id: 'asset_002', reason: 'the worker went away' }],
    });

    const second = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
    });
    expect(second.report.reusedObservations).toBe(false);
  }, 60_000);

  it('is reused when it has none', async () => {
    const store = await makeExampleProject();
    const first = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
    });
    store.writeObservations(first.observations);

    const second = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
    });
    expect(second.report.reusedObservations).toBe(true);
  }, 60_000);
});
