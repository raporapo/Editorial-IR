import { z } from 'zod';
import { Confidence, Milliseconds, obj } from './primitives.js';
import {
  AssetId,
  AudioEventId,
  FrameId,
  ModelRunId,
  OcrId,
  ShotId,
  UtteranceId,
  VideoEventId,
} from './ids.js';
import { ModelRun } from './model-run.js';

/**
 * The observation layer records what was seen and heard, and nothing else.
 *
 * Nothing here may contain an interpretation. "laughter at 551120ms" belongs
 * here; "this is the emotional payoff of the trip" does not.
 */

export const Utterance = obj({
  id: UtteranceId,
  asset_id: AssetId,
  start_ms: Milliseconds,
  end_ms: Milliseconds,
  /** Diarisation label, stable within an asset only. */
  speaker_id: z.string().optional(),
  text: z.string(),
  language: z.string().optional(),
  confidence: Confidence,
  /** Word-level timing, when the backend provides it. Enables cutting on word boundaries. */
  words: z
    .array(
      obj({
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        text: z.string(),
        confidence: Confidence.optional(),
      }),
    )
    .optional(),
  model_run_id: ModelRunId.optional(),
}).meta({ id: 'Utterance' });
export type Utterance = z.infer<typeof Utterance>;

export const Shot = obj({
  id: ShotId,
  asset_id: AssetId,
  start_ms: Milliseconds,
  end_ms: Milliseconds,
  /** The frame that best represents the shot; used for embeddings and thumbnails. */
  representative_frame_ms: Milliseconds,
  /** Strength of the boundary that opened this shot, in [0,1]. */
  change_score: z.number().min(0).max(1).optional(),
  model_run_id: ModelRunId.optional(),
}).meta({ id: 'Shot' });
export type Shot = z.infer<typeof Shot>;

/**
 * Audio event vocabulary.
 *
 * Deliberately small and closed: an open vocabulary here would let a backend
 * invent tags that no Skill can ever match. Backends map their own labels onto
 * these, and put the original label in `raw_label`.
 */
export const AudioEventType = z
  .enum([
    'speech',
    'silence',
    'music',
    'laughter',
    'applause',
    'cheering',
    'crowd',
    'traffic',
    'nature',
    'noise',
    'other',
  ])
  .meta({ id: 'AudioEventType' });
export type AudioEventType = z.infer<typeof AudioEventType>;

export const AudioEvent = obj({
  id: AudioEventId,
  asset_id: AssetId,
  start_ms: Milliseconds,
  end_ms: Milliseconds,
  event_type: AudioEventType,
  raw_label: z.string().optional(),
  confidence: Confidence,
  model_run_id: ModelRunId.optional(),
}).meta({ id: 'AudioEvent' });
export type AudioEvent = z.infer<typeof AudioEvent>;

export const OcrObservation = obj({
  id: OcrId,
  asset_id: AssetId,
  start_ms: Milliseconds,
  end_ms: Milliseconds,
  text: z.string().min(1),
  confidence: Confidence,
  /** Normalised bounding box in [0,1]: [x, y, w, h]. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  model_run_id: ModelRunId.optional(),
}).meta({ id: 'OcrObservation' });
export type OcrObservation = z.infer<typeof OcrObservation>;

export const FrameFeature = obj({
  id: FrameId,
  asset_id: AssetId,
  timestamp_ms: Milliseconds,
  /** Open-vocabulary tags such as `two_people`, `theme_park_gate`. */
  labels: z.array(z.string()).default([]),
  /** Technical quality in [0,1]; used to prefer one redundant take over another. */
  sharpness: z.number().min(0).max(1).optional(),
  exposure: z.number().min(0).max(1).optional(),
  /** Camera motion magnitude in [0,1]. High values suggest a whip pan, not a usable frame. */
  motion: z.number().min(0).max(1).optional(),
  /** Points at a vector in the sidecar vector store; the vector itself is never inlined here. */
  embedding_ref: z.string().optional(),
  model_run_id: ModelRunId.optional(),
}).meta({ id: 'FrameFeature' });
export type FrameFeature = z.infer<typeof FrameFeature>;

