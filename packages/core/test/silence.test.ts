import { describe, expect, it } from 'vitest';
import {
  EMPTY_OBSERVATIONS,
  type MediaAsset,
  type ObservationTimeline,
} from '@editorial-ir/contracts';
import { inactiveSpans, silentSpans } from '../src/activity.js';
import { makeAsset } from '../../../tests/support/ir.js';

/**
 * The one definition of silence, which the planner now reads through
 * `silentSpans` and the mask states inline.
 *
 * The planner used to read the per-recording silence events on its own, and
 * under a music bed those fire between the words while the music plays on. The
 * last test here is what keeps the two statements of the rule the same rule.
 */
function observations(overrides: Partial<ObservationTimeline> = {}): ObservationTimeline {
  return {
    project_id: 'prj_test',
    pipeline_version: '0.1.0',
    generated_at: '2026-09-24T00:00:00.000Z',
    fingerprint: 'test',
    ...EMPTY_OBSERVATIONS,
    ...overrides,
  };
}

const asset: MediaAsset = makeAsset({ duration_ms: 20_000, audio_codec: 'aac' });
const gap = {
  id: 'aev_1',
  asset_id: 'asset_001',
  start_ms: 5000,
  end_ms: 7000,
  event_type: 'silence' as const,
  confidence: 0.9,
};
const level = (db: number) => ({ asset_id: 'asset_001', hop_ms: 100, rms_db: Array(200).fill(db) });

describe('silentSpans', () => {
  it('is not silent between the words of a narration over a music bed', () => {
    expect(
      silentSpans(observations({ audio_events: [gap], audio_profiles: [level(-25)] }), asset),
    ).toEqual([]);
  });

  it('is silent where the room is quiet too', () => {
    expect(
      silentSpans(observations({ audio_events: [gap], audio_profiles: [level(-50)] }), asset),
    ).toEqual([{ start_ms: 5000, end_ms: 7000 }]);
  });

  it('takes the detector at its word when no level was measured', () => {
    // The worked example records no envelope; its cuts must not move.
    expect(silentSpans(observations({ audio_events: [gap] }), asset)).toEqual([
      { start_ms: 5000, end_ms: 7000 },
    ]);
  });

  it('calls a file with no audio track silent throughout, and an unanalysed one not at all', () => {
    const drone = makeAsset({ duration_ms: 20_000, audio_streams: [] });
    expect(silentSpans(observations(), drone)).toEqual([{ start_ms: 0, end_ms: 20_000 }]);
    expect(silentSpans(observations(), asset)).toEqual([]);
  });

  it('is exactly what the mask counts as silent', () => {
    // A still picture over the whole file: whatever is silent is inactive, less
    // the mask's margins. If the mask's rule and this one ever part, this fails.
    const still = observations({
      audio_events: [{ ...gap, start_ms: 2000, end_ms: 12_000 }],
      audio_profiles: [
        {
          asset_id: 'asset_001',
          hop_ms: 100,
          rms_db: [...Array(80).fill(-50), ...Array(120).fill(-25)],
        },
      ],
      video_events: [
        {
          id: 'vev_1',
          asset_id: 'asset_001',
          start_ms: 0,
          end_ms: 20_000,
          event_type: 'static',
          confidence: 0.9,
        },
      ],
      motion_profiles: [{ asset_id: 'asset_001', hop_ms: 200, motion: [0], luma: [100] }],
    });
    const silent = silentSpans(still, asset);
    expect(silent).toEqual([{ start_ms: 2000, end_ms: 8000 }]);
    expect(inactiveSpans(still, [asset], { marginMs: 0, minMs: 0 })).toEqual([
      { asset_id: 'asset_001', ...silent[0]! },
    ]);
  });
});
