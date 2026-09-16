import { z } from 'zod';
import { Confidence, Milliseconds, UnitScore, obj } from './primitives.js';
import { Affect } from './event.js';
import { AudioEventType } from './observation.js';
import { PERCEPTION_PROTOCOL_VERSION } from './version.js';

/**
 * The TypeScript ↔ Python boundary.
 *
 * TypeScript owns the contract; Python implements it. Python's internal types
 * never leak across, and the transport — JSON Lines over a subprocess today,
 * HTTP or a queue later — is not part of the architecture. This file is the only
 * thing both sides have to agree on.
 *
 * One request and one response per line on stdout, correlated by `id`. Stderr is
 * for logs only, so a chatty dependency can never corrupt the stream.
 */

export const PerceptionOp = z
  .enum([
    'health',
    'probe',
    'prepare',
    'transcribe',
    'detect_shots',
    'embed_frames',
    'analyze_audio',
    'ocr',
    'describe',
    'embed_text',
    'shutdown',
  ])
  .meta({ id: 'PerceptionOp' });
export type PerceptionOp = z.infer<typeof PerceptionOp>;

/* --- requests ------------------------------------------------------------- */

const base = { id: z.string().min(1), v: z.string().default(PERCEPTION_PROTOCOL_VERSION) };

export const HealthParams = obj({}).meta({ id: 'HealthParams' });
export type HealthParams = z.infer<typeof HealthParams>;

export const ProbeParams = obj({ path: z.string().min(1) }).meta({ id: 'ProbeParams' });
export type ProbeParams = z.infer<typeof ProbeParams>;

export const PrepareParams = obj({
  path: z.string().min(1),
  /** Directory the worker may write derivatives into. */
  work_dir: z.string().min(1),
  /** Long edge of the proxy in pixels. */
  proxy_height: z.int().min(0).default(480),
  extract_audio: z.boolean().default(true),
  /** Frames per second to sample for visual analysis. 0 disables frame sampling. */
  frame_fps: z.number().min(0).default(1),
}).meta({ id: 'PrepareParams' });
export type PrepareParams = z.infer<typeof PrepareParams>;

export const TranscribeParams = obj({
  audio_path: z.string().min(1),
  /** BCP-47 tag, or omitted for auto-detection. */
  language: z.string().optional(),
  /** Domain words to bias the decoder toward. */
  vocabulary: z.array(z.string()).default([]),
  word_timestamps: z.boolean().default(true),
  diarize: z.boolean().default(false),
}).meta({ id: 'TranscribeParams' });
export type TranscribeParams = z.infer<typeof TranscribeParams>;

export const DetectShotsParams = obj({
  path: z.string().min(1),
  /** Content-change threshold in [0,1]. Higher means fewer boundaries. */
  threshold: z.number().min(0).max(1).default(0.3),
  min_shot_ms: Milliseconds.default(800),
}).meta({ id: 'DetectShotsParams' });
export type DetectShotsParams = z.infer<typeof DetectShotsParams>;

export const EmbedFramesParams = obj({
  path: z.string().min(1),
  timestamps_ms: z.array(Milliseconds).min(1),
  /** Candidate labels for zero-shot tagging. Empty means embeddings only. */
  label_vocabulary: z.array(z.string()).default([]),
}).meta({ id: 'EmbedFramesParams' });
export type EmbedFramesParams = z.infer<typeof EmbedFramesParams>;

export const AnalyzeAudioParams = obj({
  audio_path: z.string().min(1),
  hop_ms: z.int().min(1).default(100),
  /** Level below which a hop counts as silent. */
  silence_threshold_db: z.number().default(-40),
  /** Classify laughter, applause, music and so on. Needs a tagging model. */
  classify_events: z.boolean().default(true),
}).meta({ id: 'AnalyzeAudioParams' });
export type AnalyzeAudioParams = z.infer<typeof AnalyzeAudioParams>;

export const OcrParams = obj({
  path: z.string().min(1),
  timestamps_ms: z.array(Milliseconds).min(1),
  language: z.string().optional(),
}).meta({ id: 'OcrParams' });
export type OcrParams = z.infer<typeof OcrParams>;

/** The one genuinely expensive call: a multimodal look at a single event. */
export const DescribeParams = obj({
  event_id: z.string(),
  /** Frame timestamps to look at, already chosen by the caller. */
  frame_paths: z.array(z.string()).default([]),
  transcript: z.array(z.string()).default([]),
  ocr: z.array(z.string()).default([]),
  audio_tags: z.array(z.string()).default([]),
  /** Labels a vision model attached to the sampled frames, when there was one. */
  visual_labels: z.array(z.string()).default([]),
  previous_summary: z.string().optional(),
  next_summary: z.string().optional(),
  /** User background, verbatim. The worker may use it but must not contradict it. */
  user_context: z.record(z.string(), z.unknown()).default({}),
  language: z.string().optional(),
}).meta({ id: 'DescribeParams' });
export type DescribeParams = z.infer<typeof DescribeParams>;

