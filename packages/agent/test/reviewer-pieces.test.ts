import { describe, expect, it } from 'vitest';
import type { EditPlan, VideoOperation } from '@editorial-ir/contracts';
import { reviewPlan } from '../src/index.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * A take with its pauses taken out, read back by the reviewer.
 *
 * It is several clips and one moment. Read as clips, a two-word piece of a
 * sentence is "too short to register", the second half of the sentence is
 * "missing its context", and every jump cut is flagged once per piece.
 */
function plan(operations: Partial<VideoOperation>[]): EditPlan {
  let at = 0;
  const video = operations.map((fields, i) => {
    const operation: VideoOperation = {
      operation_id: `op_${String(i + 1).padStart(4, '0')}`,
      source_asset_id: 'asset_001',
      event_id: 'evt_0002',
      source_in_ms: 0,
      source_out_ms: 2000,
      timeline_start_ms: at,
      track: 0,
      speed: 1,
      use_source_audio: true,
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
    skill: { name: 'talking-head', version: '0.1.0' },
    sequence: {
      name: 'test',
      target_duration_ms: at,
      tolerance_ms: 0,
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
      duration_error_ms: 0,
      compression_ratio: 0.1,
      events_selected: 1,
      events_available: 2,
      mean_importance: 0.5,
      mean_continuity: 0.5,
    },
  };
}

// The second event follows on from the first, which is not in the cut.
const ir = makeIR({
  events: [
    { start_ms: 0, duration_ms: 10_000 },
    { start_ms: 10_000, duration_ms: 20_000, flags: { requires_previous_context: 0.9 } },
  ],
});

const pieces = plan([
  { source_in_ms: 10_000, source_out_ms: 12_000 },
  // One word between two pauses, with its handles.
  { source_in_ms: 13_000, source_out_ms: 13_540, continues_previous: true },
  { source_in_ms: 15_000, source_out_ms: 17_000, continues_previous: true },
]);

describe('reviewing a take cut into pieces', () => {
  it('does not call a piece of a sentence too short to register', () => {
    const found = reviewPlan(pieces, ir).filter((o) => o.observation_type === 'too_short');
    expect(found).toEqual([]);
  });

  it('says once, not once per piece, that the moment is missing its context', () => {
    const found = reviewPlan(pieces, ir).filter((o) => o.observation_type === 'missing_context');
    expect(found.map((o) => o.operation_id)).toEqual(['op_0001']);
  });

  it('still calls a lone clip of that length too short', () => {
    const lone = plan([{ source_in_ms: 13_000, source_out_ms: 13_540 }]);
    const found = reviewPlan(lone, ir).filter((o) => o.observation_type === 'too_short');
    expect(found).toHaveLength(1);
  });

  it('does not excuse a clip that only claims to continue a different moment', () => {
    // An agent's plan can set the flag on anything. A 540 ms clip of another
    // event is still too short to register, whatever it says about itself.
    const claimed = plan([
      { source_in_ms: 10_000, source_out_ms: 12_000 },
      {
        event_id: 'evt_0001',
        source_in_ms: 3000,
        source_out_ms: 3540,
        continues_previous: true,
      },
    ]);
    const found = reviewPlan(claimed, ir).filter((o) => o.observation_type === 'too_short');
    expect(found.map((o) => o.operation_id)).toEqual(['op_0002']);
  });
});