/**
 * A regularly sampled audio envelope for one asset.
 *
 * Stored as parallel arrays rather than objects because a 1-hour asset at a
 * 100 ms hop is 36 000 samples: an array of objects would dominate the file.
 * It is what lets the planner snap a cut to a silence instead of to the middle
 * of a word.
 */
export const AudioProfile = obj({
  asset_id: AssetId,
  hop_ms: z.int().min(1),
  /** RMS level in dBFS per hop. */
  rms_db: z.array(z.number()),
  /** Probability that speech is present, per hop. */
  speech_prob: z.array(z.number().min(0).max(1)).optional(),
  /**
   * Which audio stream of the file this profile describes, when it has several.
   *
   * A camera with a lavalier on its second track records room tone on the first,
   * and everything downstream — transcript, silences, cut points — was built from
   * stream 0 whatever it held. Recorded here so the choice is visible and so a
   * cache entry for one stream is never served for another.
   */
  stream_index: z.int().min(0).optional(),
  /** Why that stream, in words: "the only one", "most speech of 2", "chosen by the user". */
  stream_reason: z.string().optional(),
  model_run_id: ModelRunId.optional(),
}).meta({ id: 'AudioProfile' });
export type AudioProfile = z.infer<typeof AudioProfile>;

/**
 * What the picture was doing, as closed as the audio vocabulary and for the same
 * reason: a Skill can only match a word it can know in advance.
 *
 * - `static`: nothing in any part of the frame changed by more than the noise
 *   floor for a sustained stretch. A tripod on an empty car park, a camera left
 *   running on a table, a screen recording nobody is touching.
 * - `black`: the frame is dark, as a title card, a lens cap or a pocket is.
 *
 * Deliberately not "boring" or "dead": those are judgements. Whether a still,
 * silent stretch is worth anything is the decision layer's business; this only
 * says it was still and, separately, whether it was silent.
 */
export const VideoEventType = z.enum(['static', 'black']).meta({ id: 'VideoEventType' });
export type VideoEventType = z.infer<typeof VideoEventType>;

export const VideoEvent = obj({
  id: VideoEventId,
  asset_id: AssetId,
  start_ms: Milliseconds,
  end_ms: Milliseconds,
  event_type: VideoEventType,
  confidence: Confidence,
  model_run_id: ModelRunId.optional(),
}).meta({ id: 'VideoEvent' });
export type VideoEvent = z.infer<typeof VideoEvent>;

/**
 * A regularly sampled picture envelope for one asset, the visual twin of
 * `AudioProfile`: parallel arrays, because an hour at 200 ms is 18 000 samples.
 *
 * `motion` is measured on a 64x36 greyscale downscale, as the largest mean
 * absolute difference of any cell of a 3x4 grid between consecutive samples, in
 * grey levels. Both choices are measured rather than chosen:
 *
 * - Downscaling first is what separates noise from motion. Sensor grain is
 *   independent per pixel and averages out over a 30x30 block; a person walking
 *   does not. At full resolution a static shot with heavy grain differs by 6
 *   grey levels frame to frame, more than a moving camera does; at 64x36 the
 *   same shot sits at 0.14 and an empty street at 0.3.
 * - The maximum over cells rather than the frame mean is what keeps a person
 *   crossing one corner of a wide static shot counted as motion.
 */
export const MotionProfile = obj({
  asset_id: AssetId,
  hop_ms: z.int().min(1),
  /** Largest per-cell mean absolute difference from the previous sample, 0-255. */
  motion: z.array(z.number().min(0)),
  /** Mean luma per sample, 0-255. */
  luma: z.array(z.number().min(0).max(255)),
  model_run_id: ModelRunId.optional(),
}).meta({ id: 'MotionProfile' });
export type MotionProfile = z.infer<typeof MotionProfile>;

