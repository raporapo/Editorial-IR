import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planEdit } from '@editorial-ir/agent';
import { compileProject } from '@editorial-ir/core';
import { HeuristicDecisionBackend, type DecisionBackendIdentity } from '@editorial-ir/decision';
import {
  HeuristicContextModel,
  type ContextModel,
  type ModelIdentity,
  type PerceptionSuite,
} from '@editorial-ir/perception';
import type {
  AnalyzeAudioParams,
  AnalyzeAudioResult,
  AnalyzeVideoResult,
  DescribeParams,
  DescribeResult,
  TranscribeParams,
  TranscribeResult,
} from '@editorial-ir/contracts';
import { SkillRegistry } from '@editorial-ir/skills';
import { exampleSuite, makeExampleProject } from './support/project.js';

/**
 * The still-and-silent mask, finished: what it must not hide, what it must not
 * claim, and how it is switched off.
 *
 * The worked example is made mostly quiet here — every file but one still and
 * silent throughout — because that is where each of these went wrong: a dead
 * model hid behind the quiet events, a saving was counted for an answer the
 * cache held for free, and `--budget` did not bind the pass that describes every
 * event.
 */

const ACTIVE = 'IMG_1003.MOV';

/** Every file but one still and silent from end to end, measured as such. */
function mostlyQuiet(suite: PerceptionSuite): PerceptionSuite {
  const audio = suite.audio!;
  const speech = suite.speech!;
  return {
    ...suite,
    speech: {
      identity: speech.identity,
      async transcribe(params: TranscribeParams): Promise<TranscribeResult> {
        const result = await speech.transcribe(params);
        return basename(params.audio_path) === ACTIVE ? result : { ...result, utterances: [] };
      },
    },
    audio: {
      identity: audio.identity,
      async analyzeAudio(params: AnalyzeAudioParams): Promise<AnalyzeAudioResult> {
        const result = await audio.analyzeAudio(params);
        if (basename(params.audio_path) === ACTIVE) return result;
        const hops = Math.ceil(900_000 / result.hop_ms);
        return {
          ...result,
          rms_db: Array.from({ length: hops }, () => -70),
          events: [
            ...result.events.filter((e) => e.event_type !== 'silence'),
            { start_ms: 0, end_ms: 900_000, event_type: 'silence', confidence: 0.9 },
          ],
        };
      },
    },
    video: {
      identity: { backend: 'test-motion', locality: 'local', mediaLeavesDevice: false },
      async analyzeVideo(params: { path: string }): Promise<AnalyzeVideoResult> {
        const still = basename(params.path) !== ACTIVE;
        return {
          hop_ms: 200,
          motion: [0.1],
          luma: [120],
          events: still
            ? [{ start_ms: 0, end_ms: 900_000, event_type: 'static', confidence: 0.9 }]
            : [],
        };
      },
    },
  };
}

/** A description model that is a model, as far as the pipeline can tell. */
class Describer implements ContextModel {
  readonly identity: ModelIdentity;
  calls = 0;
  private readonly inner = new HeuristicContextModel();

  constructor(
    private readonly behaviour: 'answers' | 'dies' = 'answers',
    locality: ModelIdentity['locality'] = 'local',
  ) {
    const { standIn: _standIn, ...identity } = this.inner.identity;
    this.identity = { ...identity, backend: 'test-describer', locality };
  }

  async describe(params: DescribeParams): Promise<DescribeResult> {
    this.calls++;
    if (this.behaviour === 'dies') throw new Error('connection refused');
    return { ...(await this.inner.describe(params)), input_tokens: 400, output_tokens: 60 };
  }
}

/** A judge that is not declared a stand-in. */
function judge(): HeuristicDecisionBackend {
  const backend = new HeuristicDecisionBackend() as HeuristicDecisionBackend & {
    identity: DecisionBackendIdentity;
  };
  const { standIn: _standIn, ...identity } = backend.identity;
  backend.identity = { ...identity, backend: 'test-judge' };
  return backend;
}

describe('the mask and a model that stops answering', () => {
  it('does not hide a dead description model behind the quiet events', async () => {
    // Measured before the fix: 53 of 73 events quiet, a model that refused all
    // three calls it was sent, and the IR stamped `standard` — the quiet events
    // counted as described diluted the failures below the line.
    const store = await makeExampleProject();
    const context = new Describer('dies');
    const suite = { ...mostlyQuiet(exampleSuite()), context };
    const { ir } = await compileProject({ store, suite, decision: judge() });
    expect(ir.quality.savings?.describe_calls_skipped ?? 0).toBeGreaterThan(0);
    // The tier is also lowered by the lexical search this fixture runs on; what
    // matters is that the failure is recorded against description at all.
    expect(ir.quality.tier).not.toBe('standard');
    expect(
      ir.quality.stand_ins.some(
        (s) => s.stage === 'description' && s.reason === 'failed_during_run',
      ),
    ).toBe(true);
  }, 60_000);

  it('records the rules as the author of a quiet event’s description', async () => {
    const store = await makeExampleProject();
    const context = new Describer();
    const suite = { ...mostlyQuiet(exampleSuite()), context };
    const { ir } = await compileProject({ store, suite, decision: judge() });
    const rulesRun = ir.model_runs.find(
      (run) =>
        run.stage === 'context' && run.backend === new HeuristicContextModel().identity.backend,
    );
    expect(rulesRun).toBeDefined();
    const byRules = ir.events.filter((e) => e.description.model_run_id === rulesRun!.id);
    expect(byRules.length).toBe(ir.quality.savings!.describe_calls_skipped);
  }, 60_000);
});

