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

/**
 * Two cameras and a recorder that heard the same takes:
 *
 * - `asset_101` a camera with its microphone off: no audio stream at all
 * - `asset_102` a camera with its own stereo sound, a metre from the speaker
 * - `asset_103` the lavalier's recorder, mono, whose clock reads 3.2 s less than
 *   either camera's at the same moment
 */
export function recorderAssets(): MediaAsset[] {
  return [
    makeAsset({
      id: 'asset_101',
      path: '/media/A001C003.MP4',
      file_name: 'A001C003.MP4',
      duration_ms: 60_000,
      audio_streams: [],
    }),
    makeAsset({
      id: 'asset_102',
      path: '/media/B001C004.MP4',
      file_name: 'B001C004.MP4',
      duration_ms: 60_000,
      audio_codec: 'aac',
      audio_channels: 2,
      audio_streams: [{ index: 0, codec: 'aac', channels: 2, sample_rate: 48_000 }],
    }),
    makeAsset({
      id: 'asset_103',
      path: '/media/ZOOM0007.WAV',
      file_name: 'ZOOM0007.WAV',
      kind: 'audio',
      duration_ms: 120_000,
      width: undefined,
      height: undefined,
      fps: undefined,
      fps_num: undefined,
      fps_den: undefined,
      audio_codec: 'pcm_s24le',
      audio_channels: 1,
      audio_sample_rate: 48_000,
      audio_streams: [{ index: 0, codec: 'pcm_s24le', channels: 1, sample_rate: 48_000 }],
    }),
  ];
}

/**
 * Two clips whose sound is the recorder's, back to back at 30 fps: 4 s of the
 * silent camera from its 12 s (the recorder's 8.8 s), then 3 s of the other
 * camera from its 20 s (the recorder's 16.8 s).
 */
export function recorderPlan(extra: Parameters<typeof makePlan>[1] = {}): EditPlan {
  return makePlan(
    [
      {
        source_asset_id: 'asset_101',
        source_in_ms: 12_000,
        source_out_ms: 16_000,
        timeline_start_ms: 0,
        audio_source: { asset_id: 'asset_103', source_in_ms: 8800 },
      },
      {
        source_asset_id: 'asset_102',
        source_in_ms: 20_000,
        source_out_ms: 23_000,
        timeline_start_ms: 4000,
        audio_source: { asset_id: 'asset_103', source_in_ms: 16_800 },
      },
    ],
    extra,
  );
}

export function recorderIr(assets: MediaAsset[] = recorderAssets()): EditorialIR {
  return makeIR({ events: [], assets });
}

/**
 * Two files each played to its last millisecond, at 30 fps, where the frame
 * grid reads a little past the end:
 *
 * - `asset_201` a 2232 ms mono mp3 at 16 kHz, played whole: 66.96 frames of
 *   sound, laid as a 67-frame clip (the probe's `ep12_cover.mp3`)
 * - `asset_202` a 2215 ms camera clip with stereo sound, read from 23 ms to its
 *   end: the clip reads frames 1 to 67 of a file that rounds to 66
 */
export function endOfFileAssets(): MediaAsset[] {
  return [
    makeAsset({
      id: 'asset_201',
      path: '/media/ep12_cover.mp3',
      file_name: 'ep12_cover.mp3',
      kind: 'audio',
      duration_ms: 2232,
      width: undefined,
      height: undefined,
      fps: undefined,
      fps_num: undefined,
      fps_den: undefined,
      audio_codec: 'mp3',
      audio_channels: 1,
      audio_sample_rate: 16_000,
      audio_streams: [{ index: 0, codec: 'mp3', channels: 1, sample_rate: 16_000 }],
    }),
    makeAsset({
      id: 'asset_202',
      path: '/media/C0031.MP4',
      file_name: 'C0031.MP4',
      duration_ms: 2215,
      audio_codec: 'aac',
      audio_channels: 2,
      audio_streams: [{ index: 0, codec: 'aac', channels: 2, sample_rate: 48_000 }],
    }),
  ];
}

export function endOfFilePlan(): EditPlan {
  return makePlan([
    { source_asset_id: 'asset_201', source_in_ms: 0, source_out_ms: 2232, timeline_start_ms: 0 },
    {
      source_asset_id: 'asset_202',
      source_in_ms: 23,
      source_out_ms: 2215,
      timeline_start_ms: 2232,
    },
  ]);
}

/**
 * Three sound files and nothing to look at, as a podcast cut or an audio-only
 * trip diary is:
 *
 * - `asset_301` a mono voice memo, 30 s at 44.1 kHz
 * - `asset_302` a mono podcast, 40 s
 * - `asset_303` a stereo field recording, 30 s
 */
export function soundOnlyAssets(): MediaAsset[] {
  const sound = (id: string, file: string, seconds: number, channels: number): MediaAsset =>
    makeAsset({
      id,
      path: `/media/${file}`,
      file_name: file,
      kind: 'audio',
      duration_ms: seconds * 1000,
      width: undefined,
      height: undefined,
      fps: undefined,
      fps_num: undefined,
      fps_den: undefined,
      audio_codec: 'aac',
      audio_channels: channels,
      audio_sample_rate: 48_000,
      audio_streams: [{ index: 0, codec: 'aac', channels, sample_rate: 48_000 }],
    });
  return [
    sound('asset_301', 'memo.m4a', 30, 1),
    sound('asset_302', 'podcast.m4a', 40, 1),
    sound('asset_303', 'field.wav', 30, 2),
  ];
}

/**
 * Three sound-only clips back to back at 30 fps, 4 s each: the memo from its
 * 10 s, dissolving into the podcast from its 5 s — a second of sound either
 * side of the cut, so the 400 ms cross-fade can be made — then dissolving into
 * the field recording from its very first frame, where there is no sound
 * before the in point to overlap, which fades out at the end.
 */
export function soundOnlyPlan(): EditPlan {
  return makePlan([
    {
      source_asset_id: 'asset_301',
      source_in_ms: 10_000,
      source_out_ms: 14_000,
      timeline_start_ms: 0,
    },
    {
      source_asset_id: 'asset_302',
      source_in_ms: 5000,
      source_out_ms: 9000,
      timeline_start_ms: 4000,
      transition_in: { type: 'cross_dissolve', duration_ms: 400 },
    },
    {
      source_asset_id: 'asset_303',
      source_in_ms: 0,
      source_out_ms: 4000,
      timeline_start_ms: 8000,
      transition_in: { type: 'cross_dissolve', duration_ms: 400 },
      transition_out: { type: 'fade_out', duration_ms: 1000 },
    },
  ]);
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
