import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DescribeResult,
  ProjectContext,
  type AnalyzeAudioParams,
  type DescribeParams,
  type EmbedFramesParams,
  type MediaAsset,
  type OcrParams,
  type PrepareParams,
  type PrepareResult,
  type TranscribeParams,
} from '@editorial-ir/contracts';
import { HashingTextEmbedding, type PerceptionSuite } from '@editorial-ir/perception';
import { MemoryCache, ModelRunRecorder, buildSemanticEvents, observeAssets } from '../src/index.js';

/**
 * What each stage is handed, for the inputs that broke it.
 *
 * A drone clip with no audio track went through every audio stage anyway: its
 * extraction failed, the loudness analyser was handed the .mp4 as a WAV, and the
 * worker's transcriber crashed — three failures for an ordinary file, and an
 * analysis that could never be reused because it held failures. Photos were
 * registered and never looked at. A camera's second audio track was never heard.
 */

const root = mkdtempSync(join(tmpdir(), 'oea-observe-media-'));
const identity = (backend: string) => ({
  backend,
  locality: 'local' as const,
  mediaLeavesDevice: false,
});

function asset(overrides: Partial<MediaAsset>): MediaAsset {
  return {
    id: 'asset_001',
    path: 'footage/clip.mp4',
    file_name: 'clip.mp4',
    kind: 'video',
    sha256: 'b'.repeat(64),
    byte_size: 1,
    duration_ms: 10_000,
    width: 1280,
    height: 720,
    video_codec: 'h264',
    audio_codec: 'aac',
    metadata: {},
    ...overrides,
  };
}

interface Seen {
  prepare: PrepareParams[];
  transcribe: TranscribeParams[];
  audio: AnalyzeAudioParams[];
  visual: EmbedFramesParams[];
  ocr: OcrParams[];
}

function suite(
  prepared: ((params: PrepareParams) => PrepareResult) | undefined,
  seen: Seen,
): PerceptionSuite {
  return {
    probe: {
      identity: identity('fake'),
      probe: async () => ({ duration_ms: 0, metadata: {} }),
    },
    ...(prepared
      ? {
          preparer: {
            identity: identity('fake'),
            prepare: async (params: PrepareParams) => {
              seen.prepare.push(params);
              return prepared(params);
            },
          },
        }
      : {}),
    speech: {
      identity: identity('fake-asr'),
      transcribe: async (params: TranscribeParams) => {
        seen.transcribe.push(params);
        return { utterances: [{ start_ms: 0, end_ms: 1000, text: 'hello', confidence: 0.9 }] };
      },
    },
    audio: {
      identity: identity('fake-audio'),
      analyzeAudio: async (params: AnalyzeAudioParams) => {
        seen.audio.push(params);
        return { hop_ms: 100, rms_db: [-30, -30], speech_prob: [0.8, 0.8], events: [] };
      },
    },
    visual: {
      identity: identity('fake-visual'),
      dim: 2,
      embedFrames: async (params: EmbedFramesParams) => {
        seen.visual.push(params);
        return {
          dim: 2,
          frames: params.timestamps_ms.map((t) => ({
            timestamp_ms: t,
            vector: [1, 0],
            labels: [],
          })),
        };
      },
    },
    ocr: {
      identity: identity('fake-ocr'),
      ocr: async (params: OcrParams) => {
        seen.ocr.push(params);
        return {
          observations: [{ start_ms: 0, end_ms: 1000, text: 'Kyoto station', confidence: 0.9 }],
        };
      },
    },
    text: new HashingTextEmbedding(),
  };
}

function seen(): Seen {
  return { prepare: [], transcribe: [], audio: [], visual: [], ocr: [] };
}

async function observe(
  assets: MediaAsset[],
  prepared: ((params: PrepareParams) => PrepareResult) | undefined,
  record: Seen,
  cache?: MemoryCache,
) {
  return observeAssets(assets, {
    projectRoot: root,
    workDir: join(root, 'work'),
    suite: suite(prepared, record),
    runs: new ModelRunRecorder(() => '2026-09-01T00:00:00.000Z'),
    ...(cache ? { cache } : {}),
  });
}

