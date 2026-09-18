import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '@editorial-ir/skills';
import { planEdit, validatePlan } from '@editorial-ir/agent';
import type { EditorialIR, ProjectConstraints } from '@editorial-ir/contracts';
import { makeAsset, makeIR } from './support/ir.js';

/**
 * The constraints the user writes down, which nothing was reading.
 *
 * `ProjectContext` is described in the contract as "everything the user knows
 * that the media cannot contain", and AGENTS.md puts user knowledge above every
 * model. Three of its fields were declared, shipped in the worked example's own
 * `context.yaml`, and read by no code at all:
 *
 * - `min_clip_duration_ms` / `max_clip_duration_ms`. A project asking for an
 *   eight-second minimum got clips of 2.7s, 2.0s, 2.5s, 9s and 3.8s, with
 *   nothing said by `plan` or by `oea review`.
 * - `required_assets`, "assets that must appear at least once". Setting it to
 *   one recording produced a cut using the other two, and `oea review` reported
 *   "nothing to report".
 *
 * A fourth, `rotation`, was probed and stored at ingest and read nowhere, so a
 * phone-shot portrait project silently became sixteen by nine — which is the one
 * outcome the comment above that code says must not happen.
 */

const registry = SkillRegistry.withBuiltIns();

function withConstraints(ir: EditorialIR, constraints: Partial<ProjectConstraints>): EditorialIR {
  return {
    ...ir,
    context: { ...ir.context, constraints: { ...ir.context.constraints, ...constraints } },
  };
}

/**
 * Two recordings, deliberately unequal.
 *
 * `asset_001` holds everything worth keeping and `asset_002` holds the dregs, so
 * that "this recording must appear" is a claim the ranking would never satisfy
 * on its own — otherwise the test passes whether the constraint is read or not.
 * Event lengths alternate around any plausible floor, so a floor has both
 * something to take and something to refuse.
 */
function project(): EditorialIR {
  return makeIR({
    assets: [
      makeAsset({ id: 'asset_001', file_name: 'a.mov', duration_ms: 240_000 }),
      makeAsset({ id: 'asset_002', file_name: 'b.mov', duration_ms: 240_000 }),
    ],
    events: Array.from({ length: 16 }, (_, i) => {
      // Spread through the piece rather than bunched at the end: the arc fills
      // an opening, a middle and an ending from whatever falls in each, so a
      // recording that only appears in the last quarter gets chosen for its
      // position no matter how poor it is — and the test would then pass
      // whether or not the constraint is read at all.
      const dregs = i % 4 === 1;
      return {
        description: `moment number ${i}`,
        event_type: i % 3 === 0 ? 'moment' : 'b_roll',
        asset_id: dregs ? 'asset_002' : 'asset_001',
        duration_ms: i % 3 === 0 ? 2_000 : 20_000,
        metrics: { story_importance: dregs ? 0.05 : 0.5 + (i % 5) * 0.1 },
      };
    }),
  });
}

function plan(ir: EditorialIR, targetDurationMs = 40_000) {
  return planEdit({ ir, skill: registry.resolve('travel-vlog'), targetDurationMs });
}

function clipLengths(edit: ReturnType<typeof plan>): number[] {
  return edit.tracks.video.map((op) => op.source_out_ms - op.source_in_ms);
}

describe('the minimum clip duration the user asked for', () => {
  it('is not handed back a clip shorter than it', () => {
    const floor = 8_000;
    const edit = plan(withConstraints(project(), { min_clip_duration_ms: floor }));
    expect(edit.tracks.video.length).toBeGreaterThan(0);
    for (const length of clipLengths(edit)) expect(length).toBeGreaterThanOrEqual(floor);
  });

  it('refuses the moments too short to satisfy it rather than shortening the floor', () => {
    // The first attempt at this clamped the floor to whatever each event
    // happened to contain, which is the same as not having a floor: it went on
    // choosing two-second events and reporting two-second clips.
    const edit = plan(withConstraints(project(), { min_clip_duration_ms: 8_000 }));
    const excluded = edit.rationale.filter((entry) => entry.reason.includes('minimum'));
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded[0]?.decision).toBe('excluded');
  });

  it('says whose decision it was', () => {
    // The user's, not the skill's — which is why it is `excluded` and not
    // `dropped`, exactly as an excluded asset is.
    const edit = plan(withConstraints(project(), { min_clip_duration_ms: 8_000 }));
    const entry = edit.rationale.find((item) => item.reason.includes('minimum'));
    expect(entry?.reason).toContain('the project asks for');
  });

  it('leaves a project with no such constraint alone', () => {
    const before = clipLengths(plan(project()));
    const after = clipLengths(plan(withConstraints(project(), {})));
    expect(after).toEqual(before);
  });

  it('caps a clip at the maximum the user asked for', () => {
    const ceiling = 3_000;
    const edit = plan(withConstraints(project(), { max_clip_duration_ms: ceiling }));
    expect(edit.tracks.video.length).toBeGreaterThan(0);
    for (const length of clipLengths(edit)) expect(length).toBeLessThanOrEqual(ceiling);
  });
});

