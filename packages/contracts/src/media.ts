import { z } from 'zod';
import { Iso8601, Milliseconds, Sha256, obj } from './primitives.js';
import { AssetId } from './ids.js';

export const MediaKind = z.enum(['video', 'audio', 'image']).meta({ id: 'MediaKind' });
export type MediaKind = z.infer<typeof MediaKind>;

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
  /** Capture time from container metadata, used to lay assets on the capture timeline. */
  creation_time: Iso8601.optional(),
  /** Container/stream metadata that no contract field claims. Free-form by design. */
  metadata: z.record(z.string(), z.unknown()).default({}),
}).meta({ id: 'MediaAsset', title: 'MediaAsset' });
export type MediaAsset = z.infer<typeof MediaAsset>;

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
  ordered_by: z.enum(['creation_time', 'file_name', 'explicit']),
}).meta({ id: 'AssetPlacement' });
export type AssetPlacement = z.infer<typeof AssetPlacement>;

/** Gap inserted between consecutive assets on the capture timeline. */
export const CAPTURE_TIMELINE_GAP_MS = 1000;