const madeFrames = (params: PrepareParams): PrepareResult => ({
  proxy_path: join(params.work_dir, 'proxy-480p-cfr30.mp4'),
  frames_dir: join(params.work_dir, 'frames-1fps'),
  frame_timestamps_ms: [0, 1000],
  audio_stream_count: 0,
});

describe('a video with no audio track', () => {
  it('is neither transcribed nor measured, and nothing about it is a failure', async () => {
    const record = seen();
    const result = await observe(
      [asset({ audio_codec: undefined, audio_streams: [] })],
      madeFrames,
      record,
    );
    expect(record.prepare[0]?.extract_audio).toBe(false);
    expect(record.transcribe).toEqual([]);
    expect(record.audio).toEqual([]);
    expect(result.failures).toEqual([]);
    // Not "unavailable" either: the stage exists; the file has nothing for it.
    expect(result.unavailable.map((u) => u.stage)).not.toContain('speech');
  });

  it('is recognised on an asset registered before streams were listed', async () => {
    const record = seen();
    await observe([asset({ audio_codec: undefined })], madeFrames, record);
    expect(record.transcribe).toEqual([]);
  });

  it('is recognised by the preparer when the asset does not know', async () => {
    // An asset that claims audio, a file that has none: prepare reads the file.
    const record = seen();
    const result = await observe([asset({})], madeFrames, record);
    expect(record.audio).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});

describe('audio that could not be extracted', () => {
  it('is one failure, and the video is never handed to a reader of WAV files', async () => {
    const record = seen();
    const result = await observe(
      [asset({ audio_streams: [{ index: 0, codec: 'aac', channels: 2 }] })],
      (params) => ({
        ...madeFrames(params),
        audio_stream_count: 1,
        failed: [{ derivative: 'audio', reason: 'ffmpeg failed: something broke' }],
      }),
      record,
    );
    expect(result.failures).toEqual([
      { stage: 'prepare', assetId: 'asset_001', reason: 'audio: ffmpeg failed: something broke' },
    ]);
    expect(record.audio).toEqual([]);
    expect(record.transcribe).toEqual([]);
  });

  it('is not read from the original when prepare threw outright', async () => {
    const record = seen();
    const result = await observe(
      [asset({})],
      () => {
        throw new Error('ffprobe could not read it');
      },
      record,
    );
    expect(result.failures.map((f) => f.stage)).toEqual(['prepare']);
    expect(record.audio).toEqual([]);
  });

  it('is read from the original when nothing prepares files at all', async () => {
    // A replayed fixture is keyed by the media's own name, and a real
    // transcriber reads the original. This is the path the worked example takes.
    const record = seen();
    await observe([asset({})], undefined, record);
    expect(record.audio[0]?.audio_path).toBe(join(root, 'footage/clip.mp4'));
  });
});

describe('a file with several audio streams', () => {
  const twoStreams = asset({
    audio_streams: [
      { index: 0, codec: 'aac', channels: 2 },
      { index: 1, codec: 'aac', channels: 1 },
    ],
  });
  const chose =
    (index: number) =>
    (params: PrepareParams): PrepareResult => ({
      ...madeFrames(params),
      audio_path: join(params.work_dir, `audio-a${index}.wav`),
      audio_stream_count: 2,
      audio_stream_index: index,
      audio_stream_reason: index === 1 ? 'most speech of 2 (0.47 vs 0.00)' : 'asked for',
    });

  it('never serves a transcript of one stream for another', async () => {
    // Paths are left out of the cache key so a moved project is not re-analysed,
    // which also left out which stream the WAV held.
    const cache = new MemoryCache();
    const record = seen();
    await observe([twoStreams], chose(0), record, cache);
    await observe([twoStreams], chose(1), record, cache);
    expect(record.transcribe.map((p) => p.audio_stream_index)).toEqual([0, 1]);
    expect(record.audio.map((p) => p.audio_stream_index)).toEqual([0, 1]);
    await observe([twoStreams], chose(1), record, cache);
    expect(record.transcribe).toHaveLength(2);
  });

  it('says which stream it listened to, and why', async () => {
    const result = await observe([twoStreams], chose(1), seen());
    expect(result.observations.audio_profiles[0]).toMatchObject({
      stream_index: 1,
      stream_reason: 'most speech of 2 (0.47 vs 0.00)',
    });
  });

  it('leaves the key of an ordinary single-stream file as it always was', async () => {
    const record = seen();
    const result = await observe(
      [asset({ audio_streams: [{ index: 0, codec: 'aac', channels: 2 }] })],
      (params) => ({
        ...madeFrames(params),
        audio_path: join(params.work_dir, 'audio-a0.wav'),
        audio_stream_count: 1,
        audio_stream_index: 0,
        audio_stream_reason: 'the only one',
      }),
      record,
    );
    expect(record.transcribe[0]).not.toHaveProperty('audio_stream_index');
    expect(result.observations.audio_profiles[0]).not.toHaveProperty('stream_index');
  });
});

describe('a still', () => {
  const photo = asset({
    id: 'asset_002',
    path: 'footage/IMG_2003.jpg',
    file_name: 'IMG_2003.jpg',
    kind: 'image',
    duration_ms: 0,
    video_codec: 'mjpeg',
    audio_codec: undefined,
    audio_streams: undefined,
  });

  it('is looked at and read, once, at 0 ms, from the picture itself', async () => {
    const record = seen();
    const result = await observe([photo], madeFrames, record);
    expect(record.prepare).toEqual([]);
    expect(record.visual).toHaveLength(1);
    expect(record.visual[0]).toMatchObject({
      path: join(root, 'footage/IMG_2003.jpg'),
      timestamps_ms: [0],
    });
    expect(record.ocr[0]).toMatchObject({
      path: join(root, 'footage/IMG_2003.jpg'),
      timestamps_ms: [0],
    });
    expect(result.observations.frame_features.map((f) => f.asset_id)).toEqual(['asset_002']);
    expect(result.observations.ocr.map((o) => o.text)).toEqual(['Kyoto station']);
    expect(result.derived.get('asset_002')?.proxy_path).toBe(join(root, 'footage/IMG_2003.jpg'));
  });
});

describe('a closer look at a still', () => {
  it('sends the picture itself, once', async () => {
    // Frames for a closer look came only from prepare's frames directory, which
    // a still never has, so a photo was described from its file name.
    const photo = asset({
      id: 'asset_002',
      path: 'footage/IMG_2003.jpg',
      file_name: 'IMG_2003.jpg',
      kind: 'image',
      duration_ms: 0,
      audio_codec: undefined,
    });
    const observed = await observe([photo], madeFrames, seen());
    const sent: string[][] = [];
    const looker = {
      identity: identity('closer-look'),
      describe: async (params: DescribeParams) => {
        sent.push(params.frame_paths);
        return DescribeResult.parse({ description: 'a station sign', confidence: 0.9 });
      },
    };
    await buildSemanticEvents(
      [
        {
          asset_id: 'asset_002',
          start_ms: 0,
          end_ms: 4000,
          shot_ids: [],
          method: 'asset',
          boundary_confidence: 1,
        },
      ],
      {
        assets: [photo],
        placements: [{ asset_id: 'asset_002', offset_ms: 0, order: 0, ordered_by: 'file_name' }],
        observations: {
          ...observed.observations,
          project_id: 'prj',
          fingerprint: '',
          generated_at: '',
        },
        context: ProjectContext.parse({
          project_id: 'prj_test',
          updated_at: '2026-09-01T00:00:00.000Z',
        }),
        annotations: [],
        runs: new ModelRunRecorder(() => '2026-09-01T00:00:00.000Z'),
        escalationModel: looker,
        escalation: { minItems: 1 },
        derived: observed.derived,
      },
    );
    expect(sent).toEqual([[join(root, 'footage/IMG_2003.jpg')]]);
  });
});

describe('frames a model is asked about', () => {
  it('are never written where prepare numbered its own', async () => {
    // Prepare names frames by index; a moment at 1000 ms written as
    // `00001000.jpg` beside them was prepare's frame 1000, the picture at 999 s.
    const record = seen();
    await observe([asset({ audio_streams: [] })], madeFrames, record);
    const framesDir = record.visual[0]?.frames_dir;
    expect(framesDir).toBeDefined();
    expect(framesDir).not.toBe(join(root, 'work', 'b'.repeat(12), 'frames-1fps'));
    expect(framesDir).not.toBe(record.ocr[0]?.frames_dir);
  });
});

describe('a one-shot screen recording', () => {
  it('has every slide read, and each read ends when its slide does', async () => {
    // The probe recording: six slides, one shot, still between the cursor's
    // moves. It was read once, at 20 s.
    const record = seen();
    const base = suite(undefined, record);
    const recording = asset({ duration_ms: 60_000, audio_streams: [] });
    const result = await observeAssets([recording], {
      projectRoot: root,
      workDir: join(root, 'work-screen'),
      runs: new ModelRunRecorder(() => '2026-09-01T00:00:00.000Z'),
      suite: {
        ...base,
        shots: {
          identity: identity('fake-shots'),
          detectShots: async () => ({
            shots: [{ start_ms: 0, end_ms: 60_000, representative_frame_ms: 20_000 }],
          }),
        },
        video: {
          identity: identity('fake-motion'),
          analyzeVideo: async () => ({
            model: 'fake',
            hop_ms: 200,
            motion: [],
            luma: [],
            events: [0, 1, 2, 3, 4, 5].map((i) => ({
              start_ms: i * 10_000 + 2200,
              end_ms: (i + 1) * 10_000,
              event_type: 'static' as const,
              confidence: 0.9,
            })),
          }),
        },
        ocr: {
          identity: identity('fake-ocr'),
          ocr: async (params: OcrParams) => {
            record.ocr.push(params);
            return {
              observations: params.timestamps_ms.map((t) => ({
                start_ms: t,
                end_ms: t + 1000,
                text: `slide ${Math.floor(t / 10_000) + 1}`,
                confidence: 0.9,
              })),
            };
          },
        },
      },
    });
    expect(record.ocr[0]?.timestamps_ms).toEqual([
      9500, 19_500, 20_000, 29_500, 39_500, 49_500, 59_500,
    ]);
    expect(new Set(result.observations.ocr.map((o) => o.text)).size).toBe(6);
    const beforeChange = result.observations.ocr.find((o) => o.start_ms === 9500);
    expect(beforeChange?.end_ms).toBe(10_000);
  });
});

describe('sound measured past the end of its file', () => {
  it('is held to the file, as shots and picture events are', async () => {
    // The loudness analyser counts whole hops of the decoded stream, which runs
    // a little longer than the container says: every probe file's last silence
    // ended 100 ms after the file did, and one that starts at the end is not in
    // the file at all.
    const record = seen();
    const base = suite(undefined, record);
    const result = await observeAssets([asset({ duration_ms: 10_000 })], {
      projectRoot: root,
      workDir: join(root, 'work'),
      runs: new ModelRunRecorder(() => '2026-09-01T00:00:00.000Z'),
      suite: {
        ...base,
        audio: {
          identity: identity('fake-audio'),
          analyzeAudio: async () => ({
            hop_ms: 100,
            rms_db: [],
            events: [
              { start_ms: 0, end_ms: 8000, event_type: 'speech' as const, confidence: 0.9 },
              { start_ms: 8000, end_ms: 10_100, event_type: 'silence' as const, confidence: 0.9 },
              { start_ms: 10_000, end_ms: 10_100, event_type: 'noise' as const, confidence: 0.9 },
            ],
          }),
        },
      },
    });
    expect(result.observations.audio_events.map((e) => [e.start_ms, e.end_ms])).toEqual([
      [0, 8000],
      [8000, 10_000],
    ]);
  });
});