export const EmbedTextParams = obj({
  texts: z.array(z.string()).min(1),
  /** `query` and `passage` may be encoded differently by asymmetric models. */
  role: z.enum(['query', 'passage']).default('passage'),
}).meta({ id: 'EmbedTextParams' });
export type EmbedTextParams = z.infer<typeof EmbedTextParams>;

export const PerceptionRequest = z
  .discriminatedUnion('op', [
    obj({ ...base, op: z.literal('health'), params: HealthParams.default({}) }),
    obj({ ...base, op: z.literal('probe'), params: ProbeParams }),
    obj({ ...base, op: z.literal('prepare'), params: PrepareParams }),
    obj({ ...base, op: z.literal('transcribe'), params: TranscribeParams }),
    obj({ ...base, op: z.literal('detect_shots'), params: DetectShotsParams }),
    obj({ ...base, op: z.literal('embed_frames'), params: EmbedFramesParams }),
    obj({ ...base, op: z.literal('analyze_audio'), params: AnalyzeAudioParams }),
    obj({ ...base, op: z.literal('ocr'), params: OcrParams }),
    obj({ ...base, op: z.literal('describe'), params: DescribeParams }),
    obj({ ...base, op: z.literal('embed_text'), params: EmbedTextParams }),
    obj({ ...base, op: z.literal('shutdown'), params: obj({}).default({}) }),
  ])
  .meta({ id: 'PerceptionRequest', title: 'PerceptionRequest' });
export type PerceptionRequest = z.infer<typeof PerceptionRequest>;

/* --- results -------------------------------------------------------------- */

export const HealthResult = obj({
  protocol_version: z.string(),
  worker_version: z.string(),
  python_version: z.string().optional(),
  /** Which capabilities have their dependencies installed. */
  capabilities: z.record(z.string(), z.boolean()).default({}),
  /** `cuda`, `mps`, `cpu`. */
  device: z.string().default('cpu'),
  vram_total_mb: z.int().min(0).optional(),
  ffmpeg_available: z.boolean().default(false),
}).meta({ id: 'HealthResult' });
export type HealthResult = z.infer<typeof HealthResult>;