describe('what counts as saved', () => {
  it('takes the model’s own cached answer for a quiet event, and saves nothing', async () => {
    // Analysed once without the mask, every event has the model's description
    // in the cache. With the mask, those answers cost nothing: using them is
    // better than the rules' and no call was avoided.
    const store = await makeExampleProject();
    const context = new Describer();
    const suite = { ...mostlyQuiet(exampleSuite()), context };
    const unmasked = await compileProject({
      store,
      suite,
      decision: judge(),
      skipInactive: false,
    });
    const calls = context.calls;
    const masked = await compileProject({ store, suite, decision: judge() });
    expect(context.calls).toBe(calls);
    expect(masked.ir.quality.savings?.describe_calls_skipped ?? 0).toBe(0);
    expect(masked.ir.quality.savings?.judge_calls_skipped ?? 0).toBe(0);
    expect(masked.ir.events.map((e) => e.description.value)).toEqual(
      unmasked.ir.events.map((e) => e.description.value),
    );
  }, 60_000);

  it('prices the calls it did not make, and says it is an estimate', async () => {
    const store = await makeExampleProject();
    const suite = { ...mostlyQuiet(exampleSuite()), context: new Describer() };
    const { ir } = await compileProject({ store, suite, decision: judge() });
    expect(ir.quality.savings!.estimated_tokens_avoided).toBeGreaterThan(0);
  }, 60_000);
});

describe('switched off', () => {
  it('asks the models about everything, and says the mask was off', async () => {
    const store = await makeExampleProject();
    const context = new Describer();
    const suite = { ...mostlyQuiet(exampleSuite()), context };
    const { ir, report } = await compileProject({
      store,
      suite,
      decision: judge(),
      skipInactive: false,
    });
    expect(ir.quality.savings).toBeUndefined();
    expect(report.inactive).toBe('off');
    // No description came from the rules: every event went to the model (two
    // with identical prompts share one answer from the cache).
    expect(ir.model_runs.some((r) => r.stage === 'context' && r.backend === 'heuristic')).toBe(
      false,
    );
    const maskedStore = await makeExampleProject();
    const maskedContext = new Describer();
    await compileProject({
      store: maskedStore,
      suite: { ...mostlyQuiet(exampleSuite()), context: maskedContext },
      decision: judge(),
    });
    expect(context.calls).toBeGreaterThan(maskedContext.calls);
  }, 60_000);

  it('changes which models are asked, never the cut', async () => {
    // Offline, where the rules answer either way: the sweep found the cut of a
    // camera left running went from two clips to six when the saving was
    // switched off, because the still, silent spans were not measured at all
    // then, and the judgement and the skill rules read them.
    const cut = async (skipInactive: boolean) => {
      const store = await makeExampleProject();
      const { ir } = await compileProject({
        store,
        suite: mostlyQuiet(exampleSuite()),
        decision: new HeuristicDecisionBackend(),
        skipInactive,
      });
      const plan = planEdit({
        ir,
        skill: SkillRegistry.withBuiltIns().resolve('travel-vlog'),
        targetDurationMs: 60_000,
      });
      return {
        observed: ir.events.map((event) => event.observed.inactive_ratio ?? 0),
        judged: ir.editorial.map((entry) => entry.current.metrics),
        clips: plan.tracks.video.map((op) => [
          op.source_asset_id,
          op.source_in_ms,
          op.source_out_ms,
        ]),
      };
    };
    const on = await cut(true);
    const off = await cut(false);
    expect(on.observed.some((ratio) => ratio > 0)).toBe(true);
    expect(off).toEqual(on);
  }, 120_000);

  it('never reuses observations made with the other setting', async () => {
    // OCR thinned inside still spans is baked into stored observations.
    const store = await makeExampleProject();
    const suite = { ...mostlyQuiet(exampleSuite()), context: new Describer() };
    await compileProject({ store, suite, decision: judge() });
    const off = await compileProject({ store, suite, decision: judge(), skipInactive: false });
    expect(off.report.reusedObservations).toBe(false);
  }, 60_000);
});

describe('the budget', () => {
  it('binds the pass that describes every event, and says so', async () => {
    // It bound only the closer looks: a hosted model describing every event
    // spent past any limit.
    const store = await makeExampleProject();
    const context = new Describer('answers', 'remote_api');
    const suite = { ...exampleSuite(), context };
    const { ir, report } = await compileProject({
      store,
      suite,
      decision: judge(),
      budgetUsd: 0.01,
    });
    expect(context.calls).toBeLessThanOrEqual(3);
    expect(report.failures.some((f) => /cost limit/.test(f.reason))).toBe(true);
    expect(
      ir.quality.stand_ins.some(
        (s) => s.stage === 'description' && /--budget/.test(s.remedy ?? ''),
      ),
    ).toBe(true);
  }, 60_000);
});

describe('closer looks', () => {
  it('counts the closer looks the quiet events would have taken', async () => {
    // Leaving them out of the candidates was never counted, so a run with a
    // rules base and a hosted closer look reported no saving at all.
    const store = await makeExampleProject();
    const closer = new Describer('answers', 'remote_api');
    const suite = mostlyQuiet(exampleSuite());
    const { ir } = await compileProject({
      store,
      suite,
      decision: judge(),
      escalationContext: closer,
      escalation: { maxItems: 5 },
    });
    const savings = ir.quality.savings!;
    expect(savings.escalations_avoided + savings.escalations_redirected).toBeGreaterThan(0);
    expect(closer.calls).toBeLessThanOrEqual(5);
  }, 60_000);
});
