import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  compareText,
  CAPTURE_TIMELINE_GAP_MS,
  STILL_SLOT_MS,
  EditorialError,
  PIPELINE_VERSION,
  parseCaptureTime,
  seqId,
  type AssetPlacement,
  type AudioStream,
  type CaptureTime,
  type MediaAsset,
  type MediaKind,
  type ProbeResult,
} from '@editorial-ir/contracts';
import type { MediaProbe } from '@editorial-ir/perception';
import { canonicalJson, hashFile } from './fingerprint.js';
import type { PerceptionCache } from './cache.js';
import { isHeifFile, photoDateOf, type PhotoDate } from './exif.js';

/**
 * Registering media.
 *
 * Two rules govern everything here. The original file is never modified and
 * never moved, so a project directory can be deleted without losing footage. And
 * identity is the file's content hash, not its path, so renaming a file does not
 * re-analyse it and copying a project to another machine does not either.
 */

/**
 * The extensions ingest looks at. Each was probed with ffmpeg 6.1 on a
 * synthesised file (docs/inputs.md has the table); what a file turns out to
 * hold is then decided by its streams, not by this list.
 *
 * - Broadcast and camera containers: MXF (P2, XDCAM, most professional
 *   cameras), MPEG program streams (.mpg, .mpeg, DVD camcorders), MPEG
 *   transport streams (.ts, and AVCHD's .mts/.m2ts), 3GP/3G2 (older phones).
 * - Audio: AIFF and CAF (Apple's recorders and Logic), Ogg in all three names.
 * - Stills: WebP, AVIF and HEIF/HEIC beside JPEG, PNG and TIFF. HEIF needs an
 *   ffmpeg that can read it; ingest says so when this one cannot.
 */
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.m4v',
  '.avi',
  '.webm',
  '.mts',
  '.m2ts',
  '.ts',
  '.mxf',
  '.mpg',
  '.mpeg',
  '.3gp',
  '.3g2',
  '.ogv',
]);
const AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.aif',
  '.aiff',
  '.caf',
]);
const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.avif',
  '.tif',
  '.tiff',
]);

export function mediaKindOf(path: string): MediaKind | undefined {
  const extension = extname(path).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return undefined;
}

/**
 * Whether a file with a media extension is worth handing to the probe.
 *
 * `.ts` is an MPEG transport stream and it is also TypeScript. Accepted by name
 * alone, a script in a footage folder — or every source file of a repository,
 * on `oea ingest .` — would be handed to ffprobe and listed under "could not
 * read". A transport stream is 188-byte packets that each start 0x47 (192
 * bytes with the 4-byte clock of an M2TS, measured on ffmpeg's own AVCHD
 * output), so two sync bytes in the right places say which it is; a text file
 * with a 'G' at both is not one anybody has.
 */
export function isMediaFile(path: string): boolean {
  if (mediaKindOf(path) === undefined) return false;
  if (extname(path).toLowerCase() !== '.ts') return true;
  return looksLikeTransportStream(path);
}

function looksLikeTransportStream(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const head = new Uint8Array(400);
    const read = readSync(fd, head, 0, head.length, 0);
    const sync = (at: number) => at < read && head[at] === 0x47;
    return (sync(0) && sync(188)) || (sync(4) && sync(196));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Every media file under a path, recursively, in a stable order.
 *
 * A symbolic link is followed, to a file or to a folder: `Dirent.isFile()` is
 * false for a link, so a footage folder assembled from links to a card or an
 * archive drive — which is how many people avoid copying forty gigabytes —
 * ingested as nothing at all. A folder is walked once however many links lead
 * to it, so a link to a parent cannot loop. A link that points nowhere is
 * listed, so it is reported as unreadable rather than silently skipped.
 */
export function findMedia(target: string): string[] {
  // A path that is not there is a typo, which is a thing to say plainly rather
  // than a Node ENOENT with a stack trace through statSync.
  if (!existsSync(target)) {
    throw new EditorialError('not_found', `there is nothing at ${target}`);
  }
  const stat = statSync(target);
  if (stat.isFile()) return isMediaFile(target) ? [target] : [];

  const found: string[] = [];
  const walked = new Set<string>();
  const walk = (directory: string): void => {
    const real = realpathSync(directory);
    if (walked.has(real)) return;
    walked.add(real);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      compareText(a.name, b.name),
    )) {
      // Skip our own directory, or ingesting a project would ingest its proxies;
      // and macOS's `._` shadow files, which carry a media extension and no media.
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let linked;
        try {
          linked = statSync(path);
        } catch {
          if (mediaKindOf(path)) found.push(path);
          continue;
        }
        if (linked.isDirectory()) walk(path);
        else if (linked.isFile() && isMediaFile(path)) found.push(path);
      } else if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isMediaFile(path)) found.push(path);
    }
  };
  walk(target);
  return found;
}

