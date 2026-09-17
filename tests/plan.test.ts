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
  type EditorialIR,
  type NarrativeRole,
  type SkillManifest,
} from '@editorial-ir/contracts';
import { exampleSuite, makeExampleProject } from './support/project.js';
import { makeIR } from './support/ir.js';

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
        anchor: [],
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

  it('never includes a recording the user banned in the project constraints', async () => {
    // The validator refuses to export a plan containing one, and the planner did
    // not know about them at all — so excluding a recording produced a cut full
    // of it that then would not export, with nothing to say what to remove.
    const { store, ir } = await compiled();
    const banned = ir.assets[1]!.id;
    const context = store.readContext();
    store.writeContext({
      ...context,
      constraints: { ...context.constraints, excluded_assets: [banned] },
    });

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

    expect(plan.tracks.video.some((o) => o.source_asset_id === banned)).toBe(false);
    expect(plan.tracks.video.length).toBeGreaterThan(0);
    // And it validates, which is the point: before, it could not.
    expect(validatePlan(plan, { ir: recompiled.ir }).ok).toBe(true);
    expect(plan.rationale.some((r) => r.reason.includes(banned))).toBe(true);
  }, 60_000);

  it('never includes an event the user excluded', async () => {
    const { store } = await compiled();
    const first = (await compiled()).ir.events[5]!;

    store.writeAnnotations([
      {
        id: 'ann_0001',
        type: 'exclude',
        target: { kind: 'event', event_id: first.id },
        anchor: [],
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

describe('what the cut does with the time it has', () => {
  it('lets the people in it finish their sentences', async () => {
    const { ir, plan } = await planned();

    // A plan is valid long before it is good, and the difference is mostly
    // here: a clip trimmed under the length of the thing someone is saying cuts
    // them off mid-word, and no schema notices. This measures how much of the
    // speech inside the clips the planner chose actually survives its trim.
    let selectedMs = 0;
    let survivingMs = 0;
    for (const operation of plan.tracks.video) {
      const event = ir.events.find((e) => e.id === operation.event_id);
      for (const speech of event?.observed.speech ?? []) {
        selectedMs += speech.end_ms - speech.start_ms;
        survivingMs += Math.max(
          0,
          Math.min(operation.source_out_ms, speech.end_ms) -
            Math.max(operation.source_in_ms, speech.start_ms),
        );
      }
    }

    expect(selectedMs).toBeGreaterThan(0);
    // Allocating each clip the duration selection budgeted for it, rather than
    // resetting everything to its floor, took this from 82.8% to 89.5%. The
    // floor here is below that on purpose: it is a guard against the regression,
    // not a restatement of today's number.
    expect(survivingMs / selectedMs).toBeGreaterThan(0.87);
  }, 60_000);

  it('does not run the same kind of shot past the limit the skill sets', async () => {
    const { plan } = await planned();
    const cap = registry.resolve('travel-vlog').constraints.max_consecutive_same_role;

    // Declared in the schema with its purpose written beside it — "to stop six
    // establishing shots in a row" — and enforced nowhere, so the flagship cut
    // had seven consecutive transitions: twenty-one seconds of platforms and
    // train windows in a three-minute piece.
    let longest = 0;
    let run = 0;
    let previous: string | undefined;
    for (const operation of plan.tracks.video) {
      run = operation.role === previous ? run + 1 : 1;
      previous = operation.role;
      longest = Math.max(longest, run);
    }

    expect(longest).toBeLessThanOrEqual(cap);
  }, 60_000);

  it('never lets that cap cost the cut its target length', async () => {
    // Material where one role dominates is ordinary — forty shots from one
    // afternoon are frequently all `context` — and it is the case that turns
    // this rule into a wrecking ball. Enforced blindly the cap sees a single run
    // of forty, keeps three and drops thirty-seven: a three-clip film whatever
    // length was asked for, and every drop pure loss, because with nothing to
    // interleave no arrangement satisfies the cap anyway.
    const uniform = makeIR({
      events: Array.from({ length: 40 }, (_, i) => ({
        description: `別々の出来事 ${i}`,
        event_type: 'moment',
        speech: [`セリフ${i}`],
        visual_labels: [`label_${i}`],
      })),
    });
    const skill = registry.resolve('travel-vlog');

    for (const targetMs of [60_000, 180_000]) {
      const plan = planEdit({ ir: uniform, skill, targetDurationMs: targetMs });
      const length = plan.tracks.video.reduce(
        (sum, operation) => sum + (operation.source_out_ms - operation.source_in_ms),
        0,
      );
      expect(plan.tracks.video.length).toBeGreaterThan(5);
      expect(length).toBeGreaterThan(targetMs * 0.9);
    }
  }, 60_000);

  it('takes everything there is when the target is longer than the material', async () => {
    const uniform = makeIR({
      events: Array.from({ length: 40 }, (_, i) => ({
        description: `別々の出来事 ${i}`,
        event_type: 'moment',
        speech: [`セリフ${i}`],
        visual_labels: [`label_${i}`],
      })),
    });
    const plan = planEdit({
      ir: uniform,
      skill: registry.resolve('travel-vlog'),
      targetDurationMs: 3_600_000,
    });
    expect(plan.tracks.video).toHaveLength(40);
  }, 60_000);

  it('keeps the best of a run it had to shorten, not the first', async () => {
    const { ir, observations } = await compiled();
    const skill = registry.resolve('travel-vlog');
    const plan = planEdit({ ir, skill, targetDurationMs: 180_000, observations });

    const cut = plan.rationale.filter((entry) => entry.reason.includes('in a row'));
    expect(cut.length).toBeGreaterThan(0);

    // If the viewer is going to see three shots of travelling, they should be
    // the three worth seeing.
    const keptScores = plan.tracks.video
      .map((operation) => plan.rationale.find((r) => r.event_id === operation.event_id)?.score)
      .filter((score): score is number => score !== undefined);
    const droppedScores = cut.map((entry) => entry.score ?? 0);
    if (keptScores.length > 0 && droppedScores.length > 0) {
      expect(Math.max(...keptScores)).toBeGreaterThan(Math.min(...droppedScores));
    }
  }, 60_000);

  it('varies clip length instead of cutting everything the same', async () => {
    const { plan } = await planned();
    const durations = plan.tracks.video.map((o) => o.source_out_ms - o.source_in_ms);
    const mean = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    const spread = Math.sqrt(
      durations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / durations.length,
    );

    // A cut where every clip is the same length reads as a slideshow. The
    // moments worth watching should visibly get more time than the ones that
    // are there to carry the viewer between them.
    expect(spread / mean).toBeGreaterThan(0.5);
    expect(Math.max(...durations)).toBeGreaterThan(Math.min(...durations) * 3);
  }, 60_000);
});

describe('the caller outranks the skill', () => {
  it('keeps an event it asked for by name, even one the skill turned down', async () => {
    const { ir, observations } = await compiled();
    const skill = registry.resolve('travel-vlog');

    // An event the skill drops outright is the hard case: it never reaches
    // selection, so a "require" that only reweights candidates does nothing at
    // all and reports success.
    const baseline = planEdit({ ir, skill, targetDurationMs: 180_000, observations });
    const droppedBySkill = baseline.rationale.find((entry) => entry.decision === 'dropped');
    expect(droppedBySkill).toBeDefined();
    const wanted = droppedBySkill!.event_id;
    expect(baseline.tracks.video.some((o) => o.event_id === wanted)).toBe(false);

    const plan = planEdit({
      ir,
      skill,
      targetDurationMs: 180_000,
      observations,
      overrides: { require: [wanted] },
    });

    expect(plan.tracks.video.some((o) => o.event_id === wanted)).toBe(true);
    // And the plan no longer claims to have dropped something it kept.
    expect(
      plan.rationale.some((entry) => entry.event_id === wanted && entry.decision === 'dropped'),
    ).toBe(false);
    expect(validatePlan(plan, { ir }).ok).toBe(true);
  });

  it('keeps the recovered event in its place in the story', async () => {
    const { ir, observations } = await compiled();
    const skill = registry.resolve('travel-vlog');
    const baseline = planEdit({ ir, skill, targetDurationMs: 180_000, observations });
    const wanted = baseline.rationale.find((entry) => entry.decision === 'dropped')!.event_id;

    const plan = planEdit({
      ir,
      skill,
      targetDurationMs: 180_000,
      observations,
      overrides: { require: [wanted] },
    });

    // Chronological order is the planner's invariant, not something an override
    // gets to break by appending to the end.
    const order = plan.tracks.video.map((operation) => operation.event_id);
    const byTime = [...plan.tracks.video].sort((a, b) => a.timeline_start_ms - b.timeline_start_ms);
    expect(order).toEqual(byTime.map((operation) => operation.event_id));
  });

  it('leaves out an event it asked to drop', async () => {
    const { ir, observations } = await compiled();
    const skill = registry.resolve('travel-vlog');
    const baseline = planEdit({ ir, skill, targetDurationMs: 180_000, observations });
    const kept = baseline.tracks.video[2]!.event_id!;

    const plan = planEdit({
      ir,
      skill,
      targetDurationMs: 180_000,
      observations,
      overrides: { drop: [kept], reasons: { [kept]: 'the user has seen this already' } },
    });

    expect(plan.tracks.video.some((o) => o.event_id === kept)).toBe(false);
    expect(
      plan.rationale.some(
        (entry) => entry.event_id === kept && entry.reason === 'the user has seen this already',
      ),
    ).toBe(true);
  });

  it('refuses an event id that does not exist rather than ignoring it', async () => {
    const { ir, observations } = await compiled();
    const skill = registry.resolve('travel-vlog');

    // Silently planning the default cut after being asked for a different one
    // is the failure that looks like success.
    expect(() =>
      planEdit({
        ir,
        skill,
        targetDurationMs: 180_000,
        observations,
        overrides: { require: ['evt_9999'] },
      }),
    ).toThrow(/evt_9999/);
  });

  it('still cannot drop what the user called essential', async () => {
    const { store, ir } = await compiled();
    const essential = ir.events[4]!;

    store.writeAnnotations([
      {
        id: 'ann_0001',
        type: 'essential',
        target: { kind: 'event', event_id: essential.id },
        anchor: [],
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
      overrides: { drop: [essential.id] },
    });

    expect(plan.tracks.video.some((o) => o.event_id === essential.id)).toBe(true);
  });
});

describe('a floor the skill states but its scoring cannot guarantee', () => {
  it('says so when a cut falls below the speech share its style asks for', async () => {
    const { ir, observations } = await compiled();
    // A travel-vlog cut of travel footage is mostly pictures; talking-head asks
    // for seven tenths of its runtime to carry speech. Judging one by the
    // other's floor is the situation the check exists for — a talking-head cut
    // where nobody is talking is not that thing at all.
    const plan = planEdit({
      ir,
      skill: registry.resolve('travel-vlog'),
      targetDurationMs: 180_000,
      observations,
    });

    const report = validatePlan(plan, { ir, skill: registry.resolve('talking-head') });
    const issue = report.issues.find((i) => i.code === 'below_minimum_speech_share');
    expect(issue).toBeDefined();
    // A warning, not an error: on quiet material the floor may be unreachable,
    // and refusing to produce a cut is worse than producing one and saying so.
    expect(issue!.severity).toBe('warning');
    expect(report.ok).toBe(true);
  }, 60_000);

  it('says nothing when the cut meets it', async () => {
    const { ir, observations } = await compiled();
    const skill = registry.resolve('talking-head');
    const plan = planEdit({ ir, skill, targetDurationMs: 180_000, observations });

    const report = validatePlan(plan, { ir, skill });
    expect(report.issues.some((i) => i.code === 'below_minimum_speech_share')).toBe(false);
  }, 60_000);

  it('says nothing when the skill did not ask for one', async () => {
    const { ir, observations } = await compiled();
    const skill = registry.resolve('travel-vlog');
    const plan = planEdit({ ir, skill, targetDurationMs: 180_000, observations });

    expect(skill.constraints.min_speech_share).toBeUndefined();
    const report = validatePlan(plan, { ir, skill });
    expect(report.issues.some((i) => i.code === 'below_minimum_speech_share')).toBe(false);
  }, 60_000);
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

describe('descending below the event', () => {
  // The toolkit reads a document and nothing else; shots and frames live on
  // disk, so they arrive through an injected source. That seam is what lets an
  // agent be tested without a project directory at all.
  function stubInspection(frameCount: number) {
    const calls: string[] = [];
    return {
      calls,
      source: {
        shots: () => [
          {
            shot: { id: 'sht_1', asset_id: 'asset_001', start_ms: 0, end_ms: 4000 },
            offset_ms: 0,
            duration_ms: 4000,
            whole: true,
          },
        ],
        frames: () =>
          Array.from({ length: frameCount }, (_, i) => ({
            path: `/w/${i}.jpg`,
            asset_id: 'asset_001',
            source_ms: i * 1000,
          })),
        contactSheet: async () => {
          calls.push('sheet');
          return '/w/sheet.jpg';
        },
      },
    };
  }

  it('reports the shots an event is made of', async () => {
    const { ir } = await compiled();
    const toolkit = new AgentToolkit(ir, undefined, stubInspection(4).source);
    expect(toolkit.listShots(ir.events[0]!.id)).toHaveLength(1);
  });

  it('says nothing rather than failing when there is no way to look', async () => {
    // A project ingested without frame sampling is normal, not broken, and an
    // agent asking to look at one should get an answer it can act on.
    const { ir } = await compiled();
    const toolkit = new AgentToolkit(ir);
    expect(toolkit.listShots(ir.events[0]!.id)).toEqual([]);
    expect(toolkit.listFrames(ir.events[0]!.id)).toEqual([]);
    await expect(toolkit.getContactSheet(ir.events[0]!.id)).rejects.toThrow(
      /without a way to look/,
    );
  });

  it('refuses an event that does not exist rather than looking at nothing', async () => {
    const { ir } = await compiled();
    const toolkit = new AgentToolkit(ir, undefined, stubInspection(4).source);
    await expect(toolkit.getContactSheet('evt_9999')).rejects.toThrow(/evt_9999/);
  });

  it('builds the contact sheet only when asked', async () => {
    const { ir } = await compiled();
    const stub = stubInspection(4);
    const toolkit = new AgentToolkit(ir, undefined, stub.source);

    // Listing frames is a directory read; the sheet is an ffmpeg run. The step
    // that costs something should not happen as a side effect of the one above.
    toolkit.listFrames(ir.events[0]!.id);
    expect(stub.calls).toEqual([]);
    await toolkit.getContactSheet(ir.events[0]!.id);
    expect(stub.calls).toEqual(['sheet']);
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

/**
 * The three parts of a skill that say what a moment is worth beside the others.
 *
 * `duplicate_penalty`, `continuity_bonus` and an arc segment's `require_roles`
 * are all declared in the schema, documented in the contract and, until now,
 * read by nothing. Each is checked against the same skill with the field turned
 * off, so the test says what the field does rather than what the planner
 * happens to do.
 */
describe('what a moment is worth beside the others', () => {
  const base = registry.resolve('base-editor');

  /** Room for two clips and no more, so the test is about which two. */
  function styled(over: Partial<SkillManifest>): SkillManifest {
    return {
      ...base,
      // The hard suppression rule is a different mechanism and would otherwise
      // answer the duplicate question before the penalty could.
      rules: base.rules.filter((rule) => rule.id !== 'suppress-duplicates'),
      arc: { ordering: 'chronological', segments: [] },
      constraints: { ...base.constraints, max_operations: 2 },
      ...over,
    };
  }

  function chosen(ir: EditorialIR, skill: SkillManifest): (string | undefined)[] {
    return planEdit({ ir, skill, targetDurationMs: 60_000 }).tracks.video.map((op) => op.event_id);
  }

  /** Two takes of the same thing, one better, and an unrelated moment. */
  function twoTakesAndAnother(): EditorialIR {
    return makeIR({
      events: [
        { id: 'evt_take_a', description: '一回目', metrics: { story_importance: 0.9 } },
        { id: 'evt_take_b', description: '二回目', metrics: { story_importance: 0.88 } },
        { id: 'evt_other', description: '別の場面', metrics: { story_importance: 0.86 } },
      ],
      relations: [['evt_take_a', 'duplicate_of', 'evt_take_b', 1]],
    });
  }

  it('leaves out the second take of something already in the cut', () => {
    const skill = styled({
      scoring: { ...base.scoring, duplicate_penalty: 0.5, continuity_bonus: 0 },
    });
    expect(chosen(twoTakesAndAnother(), skill)).toEqual(['evt_take_a', 'evt_other']);
  });

  it('takes both takes when the skill sets no penalty', () => {
    const skill = styled({
      scoring: { ...base.scoring, duplicate_penalty: 0, continuity_bonus: 0 },
    });
    expect(chosen(twoTakesAndAnother(), skill)).toEqual(['evt_take_a', 'evt_take_b']);
  });

  it('prefers the moment that continues one already in the cut', () => {
    // evt_other is the better moment on its own; evt_next cuts cleanly from the
    // one already chosen, which is what a skill valuing continuity is asking for.
    const ir = makeIR({
      events: [
        { id: 'evt_first', description: '始まり', metrics: { story_importance: 0.9 } },
        { id: 'evt_next', description: '続き', metrics: { story_importance: 0.8 } },
        { id: 'evt_other', description: '別の場面', metrics: { story_importance: 0.83 } },
      ],
      relations: [['evt_first', 'continuation', 'evt_next', 1]],
    });

    expect(chosen(ir, styled({ scoring: { ...base.scoring, continuity_bonus: 0 } }))).toEqual([
      'evt_first',
      'evt_other',
    ]);
    expect(chosen(ir, styled({ scoring: { ...base.scoring, continuity_bonus: 0.3 } }))).toEqual([
      'evt_first',
      'evt_next',
    ]);
  });

  it('fills a segment that insists on a role with one that has it', () => {
    // The opening wants a setup shot and the loudest material is not one.
    // tech-youtube declares exactly this, for exactly this reason: a piece that
    // never says what it is about loses the viewer in the first seconds.
    const ir = makeIR({
      events: [
        {
          id: 'evt_loud',
          description: '派手な場面',
          role: 'reaction',
          metrics: { story_importance: 0.95, emotional_intensity: 0.95 },
        },
        {
          id: 'evt_setup',
          description: '今日はこれの話',
          role: 'setup',
          metrics: { story_importance: 0.4 },
        },
        {
          id: 'evt_end',
          description: '終わり',
          role: 'ending',
          metrics: { story_importance: 0.9 },
        },
      ],
    });

    const withOpening = (require_roles: NarrativeRole[]): SkillManifest =>
      styled({
        arc: {
          ordering: 'chronological',
          segments: [
            { name: 'opening', budget: 0.5, prefer_roles: [], require_roles },
            { name: 'ending', budget: 0.5, prefer_roles: [], require_roles: [] },
          ],
        },
      });

    expect(chosen(ir, withOpening([]))).not.toContain('evt_setup');
    expect(chosen(ir, withOpening(['setup']))).toContain('evt_setup');
  });
});

describe('a transition a skill asks for', () => {
  it('writes the one on the way out, not only the one on the way in', () => {
    // The plan contract carries `transition_out`, the validator checks it and
    // both adapters write it. The planner was the link that dropped it, so a
    // skill rule asking for a fade out did nothing whatsoever.
    const base = registry.resolve('base-editor');
    const skill: SkillManifest = {
      ...base,
      rules: [
        ...base.rules,
        {
          id: 'fade-out-of-the-last-look',
          when: { narrative_role: 'ending' },
          action: { transition_out: { type: 'fade_out', duration_ms: 900 } },
          priority: 50,
        },
      ],
    };

    const ir = makeIR({
      events: [
        { id: 'evt_middle', description: '途中', role: 'context' },
        { id: 'evt_last', description: '終わり', role: 'ending' },
      ],
    });

    const operations = planEdit({ ir, skill, targetDurationMs: 30_000 }).tracks.video;
    const last = operations.find((op) => op.event_id === 'evt_last');
    expect(last?.transition_out).toEqual({ type: 'fade_out', duration_ms: 900 });
    expect(operations.find((op) => op.event_id === 'evt_middle')?.transition_out).toBeUndefined();
  });
});

describe('a clip that only makes sense after another', () => {
  const base = registry.resolve('base-editor');

  /** Question, answer, and a reply to the answer — then the question is cut. */
  function chain() {
    return makeIR({
      events: [
        { id: 'evt_question', description: 'それでどうだった？', excluded: true },
        {
          id: 'evt_answer',
          description: 'すごく良かった',
          metrics: { story_importance: 0.9 },
          flags: { requires_previous_context: 0.9 },
        },
        {
          id: 'evt_reply',
          description: 'でしょう',
          metrics: { story_importance: 0.8 },
          flags: { requires_previous_context: 0.9 },
        },
        { id: 'evt_unrelated', description: '別の場面', metrics: { story_importance: 0.7 } },
      ],
    });
  }

  it('takes the whole chain out, not just the first link', () => {
    // The pass walked the selection in the order things were selected, which is
    // by value within an arc segment. Dropping the answer orphaned the reply,
    // and the reply had already been looked at and kept.
    const kept = planEdit({ ir: chain(), skill: base, targetDurationMs: 60_000 }).tracks.video.map(
      (op) => op.event_id,
    );
    expect(kept).toEqual(['evt_unrelated']);
  });

  it('keeps a clip whose predecessor is in the cut', () => {
    const ir = makeIR({
      events: [
        {
          id: 'evt_question',
          description: 'それでどうだった？',
          metrics: { story_importance: 0.9 },
        },
        {
          id: 'evt_answer',
          description: 'すごく良かった',
          metrics: { story_importance: 0.9 },
          flags: { requires_previous_context: 0.9 },
        },
      ],
    });
    const kept = planEdit({ ir, skill: base, targetDurationMs: 60_000 }).tracks.video.map(
      (op) => op.event_id,
    );
    expect(kept).toEqual(['evt_question', 'evt_answer']);
  });
});

describe('the tags a skill attaches', () => {
  it('reaches the plan, which is where they are documented to go', () => {
    // `tag` has been in the format since it was written, described as "free
    // tags, carried into the plan's rationale". The rule runtime collected them
    // onto the directive and nothing read that field, and the rationale had
    // nowhere to put them: an author could write a tag and never see it again.
    const base = registry.resolve('base-editor');
    const skill: SkillManifest = {
      ...base,
      rules: [
        ...base.rules,
        {
          id: 'mark-the-sponsor-read',
          when: { narrative_role: 'context' },
          action: { tag: ['sponsor', 'needs-music'] },
          priority: 10,
        },
      ],
    };

    const ir = makeIR({
      events: [
        { id: 'evt_read', description: '提供の読み上げ', role: 'context' },
        { id: 'evt_other', description: '別の場面', role: 'payoff' },
      ],
    });

    const plan = planEdit({ ir, skill, targetDurationMs: 30_000 });
    const read = plan.rationale.find((entry) => entry.event_id === 'evt_read');
    const other = plan.rationale.find((entry) => entry.event_id === 'evt_other');
    expect(read?.tags).toEqual(['sponsor', 'needs-music']);
    expect(other?.tags).toEqual([]);
  });
});
