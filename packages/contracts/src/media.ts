import { z } from 'zod';
import { Confidence, Iso8601, Milliseconds, Sha256, obj } from './primitives.js';
import { AssetId } from './ids.js';

export const MediaKind = z.enum(['video', 'audio', 'image']).meta({ id: 'MediaKind' });
export type MediaKind = z.infer<typeof MediaKind>;

/** One audio stream inside a file, as the container reports it. */
export const AudioStream = obj({
  /**
   * Position among the file's *audio* streams, from 0: what ffmpeg's
   * `-map 0:a:<index>` means, and what an editor calls audio track 1, 2, 3.
   *
   * Not the container's own stream number. That one counts the picture, cover
   * art and timecode tracks as well, so the lavalier on a camera's second audio
   * track is stream 2 in one file and stream 3 in the next, and "the second audio
   * stream" is the only address that survives.
   */
  index: z.int().min(0),
  codec: z.string().optional(),
  channels: z.int().min(0).optional(),
  sample_rate: z.int().min(0).optional(),
  language: z.string().optional(),
  title: z.string().optional(),
}).meta({ id: 'AudioStream' });
export type AudioStream = z.infer<typeof AudioStream>;

/**
 * When a file says it was recorded, as precisely as it says it.
 *
 * Three different things arrive in the one field a container calls a date, and
 * each was taken for an instant in UTC:
 *
 * - a time with a zone (`2026-05-17T18:00:00+0900`), which is one;
 * - a time with none, as EXIF writes without `OffsetTimeOriginal` and a
 *   camcorder writes into an AVI, which is the wall clock where it was taken.
 *   Read as UTC it was up to fourteen hours out, and then compared with a
 *   phone's clip that did carry a zone as though both were UTC;
 * - a date with no time of day (`2026`, the `date` tag of an MP3), which is not
 *   a capture time at all. Read as midnight on New Year's Day, a podcast was
 *   laid on the capture timeline before a whole year of footage.
 *
 * The first is `creation_time` on the asset as well. The other two are kept
 * here, so they are known without being mistaken for something they are not.
 */
export const CaptureTime = obj({
  /**
   * Where it was read: `quicktime` is `com.apple.quicktime.creationdate`, which
   * carries the offset and survives an export that rewrites `creation_time`;
   * `container` is the container's own date tag; `exif` and `xmp` are read from
   * a photo, since ffprobe gives a JPEG no tags at all; `png` is a PNG's
   * `Creation Time` text.
   */
  source: z.enum(['quicktime', 'container', 'exif', 'xmp', 'png']),
  precision: z.enum(['instant', 'local', 'date']),
  /** The value as the file wrote it, for a person to check. */
  raw: z.string(),
  /**
   * The wall clock where it was taken, with no zone: `2026-05-17T18:00:00.000`.
   * Set for `local`, and for `instant` when the file wrote its offset — which
   * is what lets a phone clip that knows its zone be ordered against a camera
   * photo that does not, on the one clock they share.
   */
  local: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/)
    .optional(),
  /** Minutes east of UTC, when the file wrote an offset. */
  utc_offset_minutes: z.int().min(-720).max(840).optional(),
  /** `2026`, `2026-05` or `2026-05-17`, for `date`. */
  date: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .optional(),
}).meta({ id: 'CaptureTime' });
export type CaptureTime = z.infer<typeof CaptureTime>;

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
   * Every audio stream, in container order, as the probe listed them.
   *
   * Empty for a file with no sound at all — a drone clip, a timelapse, a muted
   * export — and that is the point of keeping it: "no audio" and "not probed"
   * are different, and only one of them is worth going back for. Absent on an
   * asset registered before streams were listed, where the first-stream fields
   * above are all there is.
   *
   * With more than one, which to listen to is a real question: a camera with a
   * lavalier on its second track holds room tone on its first, and analysing
   * whatever ffmpeg picked by default transcribed the room. Measured on such a
   * file: five spoken sentences, no utterances.
   */
  audio_streams: z.array(AudioStream).optional(),
  /**
   * The frame rate varies across the file, as phone footage routinely does.
   *
   * `fps` is then the *nominal* rate — the one the camera was set to and an NLE
   * conforms the file to — and not the measured average. The average of a phone
   * clip that dropped frames in low light was 22.75 fps for a 30 fps recording,
   * and taking it as the rate made the whole sequence 22.75 fps (Premiere: 23
   * NTSC). Recorded so the proxy can be made constant-rate and so the export can
   * warn rather than silently drift.
   */
  variable_frame_rate: z.boolean().optional(),
  /** The measured average rate, when the rate varies. */
  avg_fps: z.number().min(0).optional(),
  /**
   * When it was recorded, as an instant — only when the file said which zone.
   * Used to lay assets on the capture timeline. A time the file wrote with no
   * zone is not here but in `capture_time.local`, because reading it as UTC is
   * inventing an offset; see {@link CaptureTime}.
   */
  creation_time: Iso8601.optional(),
  /** Where the capture time came from and how precise it is. */
  capture_time: CaptureTime.optional(),
  /**
   * The timecode of the first frame, as SMPTE `HH:MM:SS:FF`, with `;` before
   * the frames for drop-frame (`01:00:00;00`). From the picture stream's tag,
   * a QuickTime timecode track, or the container (MXF, DV).
   *
   * A professional camera starts its clips at the time of day or wherever the
   * operator set it, and an EDL or FCPXML that places a clip at 00:00:00:00
   * against a source that starts at 01:00:00;00 relinks an hour away from the
   * picture — or not at all. Recorded as the file wrote it; frames are counted
   * at the asset's own rate.
   */
  start_timecode: z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2,3}$/, 'expected SMPTE timecode, like 01:00:00;00')
    .optional(),
  /** Container/stream metadata that no contract field claims. Free-form by design. */
  metadata: z.record(z.string(), z.unknown()).default({}),
}).meta({ id: 'MediaAsset', title: 'MediaAsset' });
export type MediaAsset = z.infer<typeof MediaAsset>;

/**
 * Whether there is any sound in the file to analyse.
 *
 * Asked of the stream list when there is one, and of the first-stream fields
 * for an asset registered before streams were listed. A still never has any.
 *
 * Every stage that reads audio asks this first, because a video with no audio
 * track used to go through all of them: extraction failed and took the frames
 * down with it, the loudness analyser was handed the .mp4 as a WAV, and the
 * transcriber crashed — three failures for an ordinary drone clip, and a stored
 * analysis that could never be reused because it had failures in it.
 */
export function hasAudioStream(
  asset: Pick<MediaAsset, 'kind' | 'audio_streams' | 'audio_codec' | 'audio_channels'>,
): boolean {
  if (asset.kind === 'image') return false;
  if (asset.audio_streams !== undefined) return asset.audio_streams.length > 0;
  return asset.audio_codec !== undefined || (asset.audio_channels ?? 0) > 0;
}

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
  /**
   * Directory of JPEG frames sampled at a fixed rate, named by 1-based *index*:
   * `00000001.jpg` is 0 ms. This said `<timestamp_ms>.jpg`, which is the naming
   * of a different set of files — the moments a model was asked about — and the
   * two schemes sharing one directory is how a frame at 1000 ms came to be read
   * from the file holding 999 s.
   */
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
