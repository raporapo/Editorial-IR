import { z } from 'zod';
import { Confidence, Milliseconds, UnitScore, jsonOptional, obj } from './primitives.js';
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
    'analyze_video',
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
  /**
   * Which audio stream to extract, by position among the file's audio streams
   * (`-map 0:a:<index>`). Omitted: the preparer picks the one with the most
   * speech and says why in the result. Ignored when the file has one or none.
   */
  audio_stream_index: z.int().min(0).optional(),
  /**
   * Encode the proxy at a constant frame rate, the file's nominal one. On unless
   * this is `false`, because a variable-rate proxy makes "the frame at 12.4 s" a
   * different frame in every tool that decodes it, and every timestamp
   * downstream is taken from the proxy.
   */
  constant_frame_rate: z.boolean().optional(),
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
  /**
   * Which of the file's audio streams `audio_path` holds, when prepare chose one.
   *
   * No transcriber reads it. It is here because the cache key is built from the
   * parameters with every path left out, so without it a transcript of a
   * camera's room tone and a transcript of its lavalier were the same entry, and
   * whichever was made first was served for both.
   */
  audio_stream_index: z.int().min(0).optional(),
}).meta({ id: 'TranscribeParams' });
export type TranscribeParams = z.infer<typeof TranscribeParams>;

/**
 * How readily a change in the picture counts as a shot boundary.
 *
 * A *sensitivity*, not a raw metric value: each backend measures content change
 * on its own scale and converts this into it. Measured on 62 minutes of real
 * unedited camera footage, where every boundary found is by definition wrong —
 * see `detect_shots` in the Python worker for the table and the criterion.
 *
 * It lives here because it was written down in three places. The pipeline sent
 * 0.3 from `observe.ts`, the schema defaulted to 0.3, and the worker's own
 * default drifted to 0.15 without anything noticing — which is harmless only
 * for as long as the caller keeps passing one explicitly.
 */
export const SCENE_SENSITIVITY = 0.3;

/**
 * Below this, in grey levels, a 64x36 cell has not changed.
 *
 * Measured, on a still frame looped with synthetic sensor grain and on real
 * static-camera footage: grain of the kind a phone produces sits at 0.14-0.19,
 * an empty car park under a traffic camera at about 0.3, and anything actually
 * moving well above 0.5. At 0.75 people sitting still in conversation start to
 * count as static, and they are content. Extreme grain reads as motion (1.2),
 * which fails safe: it costs tokens, it never loses a moment.
 */
export const STATIC_MOTION_THRESHOLD = 0.5;

/** How long the picture has to hold still before it counts as a static span. */
export const STATIC_MIN_MS = 3000;

export const DetectShotsParams = obj({
  path: z.string().min(1),
  /** Content-change sensitivity in [0,1]. Higher means fewer boundaries. */
  threshold: z.number().min(0).max(1).default(SCENE_SENSITIVITY),
  min_shot_ms: Milliseconds.default(800),
}).meta({ id: 'DetectShotsParams' });
export type DetectShotsParams = z.infer<typeof DetectShotsParams>;

export const EmbedFramesParams = obj({
  path: z.string().min(1),
  timestamps_ms: z.array(Milliseconds).min(1),
  /** Candidate labels for zero-shot tagging. Empty means embeddings only. */
  label_vocabulary: z.array(z.string()).default([]),
  /**
   * Where to put the frames it has to extract to look at them.
   *
   * The same field `OcrParams` has, and for the same reason: the worker's guess
   * was "beside the file", and for an asset with no proxy that is the user's own
   * footage directory. `ocr` was fixed and this was missed, so the stage kept
   * writing a `_frames` folder into somebody's footage and leaving it there.
   */
  frames_dir: z.string().optional(),
}).meta({ id: 'EmbedFramesParams' });
export type EmbedFramesParams = z.infer<typeof EmbedFramesParams>;

export const AnalyzeAudioParams = obj({
  audio_path: z.string().min(1),
  hop_ms: z.int().min(1).default(100),
  /** Level below which a hop counts as silent. */
  silence_threshold_db: z.number().default(-40),
  /** Classify laughter, applause, music and so on. Needs a tagging model. */
  classify_events: z.boolean().default(true),
  /** Which audio stream `audio_path` holds; for the cache key, as in `TranscribeParams`. */
  audio_stream_index: z.int().min(0).optional(),
}).meta({ id: 'AnalyzeAudioParams' });
export type AnalyzeAudioParams = z.infer<typeof AnalyzeAudioParams>;