export const ProbeResult = obj({
  duration_ms: Milliseconds,
  width: z.int().min(0).optional(),
  height: z.int().min(0).optional(),
  fps_num: z.int().min(0).optional(),
  fps_den: z.int().min(1).optional(),
  video_codec: z.string().optional(),
  audio_codec: z.string().optional(),
  audio_channels: z.int().min(0).optional(),
  audio_sample_rate: z.int().min(0).optional(),
  container: z.string().optional(),
  bit_rate: z.int().min(0).optional(),
  rotation: z.int().optional(),
  creation_time: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).meta({ id: 'ProbeResult' });
export type ProbeResult = z.infer<typeof ProbeResult>;

export const PrepareResult = obj({
  proxy_path: z.string().optional(),
  audio_path: z.string().optional(),
  frames_dir: z.string().optional(),
  frame_timestamps_ms: z.array(Milliseconds).default([]),
}).meta({ id: 'PrepareResult' });
export type PrepareResult = z.infer<typeof PrepareResult>;

export const TranscribeResult = obj({
  language: z.string().optional(),
  model: z.string().optional(),
  utterances: z
    .array(
      obj({
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        text: z.string(),
        speaker_id: z.string().optional(),
        confidence: Confidence.default(0.5),
        words: z
          .array(obj({ start_ms: Milliseconds, end_ms: Milliseconds, text: z.string(), confidence: Confidence.optional() }))
          .optional(),
      }),
    )
    .default([]),
}).meta({ id: 'TranscribeResult' });
export type TranscribeResult = z.infer<typeof TranscribeResult>;

export const DetectShotsResult = obj({
  model: z.string().optional(),
  shots: z
    .array(
      obj({
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        representative_frame_ms: Milliseconds,
        change_score: z.number().min(0).max(1).optional(),
      }),
    )
    .default([]),
}).meta({ id: 'DetectShotsResult' });
export type DetectShotsResult = z.infer<typeof DetectShotsResult>;

export const EmbedFramesResult = obj({
  model: z.string().optional(),
  dim: z.int().min(1),
  frames: z
    .array(
      obj({
        timestamp_ms: Milliseconds,
        vector: z.array(z.number()),
        labels: z.array(z.string()).default([]),
        sharpness: UnitScore.optional(),
        exposure: UnitScore.optional(),
        motion: UnitScore.optional(),
      }),
    )
    .default([]),
}).meta({ id: 'EmbedFramesResult' });
export type EmbedFramesResult = z.infer<typeof EmbedFramesResult>;

export const AnalyzeAudioResult = obj({
  model: z.string().optional(),
  hop_ms: z.int().min(1),
  rms_db: z.array(z.number()).default([]),
  speech_prob: z.array(UnitScore).optional(),
  events: z
    .array(
      obj({
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        event_type: AudioEventType,
        raw_label: z.string().optional(),
        confidence: Confidence.default(0.5),
      }),
    )
    .default([]),
}).meta({ id: 'AnalyzeAudioResult' });
export type AnalyzeAudioResult = z.infer<typeof AnalyzeAudioResult>;

export const OcrResult = obj({
  model: z.string().optional(),
  observations: z
    .array(
      obj({
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        text: z.string(),
        confidence: Confidence.default(0.5),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
      }),
    )
    .default([]),
}).meta({ id: 'OcrResult' });
export type OcrResult = z.infer<typeof OcrResult>;

/**
 * The VLM's answer about one event.
 *
 * Note that this is *not* Editorial IR. It is model output that still has to be
 * validated, given provenance and merged with user knowledge before it becomes
 * part of the canonical representation.
 */
export const DescribeResult = obj({
  model: z.string().optional(),
  description: z.string(),
  event_type: z.string().default(''),
  title: z.string().optional(),
  entities: obj({
    people: z.array(z.string()).default([]),
    places: z.array(z.string()).default([]),
    objects: z.array(z.string()).default([]),
    topics: z.array(z.string()).default([]),
  }).prefault({}),
  affect: Affect.default({}),
  confidence: Confidence.default(0.5),
  input_tokens: z.int().min(0).optional(),
  output_tokens: z.int().min(0).optional(),
}).meta({ id: 'DescribeResult' });
export type DescribeResult = z.infer<typeof DescribeResult>;

export const EmbedTextResult = obj({
  model: z.string().optional(),
  dim: z.int().min(1),
  vectors: z.array(z.array(z.number())).default([]),
}).meta({ id: 'EmbedTextResult' });
export type EmbedTextResult = z.infer<typeof EmbedTextResult>;

/* --- envelope ------------------------------------------------------------- */

export const PerceptionErrorCode = z
  .enum([
    'bad_request',
    'unsupported_op',
    'missing_dependency',
    'media_error',
    'model_error',
    'out_of_memory',
    'cancelled',
    'internal',
  ])
  .meta({ id: 'PerceptionErrorCode' });
export type PerceptionErrorCode = z.infer<typeof PerceptionErrorCode>;

export const PerceptionResponse = z
  .discriminatedUnion('ok', [
    obj({ v: z.string(), id: z.string(), ok: z.literal(true), op: PerceptionOp, result: z.unknown() }),
    obj({
      v: z.string(),
      id: z.string(),
      ok: z.literal(false),
      op: PerceptionOp.optional(),
      error: obj({
        code: PerceptionErrorCode,
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
  ])
  .meta({ id: 'PerceptionResponse', title: 'PerceptionResponse' });
export type PerceptionResponse = z.infer<typeof PerceptionResponse>;

/** Out-of-band progress on a long call. Never a reply; the reply still follows. */
export const PerceptionEvent = obj({
  v: z.string(),
  id: z.string(),
  event: z.enum(['progress', 'log']),
  progress: UnitScore.optional(),
  message: z.string().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
}).meta({ id: 'PerceptionEvent' });
export type PerceptionEvent = z.infer<typeof PerceptionEvent>;

/** Maps each op to the schema of its successful result. */
export const PERCEPTION_RESULT_SCHEMAS = {
  health: HealthResult,
  probe: ProbeResult,
  prepare: PrepareResult,
  transcribe: TranscribeResult,
  detect_shots: DetectShotsResult,
  embed_frames: EmbedFramesResult,
  analyze_audio: AnalyzeAudioResult,
  ocr: OcrResult,
  describe: DescribeResult,
  embed_text: EmbedTextResult,
  shutdown: obj({}),
} as const;

export type PerceptionResultMap = {
  health: HealthResult;
  probe: ProbeResult;
  prepare: PrepareResult;
  transcribe: TranscribeResult;
  detect_shots: DetectShotsResult;
  embed_frames: EmbedFramesResult;
  analyze_audio: AnalyzeAudioResult;
  ocr: OcrResult;
  describe: DescribeResult;
  embed_text: EmbedTextResult;
  shutdown: Record<string, never>;
};
