import { z } from 'zod';
import { Confidence, Iso8601, Milliseconds, Sha256, obj } from './primitives.js';
import { AssetId } from './ids.js';

export const MediaKind = z.enum(['video', 'audio', 'image']).meta({ id: 'MediaKind' });
export type MediaKind = z.infer<typeof MediaKind>;

/** One audio stream inside a file, as the container reports it. */
export const AudioStream = obj({
  /** The container's stream index, as ffmpeg's `-map 0:<index>` means it. */
  index: z.int().min(0),
  codec: z.string().optional(),
  channels: z.int().min(0).optional(),
  sample_rate: z.int().min(0).optional(),
  language: z.string().optional(),
  title: z.string().optional(),
}).meta({ id: 'AudioStream' });
export type AudioStream = z.infer<typeof AudioStream>;

/**
 * A registered source file.
 *
 * The original file is never modified and never moved. `path` is stored relative
 * to the project root when the media lives inside the project, so that a project
 * directory can be copied to another machine and still resolve.
 */
export const MediaAsset = obj({
  id: AssetId,
  /** Path relative to the project root, or an absolute path for external media. */
  path: z.string().min(1),
  /** Original file name, kept for display even if `path` is rewritten. */
  file_name: z.string().min(1),
  kind: MediaKind,
  sha256: Sha256,
  byte_size: z.int().min(0),
  duration_ms: Milliseconds,
  width: z.int().min(0).optional(),
  height: z.int().min(0).optional(),
  /** Frames per second as a float. `fps_num`/`fps_den` keeps the exact rational. */
  fps: z.number().min(0).optional(),
  fps_num: z.int().min(0).optional(),
  fps_den: z.int().min(1).optional(),
  video_codec: z.string().optional(),
  audio_codec: z.string().optional(),
  audio_channels: z.int().min(0).optional(),
  audio_sample_rate: z.int().min(0).optional(),
  container: z.string().optional(),
  bit_rate: z.int().min(0).optional(),
  /** Display rotation in degrees from container metadata (0/90/180/270). */
  rotation: z.int().optional(),
  /**
   * Every audio stream, when there is more than one.
   *
   * Absent for the ordinary single-stream file. Present, the question of which
   * one to listen to is real: a camera with a lavalier on its second track holds
   * room tone on its first, and analysing stream 0 regardless transcribed the
   * room.
   */
  audio_streams: z.array(AudioStream).optional(),
  /**
   * The frame rate varies across the file, as phone footage routinely does.
   *
   * An NLE conforms such a file to a constant rate on import and a timecode
   * computed from the nominal rate drifts against it — by the end of a long clip,
   * by more than a frame. Recorded so the proxy can be made constant-rate and so
   * the export can warn rather than silently drift.
   */
  variable_frame_rate: z.boolean().optional(),
  /** The measured average rate, when it differs from the nominal `fps`. */
  avg_fps: z.number().min(0).optional(),
  /** Capture time from container metadata, used to lay assets on the capture timeline. */
  creation_time: Iso8601.optional(),
  /** Container/stream metadata that no contract field claims. Free-form by design. */
  metadata: z.record(z.string(), z.unknown()).default({}),
}).meta({ id: 'MediaAsset', title: 'MediaAsset' });
export type MediaAsset = z.infer<typeof MediaAsset>;

/**
 * What kind of material a file is, because the same rules do not suit all of it.
 *
 * Measured with this project's own shot detector: edited programmes cut 5 to 16
 * times a minute with a median shot of 1.7 to 8.4 seconds; raw camera files cut
 * 0 to 0.8 times a minute, and the user's own 62 minutes of drone footage 0.23.
 * An edited video fed back in to be cut down needs its cuts respected, its burned
 * subtitles recognised as subtitles, and its music bed not mistaken for speech
 * with no pauses — none of which the raw-footage rules do.
 *
 * - `raw`: a camera recording, cut nowhere inside.
 * - `edited`: a finished or rough edit — cuts, often a music bed and titles.
 * - `clip`: a short piece the user already chose and trimmed.
 * - `screen_recording`: long still stretches that are not dead, heavy with text.
 * - `audio_only`, `still`: follow from the file itself.
 */