export const OcrParams = obj({
  path: z.string().min(1),
  timestamps_ms: z.array(Milliseconds).min(1),
  language: z.string().optional(),
  /**
   * Where to put the frames it has to extract to read them.
   *
   * The caller decides, because the worker's guess was "beside the file", and
   * for an asset with no proxy that is the user's own footage directory. The
   * first rule of ingest is that the original is never modified or moved;
   * filling the folder it sits in with a `_frames` directory is the same
   * promise broken more slowly.
   */
  frames_dir: z.string().optional(),
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

/** Which model's space a vector lands in. Not a preference — an address. */
export const EMBEDDING_SPACES = ['text', 'visual'] as const;
export type EmbeddingSpace = (typeof EMBEDDING_SPACES)[number];

/**
 * The picture's envelope: how much it moves and how bright it is, per sample.
 *
 * Cheap on purpose — a 64x36 greyscale decode of the proxy costs about 1% of
 * real time, measured on a five-minute 480p proxy — because it runs over every
 * second of every file, and its whole job is to decide where the expensive
 * stages need not look.
 */
export const AnalyzeVideoParams = obj({
  path: z.string().min(1),
  /** Samples per second. Five resolves a person crossing a frame. */
  sample_fps: z.number().gt(0).default(5),
  static_threshold: z.number().min(0).default(STATIC_MOTION_THRESHOLD),
  min_static_ms: Milliseconds.default(STATIC_MIN_MS),
  /**
   * A sample is black when nearly all of it — its 98th-percentile luma, 0-255 —
   * is below this. The mean would call a city at night black; the lit windows
   * keep the percentile up.
   */
  black_luma: z.number().min(0).max(255).default(24),
  min_black_ms: Milliseconds.default(500),
}).meta({ id: 'AnalyzeVideoParams' });
export type AnalyzeVideoParams = z.infer<typeof AnalyzeVideoParams>;

export const EmbedTextParams = obj({
  texts: z.array(z.string()).min(1),
  /** `query` and `passage` may be encoded differently by asymmetric models. */
  role: z.enum(['query', 'passage']).default('passage'),
  /**
   * `text` is the sentence encoder. `visual` is the vision model's own text
   * tower, which is the only thing that can put a query beside a frame.
   *
   * This exists because without it the visual stage was unusable in a way that
   * raised nothing. `embed_frames` wrote 512-wide CLIP vectors into the `visual`
   * aspect; a search encoded its query with the sentence encoder and arrived
   * 1024 wide; the index refused to compare them, correctly, and reported the
   * aspect unsearchable on every query. So every frame was embedded, at real
   * cost, and none of it could be asked anything — and the only visible symptom
   * was a diagnostic nobody was reading.
   *
   * A worker with no vision model, or one whose export has no text tower, says
   * so through the `embed_text_visual` capability rather than quietly answering
   * in the wrong space. That would be the "two embedding spaces in one index"
   * bug this project has already been bitten by once.
   */
  space: z.enum(EMBEDDING_SPACES).default('text'),
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
    obj({ ...base, op: z.literal('analyze_video'), params: AnalyzeVideoParams }),
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
  python_version: jsonOptional(z.string()),
  /** Which capabilities have their dependencies installed. */
  capabilities: z.record(z.string(), z.boolean()).default({}),
  /**
   * Where each stage would actually run, for the stages where that is a choice.
   *
   * The worker is not always the machine the work happens on: `describe` is an
   * HTTP call to whatever `OEA_VLM_BASE_URL` names, which may be a server in
   * another country. Only the worker knows that, and it was never asked — the
   * client recorded every worker-backed stage as `local`, so a run that posted
   * the user's transcripts and background to a hosted endpoint was written into
   * the IR as having stayed on the machine, and the privacy report said so.
   */
  stage_locality: z.record(z.string(), z.enum(['local', 'remote_api', 'unknown'])).default({}),
  /**
   * The model each stage would actually use, by the name that decides its output.
   *
   * Same reason as `stage_locality`: the worker reads `OEA_ASR_MODEL` and this
   * process does not. Every worker-backed stage reported a placeholder — `asr`,
   * `vlm`, `text-embedding` — and the perception cache keys on it, so a user who
   * was unhappy with a transcript, set `OEA_ASR_MODEL=large-v3` and re-ran was
   * served the small model's transcript, under a line saying the analysis had
   * been reused because nothing that affects it had changed. The IR said the
   * stage ran on a model called `asr`, which is not a model.
   */
  stage_models: z.record(z.string(), z.string()).default({}),
  /**
   * The natural language a stage can be *asked* in, where that is narrower than
   * what it can analyse.
   *
   * One stage needs this today and it is not a detail. A vision model's text
   * tower is the only thing that can encode a query into the same space as its
   * frame vectors, and CLIP's and SigLIP-base's towers are English-only:
   * measured, six frames against six English descriptions scored 6/6 top-1 and
   * the same six concepts in Japanese scored 4/6 with the margins at noise
   * level. A Japanese query against that tower does not fail — it returns a
   * confident ranking of noise, which is worse. The client reads this and
   * declines, falling back to the text index, which does read Japanese.
   */
  stage_query_languages: z.record(z.string(), z.string()).default({}),
  /** `cuda`, `mps`, `cpu`. */
  device: z.string().default('cpu'),
  vram_total_mb: jsonOptional(z.int().min(0)),
  ffmpeg_available: z.boolean().default(false),
}).meta({ id: 'HealthResult' });
export type HealthResult = z.infer<typeof HealthResult>;

/**
 * What a container says about a file, and nothing that needs decoding it.
 *
 * The picture fields describe the first *real* video stream. An MP3 or M4A with
 * album art carries the art as a one-frame video stream marked `attached_pic`,
 * and reading it as the picture recorded a podcast as 600x600 `mjpeg` video.
 * A still reports its size and no frame rate: ffmpeg's image reader invents 25
 * fps for every picture, and that 25 became the frame rate of a 30 fps project.
 */
export const ProbeResult = obj({
  duration_ms: Milliseconds,
  width: jsonOptional(z.int().min(0)),
  height: jsonOptional(z.int().min(0)),
  /**
   * The nominal rate (`r_frame_rate`): what the camera was set to, and what an
   * NLE conforms the file to. Not the measured average, which for a phone clip
   * that dropped frames is a rate nobody chose.
   */
  fps_num: jsonOptional(z.int().min(0)),
  fps_den: jsonOptional(z.int().min(1)),
  video_codec: jsonOptional(z.string()),
  audio_codec: jsonOptional(z.string()),
  audio_channels: jsonOptional(z.int().min(0)),
  audio_sample_rate: jsonOptional(z.int().min(0)),
  container: jsonOptional(z.string()),
  bit_rate: jsonOptional(z.int().min(0)),
  rotation: jsonOptional(z.int()),
  creation_time: jsonOptional(z.string()),
  /**
   * Every audio stream, in container order. Empty for a file with none, which
   * is how "no sound" is said rather than left to a missing `audio_codec`.
   * `index` is the position among audio streams, as `-map 0:a:<index>` means it.
   */
  audio_streams: jsonOptional(
    z.array(
      obj({
        index: z.int().min(0),
        codec: jsonOptional(z.string()),
        channels: jsonOptional(z.int().min(0)),
        sample_rate: jsonOptional(z.int().min(0)),
        language: jsonOptional(z.string()),
        title: jsonOptional(z.string()),
      }),
    ),
  ),
  /** `avg_frame_rate` as a rational, which differs from the nominal rate in a VFR file. */
  avg_fps_num: jsonOptional(z.int().min(0)),
  avg_fps_den: jsonOptional(z.int().min(1)),
  /**
   * Whether the frames actually in the file run at a rate other than the nominal
   * one, by more than 1%: frames counted over the stream's duration, against
   * `r_frame_rate`. Counted, because comparing the two declared rates is not
   * enough — a variable-rate WebM declares 30/1 for both with 132 frames in 8 s.
   */
  variable_frame_rate: jsonOptional(z.boolean()),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).meta({ id: 'ProbeResult' });
export type ProbeResult = z.infer<typeof ProbeResult>;

/** The derivatives prepare makes, each of which can fail without the others. */
export const PreparedDerivative = z.enum(['proxy', 'audio', 'frames']).meta({
  id: 'PreparedDerivative',
});
export type PreparedDerivative = z.infer<typeof PreparedDerivative>;

export const PrepareResult = obj({
  proxy_path: jsonOptional(z.string()),
  audio_path: jsonOptional(z.string()),
  frames_dir: jsonOptional(z.string()),
  frame_timestamps_ms: z.array(Milliseconds).default([]),
  /**
   * How many audio streams the file has. `0` means it has no sound: nothing to
   * transcribe and nothing to measure, and not a failure of anything.
   */
  audio_stream_count: jsonOptional(z.int().min(0)),
  /** The audio stream extracted, by position among audio streams, when there was any. */
  audio_stream_index: jsonOptional(z.int().min(0)),
  /** Why that one: "the only one", "most speech of 2 (0.61 vs 0.04)", "asked for". */
  audio_stream_reason: jsonOptional(z.string()),
  /**
   * Derivatives that could not be made, each on its own.
   *
   * They were one all-or-nothing call: audio was extracted before frames, so a
   * video with no audio track lost its frames to the audio step's error, and
   * everything the proxy had already produced went with them. Now each is tried
   * whatever happened to the others, and what failed is said here rather than
   * thrown.
   */
  failed: jsonOptional(z.array(obj({ derivative: PreparedDerivative, reason: z.string() }))),
}).meta({ id: 'PrepareResult' });
export type PrepareResult = z.infer<typeof PrepareResult>;

export const TranscribeResult = obj({
  language: jsonOptional(z.string()),
  model: jsonOptional(z.string()),
  utterances: z
    .array(
      obj({
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        text: z.string(),
        speaker_id: jsonOptional(z.string()),
        confidence: Confidence.default(0.5),
        words: z
          .array(
            obj({
              start_ms: Milliseconds,
              end_ms: Milliseconds,
              text: z.string(),
              confidence: jsonOptional(Confidence),
            }),
          )
          .optional(),
      }),
    )
    .default([]),
}).meta({ id: 'TranscribeResult' });
export type TranscribeResult = z.infer<typeof TranscribeResult>;

export const DetectShotsResult = obj({
  model: jsonOptional(z.string()),
  shots: z
    .array(
      obj({
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        representative_frame_ms: Milliseconds,
        change_score: jsonOptional(z.number().min(0).max(1)),
      }),
    )
    .default([]),
}).meta({ id: 'DetectShotsResult' });
export type DetectShotsResult = z.infer<typeof DetectShotsResult>;

export const EmbedFramesResult = obj({
  model: jsonOptional(z.string()),
  dim: z.int().min(1),
  frames: z
    .array(
      obj({
        timestamp_ms: Milliseconds,
        vector: z.array(z.number()),
        labels: z.array(z.string()).default([]),
        sharpness: jsonOptional(UnitScore),
        exposure: jsonOptional(UnitScore),
        motion: jsonOptional(UnitScore),
      }),
    )
    .default([]),
}).meta({ id: 'EmbedFramesResult' });
export type EmbedFramesResult = z.infer<typeof EmbedFramesResult>;

export const AnalyzeAudioResult = obj({
  model: jsonOptional(z.string()),
  hop_ms: z.int().min(1),
  rms_db: z.array(z.number()).default([]),
  speech_prob: jsonOptional(z.array(UnitScore)),
  events: z
    .array(
      obj({
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        event_type: AudioEventType,
        raw_label: jsonOptional(z.string()),
        confidence: Confidence.default(0.5),
      }),
    )
    .default([]),
}).meta({ id: 'AnalyzeAudioResult' });
export type AnalyzeAudioResult = z.infer<typeof AnalyzeAudioResult>;

export const OcrResult = obj({
  model: jsonOptional(z.string()),
  observations: z
    .array(
      obj({
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        text: z.string(),
        confidence: Confidence.default(0.5),
        bbox: jsonOptional(z.tuple([z.number(), z.number(), z.number(), z.number()])),
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
  model: jsonOptional(z.string()),
  description: z.string(),
  event_type: z.string().default(''),
  title: jsonOptional(z.string()),
  entities: obj({
    people: z.array(z.string()).default([]),
    places: z.array(z.string()).default([]),
    objects: z.array(z.string()).default([]),
    topics: z.array(z.string()).default([]),
  }).prefault({}),
  affect: Affect.default({}),
  confidence: Confidence.default(0.5),
  input_tokens: jsonOptional(z.int().min(0)),
  output_tokens: jsonOptional(z.int().min(0)),
}).meta({ id: 'DescribeResult' });
export type DescribeResult = z.infer<typeof DescribeResult>;

export const AnalyzeVideoResult = obj({
  hop_ms: z.int().min(1),
  motion: z.array(z.number().min(0)).default([]),
  luma: z.array(z.number().min(0).max(255)).default([]),
  events: z
    .array(
      obj({
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        event_type: z.enum(['static', 'black']),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  model: jsonOptional(z.string()),
}).meta({ id: 'AnalyzeVideoResult' });
export type AnalyzeVideoResult = z.infer<typeof AnalyzeVideoResult>;

export const EmbedTextResult = obj({
  model: jsonOptional(z.string()),
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
    // `op` on a reply is informational and deliberately a plain string: a peer
    // on a different version may name an operation this one has never heard of,
    // and a reply that cannot be parsed is a request that hangs forever.
    obj({
      v: z.string(),
      id: z.string(),
      ok: z.literal(true),
      op: z.string(),
      result: z.unknown(),
    }),
    obj({
      v: z.string(),
      id: z.string(),
      ok: z.literal(false),
      op: jsonOptional(z.string()),
      error: obj({
        code: PerceptionErrorCode,
        message: z.string(),
        details: jsonOptional(z.record(z.string(), z.unknown())),
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
  progress: jsonOptional(UnitScore),
  message: jsonOptional(z.string()),
  level: jsonOptional(z.enum(['debug', 'info', 'warn', 'error'])),
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
  analyze_video: AnalyzeVideoResult,
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
  analyze_video: AnalyzeVideoResult;
  ocr: OcrResult;
  describe: DescribeResult;
  embed_text: EmbedTextResult;
  shutdown: Record<string, never>;
};
