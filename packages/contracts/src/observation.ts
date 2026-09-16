import { z } from 'zod';
import { Confidence, Milliseconds, obj } from './primitives.js';
import { AssetId, AudioEventId, FrameId, ModelRunId, OcrId, ShotId, UtteranceId } from './ids.js';

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
  model_run_id: ModelRunId.optional(),
}).meta({ id: 'AudioProfile' });
export type AudioProfile = z.infer<typeof AudioProfile>;

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
};
