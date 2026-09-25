import { describe, expect, it } from 'vitest';
import { SkillManifest, type EditPlan, type VideoOperation } from '@editorial-ir/contracts';
import { validatePlan } from '../src/index.js';
import { makeAsset, makeIR } from '../../../tests/support/ir.js';

/**
 * What the validator knows about the media a plan uses, and about jump cuts.
 */
function plan(operations: Partial<VideoOperation>[], target = 6000): EditPlan {
  let at = 0;
  const video = operations.map((fields, i) => {
    const operation: VideoOperation = {
      operation_id: `op_${String(i + 1).padStart(4, '0')}`,
      source_asset_id: 'asset_001',
      event_id: 'evt_0001',
      source_in_ms: 0,
      source_out_ms: 2000,
      timeline_start_ms: at,
      track: 0,
      speed: 1,
      use_source_audio: false,
      provenance: 'agent_derived',
      ...fields,
    };
    at += operation.source_out_ms - operation.source_in_ms;
    return operation;
  });
  return {
    edit_plan_version: '0.1.0',
    id: 'plan_test',
    project_id: 'prj_test',
    created_at: '2026-09-24T00:00:00.000Z',
    ir_fingerprint: 'test-fingerprint',
    skill: { name: 'probe', version: '0.1.0' },
    sequence: {
      name: 'test',
      target_duration_ms: target,
      tolerance_ms: 500,
      width: 1920,
      height: 1080,
      frame_rate: 30,
      frame_rate_num: 30,
      frame_rate_den: 1,
      sample_rate: 48000,
    },
    tracks: { video, audio: [], text: [] },
    markers: [],
    intent: { tone: [] },
    rationale: [],
    model_runs: [],
    stats: {
      operation_count: video.length,
      total_duration_ms: at,
      duration_error_ms: at - target,
      compression_ratio: 0.1,
      events_selected: 1,
      events_available: 1,
      mean_importance: 0.5,
      mean_continuity: 0.5,
    },
  };
}

const codes = (report: ReturnType<typeof validatePlan>) => report.issues.map((i) => i.code);

describe('a photograph in the plan', () => {
  it('may be held for any length, whatever duration its probe reported', () => {
    // A still has no duration of its own; a probe that reports one frame's
    // worth (40 ms at 25 fps) must not make a three-second hold "past the end".
    const photo = makeAsset({ kind: 'image', duration_ms: 40 });
    const ir = makeIR({ assets: [photo], events: [{ start_ms: 0, duration_ms: 3000 }] });
    const report = validatePlan(plan([{ source_out_ms: 3000 }], 3000), { ir });
    expect(codes(report)).not.toContain('range_out_of_bounds');
  });

  it('still refuses a video read past its end', () => {
    const clip = makeAsset({ duration_ms: 1000 });
    const ir = makeIR({ assets: [clip], events: [{ start_ms: 0, duration_ms: 1000 }] });
    const report = validatePlan(plan([{ source_out_ms: 3000 }], 3000), { ir });
    expect(codes(report)).toContain('range_out_of_bounds');
  });
});

describe('sound the file does not have', () => {
  it('is reported, so an export does not link an audio stream that is not there', () => {
    const drone = makeAsset({ audio_streams: [] });
    const ir = makeIR({ assets: [drone], events: [{ start_ms: 0, duration_ms: 3000 }] });
    const report = validatePlan(plan([{ use_source_audio: true }], 2000), { ir });
    expect(codes(report)).toContain('source_audio_missing');
    expect(report.ok).toBe(true);
  });

  it('says nothing when the file has sound', () => {
    const camera = makeAsset({ audio_codec: 'aac' });
    const ir = makeIR({ assets: [camera], events: [{ start_ms: 0, duration_ms: 3000 }] });
    const report = validatePlan(plan([{ use_source_audio: true }], 2000), { ir });
    expect(codes(report)).not.toContain('source_audio_missing');
  });
});

describe('a clip that says it continues the one before', () => {
  const ir = makeIR({
    assets: [makeAsset({ audio_codec: 'aac' })],
    events: [
      { start_ms: 0, duration_ms: 10_000 },
      { start_ms: 20_000, duration_ms: 10_000 },
    ],
  });

  it('is accepted when it is the same take, later, cut hard', () => {
    const report = validatePlan(
      plan(
        [
          { source_in_ms: 0, source_out_ms: 2000 },
          { source_in_ms: 3000, source_out_ms: 5000, continues_previous: true },
        ],
        4000,
      ),
      { ir },
    );
    expect(codes(report)).not.toContain('invalid_continuation');
  });

  it('is reported when it is really a different moment', () => {
    const report = validatePlan(
      plan(
        [
          { source_in_ms: 0, source_out_ms: 2000 },
          {
            event_id: 'evt_0002',
            source_in_ms: 20_000,
            source_out_ms: 22_000,
            continues_previous: true,
          },
        ],
        4000,
      ),
      { ir },
    );
    expect(codes(report)).toContain('invalid_continuation');
  });

  it('is reported when it goes back over what was already used', () => {
    const report = validatePlan(
      plan(
        [
          { source_in_ms: 2000, source_out_ms: 4000 },
          { source_in_ms: 1000, source_out_ms: 3000, continues_previous: true },
        ],
        4000,
      ),
      { ir },
    );
    expect(codes(report)).toContain('invalid_continuation');
  });

  it('is reported when it asks for a dissolve, which a jump cut never is', () => {
    const report = validatePlan(
      plan(
        [
          { source_in_ms: 0, source_out_ms: 2000 },
          {
            source_in_ms: 3000,
            source_out_ms: 5000,
            continues_previous: true,
            transition_in: { type: 'cross_dissolve', duration_ms: 400 },
          },
        ],
        4000,
      ),
      { ir },
    );
    expect(codes(report)).toContain('invalid_continuation');
  });
});

describe('the longest cut a skill’s limit allows', () => {
  it('counts a take with its pauses out as one moment, not one per piece', () => {
    const ir = makeIR({
      assets: [makeAsset({ audio_codec: 'aac' })],
      events: [{ start_ms: 0, duration_ms: 20_000 }],
    });
    const skill = SkillManifest.parse({ name: 'probe', defaults: { max_clip_duration_ms: 6000 } });
    const report = validatePlan(
      plan(
        [
          { source_in_ms: 0, source_out_ms: 2000 },
          { source_in_ms: 3000, source_out_ms: 5000, continues_previous: true },
          { source_in_ms: 6000, source_out_ms: 8000, continues_previous: true },
        ],
        30_000,
      ),
      { ir, skill },
    );
    const short = report.issues.find((i) => i.code === 'duration_out_of_tolerance')!;
    // One moment at 6 s cannot fill 30 s; three "moments" at 6 s would not
    // either, but would say 18 s were possible.
    expect(short.details?.longest_possible_ms).toBe(6000);
    expect(short.message).toContain('1 moment(s)');
  });
});