/**
 * Where two recordings of the same moment line up, measured from their sound.
 *
 * `offset_ms` is where this asset's time zero falls in the reference's time:
 * a recorder started 3.2 s after the camera has +3200. An observation, not a
 * placement: what it is used for — the recorder's sound under the camera's
 * picture, its transcript for the camera's events — is decided later.
 */
export const AudioSync = obj({
  asset_id: AssetId,
  reference_asset_id: AssetId,
  offset_ms: z.int(),
  /** How far the best alignment stood above the best rival: 1.5 and up is believed. */
  score: z.number().min(0),
  confidence: Confidence,
  /** `onset_xcorr` when measured; `user` when written in context.yaml. */
  method: z.enum(['onset_xcorr', 'user']).default('onset_xcorr'),
}).meta({ id: 'AudioSync' });
export type AudioSync = z.infer<typeof AudioSync>;

/**
 * Everything observed about every asset in a project, before any interpretation.
 *
 * This is a cache artefact keyed by media hash and model identity: it survives a
 * change to the user's background, to the Skill or to the target duration, and
 * is only recomputed when the media or a perception model changes.
 */
export const ObservationTimeline = obj({
  project_id: z.string(),
  pipeline_version: z.string(),
  generated_at: z.string(),
  /**
   * Hash over the media and the models that produced this.
   *
   * Compared on the next run to decide whether perception has to happen again.
   * Adding a sentence to the project background must not re-transcribe an hour
   * of audio, and this is the field that makes that checkable rather than
   * assumed.
   */
  fingerprint: z.string().default(''),
  utterances: z.array(Utterance).default([]),
  shots: z.array(Shot).default([]),
  audio_events: z.array(AudioEvent).default([]),
  ocr: z.array(OcrObservation).default([]),
  frame_features: z.array(FrameFeature).default([]),
  audio_profiles: z.array(AudioProfile).default([]),
  video_events: z.array(VideoEvent).default([]),
  motion_profiles: z.array(MotionProfile).default([]),
  /** Recordings found to hear the same moment, and by how much they are apart. */
  syncs: z.array(AudioSync).default([]),
  /**
   * The runs that produced everything above.
   *
   * Every observation names the run it came from, and the runs themselves lived
   * only in the IR of the compile that made them. Reusing an observation set —
   * which is the normal path, and the one `oea annotate` tells you to take —
   * therefore produced an IR whose utterances, shots and frames all pointed at
   * model runs that were not in it: the provenance trail led nowhere, and the
   * privacy report lost every perception model that had touched the media.
   */
  model_runs: z.array(ModelRun).default([]),
  /**
   * Assets a stage could not read while producing this, and why.
   *
   * An incomplete observation set was stored looking exactly like a complete
   * one: `oea analyze` said "could not read: speech on asset_002", wrote the
   * file anyway, and the next run matched its fingerprint — which is computed
   * from media hashes and model identities, not from what was actually
   * produced — and reported "perception was reused: nothing that affects it had
   * changed". The user fixed the cause and the missing eleven utterances never
   * came back.
   */
  failures: z
    .array(obj({ stage: z.string(), asset_id: z.string(), reason: z.string() }))
    .default([]),
}).meta({ id: 'ObservationTimeline', title: 'ObservationTimeline' });
export type ObservationTimeline = z.infer<typeof ObservationTimeline>;

export const EMPTY_OBSERVATIONS: Omit<
  ObservationTimeline,
  'project_id' | 'pipeline_version' | 'generated_at' | 'fingerprint'
> = {
  utterances: [],
  shots: [],
  audio_events: [],
  ocr: [],
  frame_features: [],
  audio_profiles: [],
  video_events: [],
  motion_profiles: [],
  syncs: [],
  model_runs: [],
  failures: [],
};