describe('an asset the user says must appear', () => {
  it('appears', () => {
    // Worth asserting and worth being honest about: this one holds with the
    // promotion disabled too. The arc fills an opening, a middle and an ending,
    // and on any fixture small enough to reason about it reaches for every
    // recording it can — a single event at importance 0.01 is still selected.
    // So this checks the promise, and the test below is what checks the
    // mechanism.
    const ir = withConstraints(project(), { required_assets: ['asset_002'] });
    const edit = plan(ir);
    expect(edit.tracks.video.some((op) => op.source_asset_id === 'asset_002')).toBe(true);
  });

  it('is kept for a reason that names the constraint', () => {
    const ir = withConstraints(project(), { required_assets: ['asset_002'] });
    const entry = plan(ir).rationale.find((item) => item.reason.includes('must appear'));
    expect(entry?.reason).toContain('asset_002');
  });

  it('does not drag the whole recording in with it', () => {
    // "At least once" is a floor, not an instruction to take everything from
    // that asset at the expense of the rest of the piece.
    const ir = withConstraints(project(), { required_assets: ['asset_002'] });
    const edit = plan(ir);
    const others = edit.tracks.video.filter((op) => op.source_asset_id !== 'asset_002');
    expect(others.length).toBeGreaterThan(0);
  });

  it('is reported when the plan genuinely cannot contain it', () => {
    // Required and excluded at once is a contradiction the user should be told
    // about rather than have silently resolved. The planner cannot satisfy it,
    // so the validator has to say so — before this there was no code for a
    // missing required asset at all, and such a plan validated clean.
    const ir = withConstraints(project(), {
      required_assets: ['asset_002'],
      excluded_assets: ['asset_002'],
    });
    const edit = plan(ir);
    const report = validatePlan(edit, { ir });
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'required_asset_missing')).toBe(true);
  });

  it('says nothing when there is nothing to say', () => {
    const report = validatePlan(plan(project()), { ir: project() });
    expect(report.issues.some((issue) => issue.code === 'required_asset_missing')).toBe(false);
  });
});

describe('the shape of the sequence', () => {
  it('follows the footage rather than the storage format', () => {
    // A phone shooting portrait writes a 1920x1080 frame and a 90-degree
    // display matrix beside it. `rotation` was probed, stored, and read by
    // nothing, so the sequence came out 1920x1080 — landscape, from vertical
    // footage. Verified on a real file with a display matrix before the fix.
    const ir = makeIR({
      assets: [
        makeAsset({
          id: 'asset_001',
          file_name: 'portrait.mov',
          duration_ms: 60_000,
          rotation: 90,
        }),
      ],
      events: [{ description: 'a vertical moment', duration_ms: 20_000 }],
    });
    const edit = plan(ir, 10_000);
    expect(edit.sequence.width).toBe(1080);
    expect(edit.sequence.height).toBe(1920);
  });

  it('leaves an unrotated recording alone', () => {
    const ir = makeIR({
      assets: [makeAsset({ id: 'asset_001', file_name: 'flat.mov', duration_ms: 60_000 })],
      events: [{ description: 'a wide moment', duration_ms: 20_000 }],
    });
    const edit = plan(ir, 10_000);
    expect(edit.sequence.width).toBe(1920);
    expect(edit.sequence.height).toBe(1080);
  });

  it('ranks assets by how big they are on screen', () => {
    // Ranking by coded area and returning display area is how the two halves of
    // one function come to disagree: the biggest coded asset is not necessarily
    // the biggest displayed one once a rotation is involved.
    const ir = makeIR({
      assets: [
        makeAsset({
          id: 'asset_001',
          file_name: 'small.mov',
          duration_ms: 60_000,
          width: 1280,
          height: 720,
        }),
        makeAsset({
          id: 'asset_002',
          file_name: 'big.mov',
          duration_ms: 60_000,
          width: 3840,
          height: 2160,
          rotation: 270,
        }),
      ],
      events: [{ description: 'a moment', duration_ms: 20_000 }],
    });
    const edit = plan(ir, 10_000);
    expect(edit.sequence.width).toBe(2160);
    expect(edit.sequence.height).toBe(3840);
  });
});
