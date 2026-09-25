import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplyRequest } from '@editorial-ir/adapters';
import type {
  EditPlan,
  EditorialIR,
  MediaAsset,
  PlanMarker,
  VideoOperation,
} from '@editorial-ir/contracts';
import { makeAsset, makeIR } from './ir.js';

/**
 * Hand-written plans for the adapters.
 *
 * The worked example is three camera files with stereo sound, so it never
 * reaches the parts of an adapter that matter for anything else: a still, a
 * sound file, a drone clip with no audio at all, a camera with a lavalier on its
 * second track. These builders make those the only part of a test written out.
 */

export type OperationSpec = Pick<
  VideoOperation,
  'source_asset_id' | 'source_in_ms' | 'source_out_ms' | 'timeline_start_ms'
> &
  Partial<VideoOperation>;

export function makePlan(
  operations: OperationSpec[],
  extra: {
    audio?: EditPlan['tracks']['audio'];
    text?: EditPlan['tracks']['text'];
    markers?: PlanMarker[];
    rate?: [number, number];
    width?: number;
    height?: number;
  } = {},
): EditPlan {
  const [num, den] = extra.rate ?? [30, 1];
  const video: VideoOperation[] = operations.map((spec, index) => ({
    operation_id: `op_${String(index + 1).padStart(4, '0')}`,
    track: 0,
    speed: 1,
    use_source_audio: true,
    provenance: 'agent_derived',
    ...spec,
  }));
  const end = Math.max(
    0,
    ...video.map((o) => o.timeline_start_ms + (o.source_out_ms - o.source_in_ms) / o.speed),
  );
  return {
    edit_plan_version: '0.1.0',
    id: 'plan_test',
    project_id: 'prj_test',
    created_at: '2026-09-24T00:00:00.000Z',
    ir_fingerprint: 'test-fingerprint',
    skill: { name: 'travel-vlog', version: '0.1.0' },
    sequence: {
      name: 'Harbour days',
      target_duration_ms: Math.round(end),
      tolerance_ms: 0,
      width: extra.width ?? 1920,
      height: extra.height ?? 1080,
      frame_rate: num / den,
      frame_rate_num: num,
      frame_rate_den: den,
      sample_rate: 48_000,
    },
    tracks: {
      video,
      audio: extra.audio ?? [{ type: 'source_audio', track: 0, gain_db: 0 }],
      text: extra.text ?? [],
    },
    markers: extra.markers ?? [],
    intent: { tone: [] },
    rationale: [],
    model_runs: [],
    stats: {
      operation_count: video.length,
      total_duration_ms: Math.round(end),
      duration_error_ms: 0,
      compression_ratio: 0.1,
      events_selected: video.length,
      events_available: video.length,
      mean_importance: 0.5,
      mean_continuity: 0.5,
    },
  };
}

/**
 * Five files, one of each kind an adapter has to tell apart:
 *
 * - `asset_001` camera clip, stereo
 * - `asset_002` a photograph
 * - `asset_003` a mono voice memo, sound only
 * - `asset_004` a drone clip with no audio stream at all
 * - `asset_005` a camera with room tone on stream 0 (stereo) and a lavalier on
 *   stream 1 (mono)
 */
export function mixedAssets(): MediaAsset[] {
  return [
    makeAsset({
      id: 'asset_001',
      path: '/media/C0001.MP4',
      file_name: 'C0001.MP4',
      duration_ms: 60_000,
      audio_codec: 'aac',
      audio_channels: 2,
      audio_streams: [{ index: 0, codec: 'aac', channels: 2, sample_rate: 48_000 }],
    }),
    makeAsset({
      id: 'asset_002',
      path: '/media/IMG_2001.jpg',
      file_name: 'IMG_2001.jpg',
      kind: 'image',
      duration_ms: 0,
      width: 4032,
      height: 3024,
      audio_streams: [],
    }),
    makeAsset({
      id: 'asset_003',
      path: '/media/memo.m4a',
      file_name: 'memo.m4a',
      kind: 'audio',
      duration_ms: 30_000,
      width: undefined,
      height: undefined,
      fps: undefined,
      fps_num: undefined,
      fps_den: undefined,
      audio_codec: 'aac',
      audio_channels: 1,
      audio_sample_rate: 44_100,
      audio_streams: [{ index: 0, codec: 'aac', channels: 1, sample_rate: 44_100 }],
    }),
    makeAsset({
      id: 'asset_004',
      path: '/media/DJI_0042.MP4',
      file_name: 'DJI_0042.MP4',
      duration_ms: 60_000,
      audio_streams: [],
    }),
    makeAsset({
      id: 'asset_005',
      path: '/media/C0007.MP4',
      file_name: 'C0007.MP4',
      duration_ms: 60_000,
      audio_codec: 'aac',
      audio_channels: 2,
      audio_streams: [
        { index: 0, codec: 'aac', channels: 2, sample_rate: 48_000 },
        { index: 1, codec: 'aac', channels: 1, sample_rate: 48_000 },
      ],
    }),
  ];
}

/**
 * One clip of each: a camera clip, a still dissolved into, a voice memo, a
 * drone clip that asks for sound it does not have, and the lavalier's stream,
 * fading out at the end — 4 s each, back to back.
 */
export function mixedPlan(extra: Parameters<typeof makePlan>[1] = {}): EditPlan {
  return makePlan(
    [
      {
        source_asset_id: 'asset_001',
        source_in_ms: 10_000,
        source_out_ms: 14_000,
        timeline_start_ms: 0,
      },
      {
        source_asset_id: 'asset_002',
        source_in_ms: 0,
        source_out_ms: 4000,
        timeline_start_ms: 4000,
        transition_in: { type: 'cross_dissolve', duration_ms: 1000 },
      },
      {
        source_asset_id: 'asset_003',
        source_in_ms: 2000,
        source_out_ms: 6000,
        timeline_start_ms: 8000,
      },
      {
        source_asset_id: 'asset_004',
        source_in_ms: 5000,
        source_out_ms: 9000,
        timeline_start_ms: 12_000,
      },
      {
        source_asset_id: 'asset_005',
        source_in_ms: 20_000,
        source_out_ms: 24_000,
        timeline_start_ms: 16_000,
        audio_stream_index: 1,
        transition_out: { type: 'fade_out', duration_ms: 1000 },
      },
    ],
    extra,
  );
}

export function mixedIr(assets: MediaAsset[] = mixedAssets()): EditorialIR {
  return makeIR({ events: [], assets });
}

export function requestFor(plan: EditPlan, ir: EditorialIR = mixedIr()): ApplyRequest {
  return {
    plan,
    ir,
    projectRoot: '/project',
    outputDir: mkdtempSync(join(tmpdir(), 'editorial-ir-adapters-')),
    name: 'cut',
  };
}
