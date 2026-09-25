import { describe, expect, it } from 'vitest';
import { SkillManifest, type EditPlan, type VideoOperation } from '@editorial-ir/contracts';
import { planEdit, validatePlan } from '@editorial-ir/agent';
import { makeAsset, makeIR } from './support/ir.js';

/**
 * A clip's sound taken from a separate recorder the analysis lined up with it.
 *
 * The camera's microphone is a metre from the speaker and the recorder is at
 * their collar; the transcript that chose the clip was made from the recorder.
 * So the cut plays the recorder, read at the moment the picture shows — and
 * only where the recorder holds the whole clip, because a clip that changes
 * microphone halfway through sounds like a fault.
 */

const skill = SkillManifest.parse({ name: 'probe', scoring: { weights: { story_importance: 1 } } });

// A camera whose own microphone was off, and a recorder started 3.2 s before it.
const camera = makeAsset({
  id: 'asset_001',
  file_name: 'C0001.MP4',
  duration_ms: 60_000,
  audio_streams: [],
});
const recorder = makeAsset({
  id: 'asset_002',
  file_name: 'ZOOM0001.WAV',
  kind: 'audio',
  duration_ms: 90_000,
  width: undefined,
  height: undefined,
  audio_streams: [{ index: 0, channels: 2 }],
});
const OFFSET = -3_200;

function build(recorderMs = recorder.duration_ms, cameraSound = false) {
  const cam = cameraSound ? { ...camera, audio_streams: [{ index: 0, channels: 2 }] } : camera;
  const rec = { ...recorder, duration_ms: recorderMs };
  const ir = makeIR({
    assets: [cam, rec],
    events: [
      { asset_id: cam.id, start_ms: 2_000, duration_ms: 8_000 },
      { asset_id: cam.id, start_ms: 40_000, duration_ms: 8_000 },
    ],
  });
  ir.audio_companions = [
    {
      asset_id: cam.id,
      audio_asset_id: rec.id,
      offset_ms: OFFSET,
      confidence: 0.8,
      provenance: 'inferred',
    },
  ];
  return ir;
}

function clips(plan: EditPlan): VideoOperation[] {
  return [...plan.tracks.video].sort((a, b) => a.timeline_start_ms - b.timeline_start_ms);
}

describe('the planner, with a recorder', () => {
  it('takes each clip’s sound from the recorder, at the moment the picture shows', () => {
    const plan = planEdit({ ir: build(), skill, targetDurationMs: 16_000 });
    const ops = clips(plan);
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(op.use_source_audio).toBe(true);
      expect(op.audio_source).toEqual({
        asset_id: recorder.id,
        // The recorder started first, so it is 3.2 s further in.
        source_in_ms: op.source_in_ms - OFFSET,
      });
    }
  });

  it('keeps the camera’s own sound for a clip the recorder does not hold end to end', () => {
    // The recorder stops 30 s into its own time: 26.8 s into the camera's.
    const plan = planEdit({ ir: build(30_000, true), skill, targetDurationMs: 16_000 });
    const [early, late] = clips(plan);
    expect(early!.audio_source).toBeDefined();
    expect(late!.audio_source).toBeUndefined();
    expect(late!.use_source_audio).toBe(true);
  });

  it('leaves a clip silent where there is no recorder and no microphone', () => {
    const plan = planEdit({ ir: build(30_000, false), skill, targetDurationMs: 16_000 });
    const late = clips(plan)[1]!;
    expect(late.audio_source).toBeUndefined();
    expect(late.use_source_audio).toBe(false);
  });

  it('validates a camera with no sound of its own, heard through its recorder', () => {
    const ir = build();
    const plan = planEdit({ ir, skill, targetDurationMs: 16_000 });
    const report = validatePlan(plan, { ir });
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // The camera has no audio stream, and that is not a problem: the sound is elsewhere.
    expect(report.issues.some((i) => i.code === 'source_audio_missing')).toBe(false);
  });
});

describe('the validator, on a recorder', () => {
  const ir = build();
  const plan = planEdit({ ir, skill, targetDurationMs: 16_000 });
  const withSource = (source: VideoOperation['audio_source']): EditPlan => ({
    ...plan,
    tracks: {
      ...plan.tracks,
      video: plan.tracks.video.map((op, i) => (i === 0 ? { ...op, audio_source: source } : op)),
    },
  });

  it('refuses sound from a file that is not in the project', () => {
    const report = validatePlan(withSource({ asset_id: 'asset_999', source_in_ms: 0 }), { ir });
    expect(report.issues.map((i) => i.code)).toContain('unknown_asset');
    expect(report.ok).toBe(false);
  });

  it('refuses sound read past the end of the recorder', () => {
    const report = validatePlan(withSource({ asset_id: recorder.id, source_in_ms: 88_000 }), {
      ir,
    });
    const issue = report.issues.find((i) => i.code === 'range_out_of_bounds');
    expect(issue?.asset_id).toBe(recorder.id);
    expect(report.ok).toBe(false);
  });
});
