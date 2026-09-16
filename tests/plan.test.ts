import { describe, expect, it } from 'vitest';
import { compileProject } from '@editorial-ir/core';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { SkillRegistry } from '@editorial-ir/skills';
import {
  AgentToolkit,
  planEdit,
  reviewPlan,
  suggestRevisions,
  validatePlan,
} from '@editorial-ir/agent';
import {
  EditPlan,
  operationTimelineDuration,
  operationTimelineEnd,
  planDurationMs,
} from '@editorial-ir/contracts';
import { exampleSuite, makeExampleProject } from './support/project.js';

const registry = SkillRegistry.withBuiltIns();

async function compiled() {
  const store = await makeExampleProject();
  const result = await compileProject({
    store,
    suite: exampleSuite(),
    decision: new HeuristicDecisionBackend(),
  });
  return { store, ...result };
}

async function planned(skillName = 'travel-vlog', targetDurationMs = 180_000) {
  const { ir, observations, store } = await compiled();
  const plan = planEdit({ ir, skill: registry.resolve(skillName), targetDurationMs, observations });
  return { ir, plan, observations, store };
}

describe('planning a three-minute travel vlog', () => {
  it('produces a plan that validates against its own schema', async () => {
    const { plan } = await planned();
    expect(EditPlan.safeParse(plan).success).toBe(true);
  });

  it('passes the deterministic validator', async () => {
    const { ir, plan, store } = await planned();
    const report = validatePlan(plan, {
      ir,
      projectRoot: store.paths.root,
      checkMediaExists: true,
    });
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('lands inside the target duration', async () => {
    const { plan } = await planned();
    const duration = planDurationMs(plan);
    expect(Math.abs(duration - 180_000)).toBeLessThanOrEqual(plan.sequence.tolerance_ms);
  });

  it('cuts twenty-seven minutes down to three', async () => {
    const { plan } = await planned();
    expect(plan.stats.compression_ratio).toBeLessThan(0.2);
    expect(plan.stats.operation_count).toBeGreaterThan(8);
  });

  it('lays clips end to end with no overlaps', async () => {
    const { plan } = await planned();
    const operations = plan.tracks.video;
    for (let i = 1; i < operations.length; i++) {
      expect(operations[i]!.timeline_start_ms).toBe(operationTimelineEnd(operations[i - 1]!));
    }
  });

  it('never reads past the end of a source file', async () => {
    const { ir, plan } = await planned();
    for (const operation of plan.tracks.video) {
      const asset = ir.assets.find((a) => a.id === operation.source_asset_id)!;
      expect(operation.source_out_ms).toBeLessThanOrEqual(asset.duration_ms);
      expect(operation.source_in_ms).toBeLessThan(operation.source_out_ms);
    }
  });

  it('keeps clips inside the skill’s duration bounds', async () => {
    const { plan } = await planned();
    const skill = registry.resolve('travel-vlog');
    for (const operation of plan.tracks.video) {
      const duration = operationTimelineDuration(operation);
      expect(duration).toBeGreaterThan(0);
      // The ceiling can be relaxed by a rule, but never by more than a rule says.
      expect(duration).toBeLessThanOrEqual(skill.defaults.max_clip_duration_ms * 2);
    }
  });

  it('stays in the order the day happened', async () => {
    const { ir, plan } = await planned();
    const positionOf = new Map(ir.events.map((event, index) => [event.id, index]));
    const positions = plan.tracks.video.map((o) => positionOf.get(o.event_id!) ?? -1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('explains every decision it made', async () => {
    const { ir, plan } = await planned();
    // Every event is accounted for: chosen, trimmed, dropped or excluded.
    const explained = new Set(plan.rationale.map((r) => r.event_id));
    expect(explained.size).toBe(ir.events.length);
    for (const operation of plan.tracks.video) {
      const entry = plan.rationale.find((r) => r.operation_id === operation.operation_id);
      expect(entry, `${operation.operation_id} has no rationale`).toBeDefined();
      expect(entry!.reason.length).toBeGreaterThan(0);
    }
  });

  it('matches the sequence format to the material', async () => {
    const { plan } = await planned();
    expect(plan.sequence.width).toBe(3840);
    expect(plan.sequence.height).toBe(2160);
    // The exact NTSC rate survives rather than being rounded to 30.
    expect(plan.sequence.frame_rate_num).toBe(30000);
    expect(plan.sequence.frame_rate_den).toBe(1001);
  });

  it('is deterministic', async () => {
    const a = await planned();
    const b = await planned();
    // Project ids are random per scratch directory; everything else must match.
    const stable = (plan: typeof a.plan) =>
      JSON.stringify({ ...plan, id: null, created_at: null, project_id: null });
    expect(stable(a.plan)).toBe(stable(b.plan));
  });

  it('records which analysis it was built from', async () => {
    const { ir, plan } = await planned();
    expect(plan.ir_fingerprint).toBe(ir.fingerprint);
  });
});

describe('the same material under different skills', () => {
  it('cuts a short differently from a travel vlog', async () => {
    const travel = await planned('travel-vlog', 180_000);
    const short = await planned('shorts', 40_000);

    expect(planDurationMs(short.plan)).toBeLessThan(planDurationMs(travel.plan));
    // A short cuts faster: shorter clips, for a shorter piece.
    const meanOf = (plan: typeof travel.plan) =>
      plan.tracks.video.reduce((sum, o) => sum + operationTimelineDuration(o), 0) /
      plan.tracks.video.length;
    expect(meanOf(short.plan)).toBeLessThan(meanOf(travel.plan));
  });

  it('respects a skill’s cap on how many clips it will use', async () => {
    const { plan } = await planned('shorts', 40_000);
    expect(plan.tracks.video.length).toBeLessThanOrEqual(14);
  });

  it('reuses one analysis for both, without re-reading the video', async () => {
    const { ir, observations } = await compiled();
    const travel = planEdit({
      ir,
      skill: registry.resolve('travel-vlog'),
      targetDurationMs: 180_000,
      observations,
    });
    const short = planEdit({
      ir,
      skill: registry.resolve('shorts'),
      targetDurationMs: 40_000,
      observations,
    });
    // The whole point of compiling an IR: a second edit is a read, not a re-run.
    expect(travel.ir_fingerprint).toBe(short.ir_fingerprint);
    expect(travel.tracks.video.map((o) => o.event_id)).not.toEqual(
      short.tracks.video.map((o) => o.event_id),
    );
  });
});

describe('the user outranks the planner', () => {
  it('keeps an event marked essential, however it scores', async () => {
    const { store } = await compiled();
    const ir = store.readIr() ?? (await compiled()).ir;

    // Pick the least important event there is and demand it.
    const worst = [...ir.editorial].sort(
      (a, b) => a.current.metrics.story_importance - b.current.metrics.story_importance,
    )[0]!;

    store.writeAnnotations([
      {
        id: 'ann_0001',
        type: 'essential',
        target: { kind: 'event', event_id: worst.event_id },
        priority: 0,
        created_at: '2026-05-17T09:00:00.000Z',
      },
    ]);

    const recompiled = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
    });
    const plan = planEdit({
      ir: recompiled.ir,
      skill: registry.resolve('travel-vlog'),
      targetDurationMs: 180_000,
      observations: recompiled.observations,
    });

    expect(plan.tracks.video.some((o) => o.event_id === worst.event_id)).toBe(true);
    const report = validatePlan(plan, { ir: recompiled.ir });
    expect(report.ok).toBe(true);
  });

  it('never includes an event the user excluded', async () => {
    const { store } = await compiled();
    const first = (await compiled()).ir.events[5]!;

    store.writeAnnotations([
      {
        id: 'ann_0001',
        type: 'exclude',
        target: { kind: 'event', event_id: first.id },
        priority: 0,
        created_at: '2026-05-17T09:00:00.000Z',
      },
    ]);

    const recompiled = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
    });
    const plan = planEdit({
      ir: recompiled.ir,
      skill: registry.resolve('travel-vlog'),
      targetDurationMs: 180_000,
      observations: recompiled.observations,
    });

    expect(plan.tracks.video.some((o) => o.event_id === first.id)).toBe(false);
    expect(validatePlan(plan, { ir: recompiled.ir }).ok).toBe(true);
  });
});

describe('the toolkit', () => {
  it('answers the questions an agent would ask', async () => {
    const { ir } = await compiled();
    const toolkit = new AgentToolkit(ir);

    expect(toolkit.getProjectContext().background.occasion).toBe('交際1周年旅行');
    expect(toolkit.listChapters().length).toBeGreaterThan(0);
    expect(toolkit.listEvents({ limit: 5 })).toHaveLength(5);

    const first = toolkit.listEvents({ limit: 1 })[0]!;
    expect(toolkit.getEvent(first.id)!.id).toBe(first.id);
    expect(toolkit.inspectEvent(first.id, 'full')).toHaveProperty('metrics');
    expect(toolkit.compareEvents([first.id])).toHaveLength(1);
  });

  it('gives a summary before it gives a transcript', async () => {
    const { ir } = await compiled();
    const toolkit = new AgentToolkit(ir);
    const id = toolkit.listEvents({ limit: 1 })[0]!.id;

    // Progressive inspection: an agent planning from six hundred events cannot
    // be handed every transcript, and does not need to be.
    expect(toolkit.inspectEvent(id, 'summary')).not.toHaveProperty('speech');
    expect(toolkit.inspectEvent(id, 'detailed')).toHaveProperty('speech');
  });

  it('filters events the way a planner would', async () => {
    const { ir } = await compiled();
    const toolkit = new AgentToolkit(ir);
    for (const event of toolkit.listEvents({ hasSpeech: true })) {
      expect(ir.events.find((e) => e.id === event.id)!.observed.speech.length).toBeGreaterThan(0);
    }
  });
});

describe('reviewing a cut', () => {
  it('reads the plan back and reports what is wrong with it', async () => {
    const { ir, plan } = await planned();
    const observations = reviewPlan(plan, ir);
    for (const observation of observations) {
      expect(observation.message.length).toBeGreaterThan(0);
      expect(observation.confidence).toBeGreaterThanOrEqual(0);
    }
  });

  it('notices a clip too short to register', async () => {
    const { ir, plan } = await planned();
    const tiny = {
      ...plan,
      tracks: {
        ...plan.tracks,
        video: [
          { ...plan.tracks.video[0]!, source_out_ms: plan.tracks.video[0]!.source_in_ms + 200 },
        ],
      },
    };
    const observations = reviewPlan(tiny, ir);
    expect(observations.some((o) => o.observation_type === 'too_short')).toBe(true);
  });

  it('suggests something concrete for what it found', async () => {
    const { ir, plan } = await planned();
    const tiny = {
      ...plan,
      tracks: {
        ...plan.tracks,
        video: [
          { ...plan.tracks.video[0]!, source_out_ms: plan.tracks.video[0]!.source_in_ms + 200 },
        ],
      },
    };
    const suggestions = suggestRevisions(reviewPlan(tiny, ir), tiny, ir);
    expect(suggestions.some((s) => s.action === 'extend_operation')).toBe(true);
  });
});
