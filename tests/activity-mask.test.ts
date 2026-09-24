import { describe, expect, it } from 'vitest';
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
  EditorialIR,
} from '@editorial-ir/contracts';
import { basename } from 'node:path';
import { exampleSuite, makeExampleProject, readExampleFixture } from './support/project.js';

/**
 * The still-and-silent mask: fewer model calls, and not one time value moved.
 *
 * The user's condition for this feature was that it must not affect any number
 * of seconds. So the test that matters compiles the same project twice — once
 * with the picture envelope, once without — and demands that every event
 * boundary, every source range and every chapter is identical, while the
 * masked run asks the models about fewer events.
 */

/** A stretch of the first file with no words in the fixture's transcript. */
const QUIET = { file: 'IMG_1001.MOV', start: 120_000, end: 170_000 };

/** A context model that is a model, as far as the pipeline can tell, and counts. */
class CountingModel implements ContextModel {
  readonly identity: ModelIdentity;
  calls = 0;
  private readonly inner = new HeuristicContextModel();

  constructor() {
    const { standIn: _standIn, ...identity } = this.inner.identity;
    this.identity = { ...identity, backend: 'counting-context' };
  }

  async describe(params: DescribeParams): Promise<DescribeResult> {
    this.calls++;
    return this.inner.describe(params);
  }
}

/** A judge that is not declared a stand-in, and counts. */
function countingJudge(): HeuristicDecisionBackend & { events: Set<string> } {
  const judge = new HeuristicDecisionBackend() as HeuristicDecisionBackend & {
    events: Set<string>;
    identity: DecisionBackendIdentity;
  };
  const { standIn: _standIn, ...identity } = judge.identity;
  judge.identity = { ...identity, backend: 'counting-judge' };
  judge.events = new Set<string>();
  const score = judge.score.bind(judge);
  judge.score = async (...args) => {
    judge.events.add(args[0].event_id);
    return score(...args);
  };
  return judge;
}

/** The fixture's audio, with the quiet stretch made silent. */
function withSilence(suite: PerceptionSuite): PerceptionSuite {
  const audio = suite.audio!;
  return {
    ...suite,
    audio: {
      identity: audio.identity,
      async analyzeAudio(params: AnalyzeAudioParams): Promise<AnalyzeAudioResult> {
        const result = await audio.analyzeAudio(params);
        if (basename(params.audio_path) !== QUIET.file) return result;
        return {
          ...result,
          events: [
            ...result.events.filter((e) => e.end_ms <= QUIET.start || e.start_ms >= QUIET.end),
            { start_ms: QUIET.start, end_ms: QUIET.end, event_type: 'silence', confidence: 0.8 },
          ],
        };
      },
    },
  };
}

/** The picture envelope: still for the quiet stretch, moving everywhere else. */
function withPicture(suite: PerceptionSuite): PerceptionSuite {
  return {
    ...suite,
    video: {
      identity: { backend: 'test-motion', locality: 'local', mediaLeavesDevice: false },
      async analyzeVideo(params: { path: string }): Promise<AnalyzeVideoResult> {
        const still = basename(params.path) === QUIET.file;
        return {
          hop_ms: 200,
          motion: [2],
          luma: [120],
          events: still
            ? [{ start_ms: QUIET.start, end_ms: QUIET.end, event_type: 'static', confidence: 0.9 }]
            : [],
        };
      },
    },
  };
}

async function compileWith(masked: boolean) {
  const store = await makeExampleProject();
  const context = new CountingModel();
  const decision = countingJudge();
  let suite: PerceptionSuite = { ...withSilence(exampleSuite()), context };
  if (masked) suite = withPicture(suite);
  const result = await compileProject({ store, suite, decision });
  return { result, context, decision };
}

function timing(ir: EditorialIR) {
  return {
    events: ir.events.map((e) => [e.start_ms, e.end_ms, e.source_ranges]),
    chapters: ir.chapters.map((c) => [c.start_ms, c.end_ms, c.event_ids]),
    placements: ir.placements,
  };
}

describe('the still-and-silent mask', () => {
  it('moves no time value anywhere', async () => {
    const plain = await compileWith(false);
    const masked = await compileWith(true);
    expect(timing(masked.result.ir)).toEqual(timing(plain.result.ir));
  }, 60_000);

  it('asks the models about fewer events, and says how many', async () => {
    const plain = await compileWith(false);
    const masked = await compileWith(true);
    const savings = masked.result.ir.quality.savings;

    expect(savings).toBeDefined();
    expect(savings!.inactive_ms).toBe(QUIET.end - QUIET.start - 1_000);
    expect(savings!.describe_calls_skipped).toBeGreaterThan(0);
    expect(savings!.judge_calls_skipped).toBe(savings!.describe_calls_skipped);
    expect(masked.context.calls).toBe(plain.context.calls - savings!.describe_calls_skipped);
    expect(masked.decision.events.size).toBe(
      plain.decision.events.size - savings!.judge_calls_skipped,
    );
    expect(masked.result.report.savings).toEqual(savings);
  }, 60_000);

  it('is not mistaken for a failed or missing model', async () => {
    // A skip is a model that was there and was not asked. Counted as a
    // fallback, a project with long still stretches would read as degraded.
    const plain = await compileWith(false);
    const masked = await compileWith(true);
    expect(masked.result.ir.quality.tier).toBe(plain.result.ir.quality.tier);
    expect(masked.result.ir.quality.stand_ins).toEqual(plain.result.ir.quality.stand_ins);
  }, 60_000);

  it('records the rules as the judge of the quiet events, not the model', async () => {
    const masked = await compileWith(true);
    const ir = masked.result.ir;
    const rulesRun = ir.model_runs.find((r) => r.stage === 'decision' && r.backend === 'heuristic');
    expect(rulesRun).toBeDefined();
    const quiet = ir.events.filter((e) => (e.observed.inactive_ratio ?? 0) > 0.5);
    expect(quiet.length).toBeGreaterThan(0);
    const judgedByRules = ir.editorial.filter((e) => e.current.model_run_id === rulesRun!.id);
    expect(judgedByRules.length).toBe(ir.quality.savings!.judge_calls_skipped);
  }, 60_000);

  it('changes nothing at all for footage with no still, silent stretch', async () => {
    // The fixture as committed has no silence long enough, so the mask finds
    // nothing, and the IR must not so much as grow an empty savings record.
    const store = await makeExampleProject();
    const suite = withPicture(exampleSuite());
    const result = await compileProject({ store, suite, decision: new HeuristicDecisionBackend() });
    expect(result.ir.quality.savings).toBeUndefined();
    void readExampleFixture;
  }, 60_000);
});