export const MaterialKind = z
  .enum(['raw', 'edited', 'clip', 'screen_recording', 'audio_only', 'still'])
  .meta({ id: 'MaterialKind' });
export type MaterialKind = z.infer<typeof MaterialKind>;

/**
 * The material kind decided for one asset, with what it was decided from.
 *
 * An inference, and marked as one, so that it is always overruled by the user's
 * own word in `background.materials` and never presented as a fact.
 */
export const MaterialProfile = obj({
  asset_id: AssetId,
  kind: MaterialKind,
  confidence: Confidence,
  provenance: z.enum(['inferred', 'user_provided']),
  /** Sentences a person can check: "14.2 cuts a minute", "no silence longer than 1 s". */
  evidence: z.array(z.string()).default([]),
  /** The numbers behind the evidence, for tools rather than people. */
  signals: z.record(z.string(), z.number()).default({}),
}).meta({ id: 'MaterialProfile' });
export type MaterialProfile = z.infer<typeof MaterialProfile>;

/**
 * Cheap derivatives produced at ingest. All are regenerable from the original,
 * so they are cache artefacts rather than project data.
 */
export const DerivedMedia = obj({
  asset_id: AssetId,
  /** Low-resolution video used for frame sampling and preview. */
  proxy_path: z.string().optional(),
  /** Mono 16 kHz WAV used by ASR and audio analysis. */
  audio_path: z.string().optional(),
  /** Directory of sampled JPEG frames, named `<timestamp_ms>.jpg`. */
  frames_dir: z.string().optional(),
  thumbnail_path: z.string().optional(),
}).meta({ id: 'DerivedMedia' });
export type DerivedMedia = z.infer<typeof DerivedMedia>;

/**
 * Where an asset sits on the project's *capture timeline*.
 *
 * Semantic events need a single ordered axis so that "previous event", "next
 * event" and chapters mean something across several files. That axis is the
 * capture timeline: assets laid end to end in capture order, with a fixed gap
 * between them. It is a coordinate system, not an edit — the EditPlan never
 * inherits this ordering.
 */
export const AssetPlacement = obj({
  asset_id: AssetId,
  /** Start of this asset on the capture timeline. */
  offset_ms: Milliseconds,
  /** Position in capture order, 0-based. */
  order: z.int().min(0),
  /** How the order was decided, for when metadata is missing or wrong. */
  ordered_by: z.enum(['creation_time', 'file_name', 'explicit', 'audio_sync']),
  /**
   * The audio match that placed this asset, when `ordered_by` is `audio_sync`.
   *
   * Two cameras on the same moment, or a camera and a separate recorder, often
   * carry no capture time that agrees — or none at all — and ordering them by
   * file name lays them end to end, as though the second angle happened after
   * the first. Their sound is the same sound, and cross-correlating it finds the
   * offset to the frame. The confidence is how far the best match stands above
   * the next best, so a weak match can be refused rather than trusted.
   */
  sync: obj({
    reference_asset_id: AssetId,
    /** Where this asset starts relative to the reference's start. May be negative. */
    offset_ms: z.int(),
    confidence: Confidence,
  }).optional(),
}).meta({ id: 'AssetPlacement' });
export type AssetPlacement = z.infer<typeof AssetPlacement>;

/** Gap inserted between consecutive assets on the capture timeline. */
export const CAPTURE_TIMELINE_GAP_MS = 1000;

/**
 * The room a still image takes on the capture timeline, and the length of the
 * one event it becomes.
 *
 * A photograph has no duration of its own — `MediaAsset.duration_ms` stays 0,
 * because that is what the file is — but an event needs a start and an end, and
 * with neither every still in a folder was dropped before the first event was
 * built: four photographs beside one video compiled to one event. Three seconds
 * is the length a still is commonly held for on screen; it is a slot on a
 * coordinate system, not a cut, and the planner may hold a still for any length
 * it likes.
 */
export const STILL_SLOT_MS = 3000;