export interface IngestOptions {
  projectRoot: string;
  probe: MediaProbe;
  cache?: PerceptionCache;
  /** Already-registered assets, so re-running is cheap and additive. */
  existing?: readonly MediaAsset[];
  onProgress?: (message: string, done: number, total: number) => void;
}

export interface IngestResult {
  assets: MediaAsset[];
  added: MediaAsset[];
  /** Files skipped because the same content is already registered. */
  duplicates: { path: string; existingId: string }[];
  /**
   * Registered assets whose container facts were read again and came out
   * different — a probe that has learned something since, such as the audio
   * streams, the nominal frame rate, or that the art on an MP3 is not a picture.
   * Ids, paths and places on the capture timeline are never touched, which is
   * why duration and capture time stay as they were registered.
   */
  refreshed: MediaAsset[];
  /** Files that could not be probed, with the reason and anything that would fix it. */
  failed: { path: string; reason: string; fix?: string }[];
}

export async function ingestPaths(
  targets: string[],
  options: IngestOptions,
): Promise<IngestResult> {
  const existing = [...(options.existing ?? [])];
  const byHash = new Map(existing.map((asset) => [asset.sha256, asset]));

  const files = targets.flatMap((target) => findMedia(resolve(target)));
  if (files.length === 0) {
    throw new EditorialError('not_found', 'no media files found', { targets });
  }

  const added: MediaAsset[] = [];
  const duplicates: IngestResult['duplicates'] = [];
  const refreshed = new Map<string, MediaAsset>();
  const failed: IngestResult['failed'] = [];
  let nextIndex = existing.length + 1;
  let done = 0;

  for (const file of files) {
    options.onProgress?.(basename(file), done++, files.length);

    // Hashing is the first thing that touches the file, and it was the one
    // step outside the per-file failure handling: a clip with no read
    // permission, a dropped network share, a card going bad, a file deleted
    // between listing and reading — any of them rejected out of the whole call,
    // so twenty-nine files already hashed and probed were discarded and nothing
    // was registered at all. The comment on the probe below says what the rule
    // is; this is the same rule, applied one line earlier.
    let sha256: string;
    try {
      sha256 = await hashFile(file);
    } catch (error) {
      failed.push({
        path: file,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const alreadyKnown = byHash.get(sha256);
    if (alreadyKnown) {
      duplicates.push({ path: file, existingId: alreadyKnown.id });
      // Read again, because a known file was never probed a second time: the
      // stream list, the nominal rate and the VFR flag reached no project that
      // had been ingested before they existed, however often it was re-ingested.
      // The probe is cached on the file and the probe's version, so this costs a
      // lookup once the new facts are known. A probe that fails now leaves the
      // asset exactly as it was.
      try {
        // Except where the file sits. The capture timeline is laid out from
        // each asset's capture time and duration, and a boundary the user asked
        // for is written in capture time: a refresh that moved either would move
        // every placement after it, and each of those annotations would land on
        // different footage without a word. So both stay as registered — and a
        // capture time the old probe never found is not added either, because
        // one more dated asset moves itself, and every asset after it, on the
        // capture timeline.
        //
        // The same goes for how precise the capture time is: a time that was
        // read as an instant and is now known to have no zone would change which
        // clock the timeline is ordered by.
        const {
          duration_ms: _duration,
          creation_time: _captured,
          capture_time: _precision,
          ...facts
        } = probedFields(alreadyKnown.file_name, await probeWithCache(file, sha256, options));
        const updated: MediaAsset = {
          ...facts,
          id: alreadyKnown.id,
          path: alreadyKnown.path,
          file_name: alreadyKnown.file_name,
          sha256: alreadyKnown.sha256,
          byte_size: alreadyKnown.byte_size,
          duration_ms: alreadyKnown.duration_ms,
          ...(alreadyKnown.creation_time === undefined
            ? {}
            : { creation_time: alreadyKnown.creation_time }),
          ...(alreadyKnown.capture_time === undefined
            ? {}
            : { capture_time: alreadyKnown.capture_time }),
        };
        if (canonicalJson(updated) !== canonicalJson(alreadyKnown)) {
          existing[existing.indexOf(alreadyKnown)] = updated;
          byHash.set(sha256, updated);
          refreshed.set(updated.id, updated);
        }
      } catch {
        // The asset stays as it was registered.
      }
      continue;
    }

    let probe;
    let stat;
    try {
      probe = await probeWithCache(file, sha256, options);
      // Inside, because a file can vanish between being hashed and being sized.
      stat = statSync(file);
    } catch (error) {
      // One unreadable file should not abandon an ingest of thirty.
      failed.push(
        probe === undefined && isHeifFile(file) && !isMissingProgram(error)
          ? heifFailure(file, error)
          : {
              path: file,
              reason: error instanceof Error ? error.message : String(error),
              // A missing program is the commonest first-run failure and the one
              // thing here the user can actually act on, so carry the remedy up
              // rather than making them go and find it.
              ...(EditorialError.is(error) && typeof error.details.install === 'string'
                ? { fix: error.details.install }
                : {}),
            },
      );
      continue;
    }

    const asset: MediaAsset = {
      ...probedFields(
        basename(file),
        probe,
        mediaKindOf(file) === 'image' ? photoDateOf(file) : undefined,
      ),
      id: seqId('asset', nextIndex++, 3),
      path: relativeToProject(file, options.projectRoot),
      file_name: basename(file),
      sha256,
      byte_size: stat.size,
    };

    byHash.set(sha256, asset);
    existing.push(asset);
    added.push(asset);
  }

  options.onProgress?.('done', files.length, files.length);
  return {
    assets: existing,
    added,
    duplicates,
    refreshed: [...refreshed.values()].sort((a, b) => compareText(a.id, b.id)),
    failed,
  };
}

function isMissingProgram(error: unknown): boolean {
  return EditorialError.is(error) && typeof error.details.install === 'string';
}

/**
 * A HEIC the installed ffmpeg cannot open, said as that.
 *
 * ffmpeg reads HEIF through its MP4 reader, and before HEIF support was added
 * that reader looks for a movie and reports, measured on ffmpeg 6.1 with a
 * one-picture HEIC: "moov atom not found ... Invalid data found when processing
 * input". Every iPhone photo in a folder failed with that, which reads as a
 * corrupt file. It is a missing feature of one program, with two remedies.
 */
function heifFailure(file: string, error: unknown): IngestResult['failed'][number] {
  // What ffprobe said, not the command line and the path again.
  const message = error instanceof Error ? error.message : String(error);
  const detail = /moov atom not found/i.test(message)
    ? 'moov atom not found'
    : message.trim().split('\n').at(-1)?.replace(/^.*: /, '');
  return {
    path: file,
    reason:
      'a HEIF/HEIC photo, and the installed ffmpeg cannot read HEIF' +
      (detail ? ` (ffprobe: ${detail})` : ''),
    fix:
      'HEIF photos need FFmpeg 7.1 or newer (which also reads the tiled pictures phones take); ' +
      'or export them as JPEG, which keeps their EXIF capture time',
  };
}

/**
 * What a file is, decided by what is in it and only then by its name.
 *
 * The extension was the whole answer, so an .mp4 or .mov holding nothing but
 * sound — a voice memo, a podcast exported from an editor — was a video, and
 * every picture stage went looking for frames in it. A picture keeps its name's
 * kind: an image is a picture by construction, and an audio file's album art is
 * not a picture of anything, which the probe already leaves out.
 */
export function mediaKindFromProbe(
  fileName: string,
  probe: Pick<ProbeResult, 'video_codec' | 'width' | 'audio_codec' | 'audio_streams'>,
): MediaKind {
  const byName = mediaKindOf(fileName) ?? 'video';
  if (byName !== 'video') return byName;
  const picture = probe.video_codec !== undefined && (probe.width ?? 0) > 0;
  const sound = (probe.audio_streams?.length ?? 0) > 0 || probe.audio_codec !== undefined;
  return !picture && sound ? 'audio' : 'video';
}

/** Everything about an asset that comes from reading the file rather than from registering it. */
function probedFields(
  fileName: string,
  probe: ProbeResult,
  photo?: PhotoDate,
): Omit<MediaAsset, 'id' | 'path' | 'file_name' | 'sha256' | 'byte_size'> {
  const kind = mediaKindFromProbe(fileName, probe);
  const capture = captureTimeOf(probe, photo);
  const timecode = kind === 'image' ? undefined : probe.start_timecode;
  // A still has no frame rate. ffmpeg's image reader reports 25/1 for every
  // picture, and the sequence took its rate from the largest asset — so a
  // 4032x3024 phone photo made a 30 fps video's project 4032x3024 at 25 fps.
  const moving = kind === 'video';
  const variable = moving ? probe.variable_frame_rate : undefined;
  return {
    kind,
    // A still has no duration of its own; it gets one when it is used.
    duration_ms: kind === 'image' ? 0 : probe.duration_ms,
    ...(probe.width === undefined ? {} : { width: probe.width }),
    ...(probe.height === undefined ? {} : { height: probe.height }),
    ...(moving && probe.fps_num && probe.fps_den
      ? { fps: probe.fps_num / probe.fps_den, fps_num: probe.fps_num, fps_den: probe.fps_den }
      : {}),
    ...(probe.video_codec === undefined ? {} : { video_codec: probe.video_codec }),
    ...(probe.audio_codec === undefined ? {} : { audio_codec: probe.audio_codec }),
    ...(probe.audio_channels === undefined ? {} : { audio_channels: probe.audio_channels }),
    ...(probe.audio_sample_rate === undefined
      ? {}
      : { audio_sample_rate: probe.audio_sample_rate }),
    ...(probe.container === undefined ? {} : { container: probe.container }),
    ...(probe.bit_rate === undefined ? {} : { bit_rate: probe.bit_rate }),
    ...(probe.rotation === undefined ? {} : { rotation: probe.rotation }),
    ...(probe.audio_streams === undefined || kind === 'image'
      ? {}
      : { audio_streams: probe.audio_streams.map(audioStreamOf) }),
    ...(variable === undefined ? {} : { variable_frame_rate: variable }),
    ...(variable && probe.avg_fps_num && probe.avg_fps_den
      ? { avg_fps: probe.avg_fps_num / probe.avg_fps_den }
      : {}),
    // Whatever the file said, as an instant or not at all. A date the
    // contract cannot hold is worse than none: assets are laid on the capture
    // timeline in this order, and a misread one invents continuity.
    ...(capture?.instant === undefined ? {} : { creation_time: capture.instant }),
    ...(capture === undefined ? {} : { capture_time: capture.time }),
    ...(timecode === undefined ? {} : { start_timecode: timecode }),
    metadata: probe.metadata,
  };
}

/**
 * The capture time, from the most trustworthy place that has one.
 *
 * A photo's own EXIF first: ffprobe gives a JPEG no tags, and where it gives a
 * PNG or TIFF some they are not when the shutter fired. Then what the probe
 * chose from the container, which is `com.apple.quicktime.creationdate` when
 * there is one — it carries the offset — and the container's own date
 * otherwise. A value that is only a date is kept as a date; a value that parses
 * as nothing is dropped, and that is the right answer too.
 */
function captureTimeOf(
  probe: ProbeResult,
  photo: PhotoDate | undefined,
): { time: CaptureTime; instant?: string } | undefined {
  const candidates: { raw: string; source: CaptureTime['source'] }[] = [];
  if (photo) candidates.push({ raw: photo.value, source: photo.source });
  if (probe.creation_time !== undefined) {
    const quicktime = probe.metadata['com.apple.quicktime.creationdate'];
    candidates.push({
      raw: probe.creation_time,
      source:
        typeof quicktime === 'string' && quicktime.trim() === probe.creation_time.trim()
          ? 'quicktime'
          : 'container',
    });
  }
  for (const { raw, source } of candidates) {
    const parsed = parseCaptureTime(raw);
    if (!parsed) continue;
    const time: CaptureTime = {
      source,
      precision: parsed.precision,
      raw: raw.trim(),
      ...(parsed.local === undefined ? {} : { local: parsed.local }),
      ...(parsed.offsetMinutes === undefined ? {} : { utc_offset_minutes: parsed.offsetMinutes }),
      ...(parsed.date === undefined ? {} : { date: parsed.date }),
    };
    return parsed.instant === undefined ? { time } : { time, instant: parsed.instant };
  }
  return undefined;
}

function audioStreamOf(stream: NonNullable<ProbeResult['audio_streams']>[number]): AudioStream {
  return {
    index: stream.index,
    ...(stream.codec === undefined ? {} : { codec: stream.codec }),
    ...(stream.channels === undefined ? {} : { channels: stream.channels }),
    ...(stream.sample_rate === undefined ? {} : { sample_rate: stream.sample_rate }),
    ...(stream.language === undefined ? {} : { language: stream.language }),
    ...(stream.title === undefined ? {} : { title: stream.title }),
  };
}

async function probeWithCache(
  file: string,
  sha256: string,
  options: IngestOptions,
): Promise<ProbeResult> {
  const parts = {
    operation: 'probe',
    mediaSha256: sha256,
    backend: options.probe.identity.backend,
    ...(options.probe.identity.model === undefined ? {} : { model: options.probe.identity.model }),
    // What the probe's answer means, for when that changes and its name does
    // not: a probe cached before the audio streams were listed would otherwise
    // be served for good, and re-ingesting would refresh nothing.
    ...(options.probe.identity.modelVersion === undefined
      ? {}
      : { modelVersion: options.probe.identity.modelVersion }),
    pipelineVersion: PIPELINE_VERSION,
  };
  const cached = options.cache?.get<ProbeResult>(parts);
  if (cached) return cached;
  const probed = await options.probe.probe(file);
  options.cache?.set(parts, probed);
  return probed;
}

function relativeToProject(file: string, projectRoot: string): string {
  const relativePath = relative(resolve(projectRoot), file);
  // Media outside the project keeps its absolute path; media inside gets a
  // relative one, so the whole directory can be moved between machines.
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return file;
  return relativePath;
}

/**
 * The clock a capture time is read on.
 *
 * `utc` is an instant. `local` is the wall clock where the file was made, which
 * is all a camera that does not know its zone can say — EXIF without
 * `OffsetTimeOriginal`, an AVI, a Broadcast WAV — and which a phone clip that
 * wrote its offset can say as well. Two readings are comparable only on the
 * same clock: a zone-less 18:00 read as 18:00 UTC was nine hours out in Tokyo,
 * and it was then sorted against phone clips that did carry their zone.
 */
export type CaptureClock = 'utc' | 'local';

/** An asset's capture start on one clock, in milliseconds, or nothing. */
export function captureMsOn(
  asset: Pick<MediaAsset, 'creation_time' | 'capture_time'>,
  clock: CaptureClock,
): number | undefined {
  const text =
    clock === 'utc'
      ? asset.creation_time
      : asset.capture_time?.local === undefined
        ? undefined
        : `${asset.capture_time.local}Z`;
  if (text === undefined) return undefined;
  // By the instant, not by how the string sorts. The two agree only while every
  // timestamp is in the one canonical form, which is a property of what
  // `ingest` writes rather than of what a camera produces.
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * How long after `from` started `to` started, in real time, when both say on
 * a clock they share: the instant when both have one, else the wall clock when
 * both have that. Never one against the other.
 */
export function captureStartsApartMs(
  from: Pick<MediaAsset, 'creation_time' | 'capture_time'>,
  to: Pick<MediaAsset, 'creation_time' | 'capture_time'>,
): number | undefined {
  for (const clock of ['utc', 'local'] as const) {
    const a = captureMsOn(from, clock);
    const b = captureMsOn(to, clock);
    if (a !== undefined && b !== undefined) return b - a;
  }
  return undefined;
}

/**
 * The clock that orders the most of a project, or nothing when no asset is
 * dated on either.
 *
 * The instant unless more assets have a wall clock than an instant — photos
 * from a camera that knows no zone beside phone clips that wrote theirs. And
 * never the wall clock when the files that wrote an offset wrote more than one:
 * then the day crossed a time zone, and 18:00 in Tokyo and 11:00 in Paris on
 * the same date are not in the order their wall clocks say.
 */
export function captureClockFor(
  assets: readonly Pick<MediaAsset, 'creation_time' | 'capture_time'>[],
): CaptureClock | undefined {
  const onUtc = assets.filter((a) => captureMsOn(a, 'utc') !== undefined).length;
  const onLocal = assets.filter((a) => captureMsOn(a, 'local') !== undefined).length;
  const offsets = new Set(
    assets.flatMap((a) =>
      a.capture_time?.utc_offset_minutes === undefined ? [] : [a.capture_time.utc_offset_minutes],
    ),
  );
  if (onLocal > onUtc && offsets.size <= 1) return 'local';
  return onUtc > 0 ? 'utc' : undefined;
}

/**
 * Lays assets end to end on the capture timeline.
 *
 * Semantic events need one ordered axis, or "the previous event" means nothing
 * across thirty files. Capture time is that axis when the camera recorded it,
 * and file name is the fallback — cameras are not reliable about metadata, and a
 * wrong order is far more damaging than an arbitrary one, because it invents
 * continuity that was never there.
 *
 * The fallback is per asset. It was all or nothing: one asset without a time put
 * every asset in file-name order, and a photo with no date — ffprobe gives a
 * JPEG no tags at all — turned B.MOV at 10:00:00 and A.MOV at 10:00:10 into A,
 * B. Now the dated assets keep their order and an undated one is set beside its
 * file-name neighbour among them: after the dated file its name sorts after,
 * which for a camera's own numbering (IMG_0041.MOV, IMG_0042.JPG) is the file
 * shot just before it; before the first dated file its name sorts before when no
 * dated name sorts ahead of it. A project where nothing or everything is dated is
 * laid out exactly as it was.
 */
export function placeAssets(assets: readonly MediaAsset[]): AssetPlacement[] {
  const clock = captureClockFor(assets);
  const byName = (a: MediaAsset, b: MediaAsset): number =>
    compareText(a.file_name, b.file_name) || compareText(a.id, b.id);
  const at = (asset: MediaAsset): number | undefined =>
    clock === undefined ? undefined : captureMsOn(asset, clock);

  const dated = assets
    .filter((asset) => at(asset) !== undefined)
    .sort((a, b) => at(a)! - at(b)! || byName(a, b));
  const datedByName = [...dated].sort(byName);

  // Every asset gets a slot: a dated asset its own place in time, an undated one
  // the place of its neighbour, just after it (1) or just before it (-1).
  const slots = new Map<string, { index: number; side: -1 | 0 | 1; beside?: MediaAsset }>();
  dated.forEach((asset, index) => slots.set(asset.id, { index, side: 0 }));
  for (const asset of assets) {
    if (slots.has(asset.id) || dated.length === 0) continue;
    const before = datedByName.filter((d) => byName(d, asset) < 0).at(-1);
    const neighbour = before ?? datedByName.find((d) => byName(d, asset) > 0)!;
    slots.set(asset.id, {
      index: dated.indexOf(neighbour),
      side: before ? 1 : -1,
      beside: neighbour,
    });
  }

  const slotOf = (asset: MediaAsset) => slots.get(asset.id) ?? { index: 0, side: 0 as const };
  const ordered = [...assets].sort(
    (a, b) => slotOf(a).index - slotOf(b).index || slotOf(a).side - slotOf(b).side || byName(a, b),
  );

  let offset = 0;
  return ordered.map((asset, index) => {
    const slot = slots.get(asset.id);
    const byTime = slot !== undefined && slot.side === 0;
    const placement: AssetPlacement = {
      asset_id: asset.id,
      offset_ms: offset,
      order: index,
      ordered_by: byTime ? 'creation_time' : 'file_name',
      ...(byTime && clock !== undefined ? { clock } : {}),
      ...(slot?.beside === undefined
        ? {}
        : {
            beside: {
              asset_id: slot.beside.id,
              side: slot.side === 1 ? ('after' as const) : ('before' as const),
            },
          }),
    };
    // A gap between files, so an event can never straddle two recordings by
    // accident of arithmetic. A still has no duration and takes a slot instead,
    // so it has somewhere to be an event; a project with no stills is laid out
    // exactly as before, and so is every capture time a user wrote about it.
    offset +=
      (asset.kind === 'image' ? STILL_SLOT_MS : asset.duration_ms) + CAPTURE_TIMELINE_GAP_MS;
    return placement;
  });
}

/** Maps a time inside an asset to the capture timeline, and back. */
export function toCaptureTime(
  placements: readonly AssetPlacement[],
  assetId: string,
  ms: number,
): number {
  const placement = placements.find((p) => p.asset_id === assetId);
  return (placement?.offset_ms ?? 0) + ms;
}

export function fromCaptureTime(
  placements: readonly AssetPlacement[],
  assetId: string,
  captureMs: number,
): number {
  const placement = placements.find((p) => p.asset_id === assetId);
  return Math.max(0, captureMs - (placement?.offset_ms ?? 0));
}
