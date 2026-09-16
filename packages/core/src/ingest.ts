import { readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CAPTURE_TIMELINE_GAP_MS,
  EditorialError,
  PIPELINE_VERSION,
  seqId,
  type AssetPlacement,
  type MediaAsset,
  type MediaKind,
} from '@editorial-ir/contracts';
import type { MediaProbe } from '@editorial-ir/perception';
import { hashFile } from './fingerprint.js';
import type { PerceptionCache } from './cache.js';

/**
 * Registering media.
 *
 * Two rules govern everything here. The original file is never modified and
 * never moved, so a project directory can be deleted without losing footage. And
 * identity is the file's content hash, not its path, so renaming a file does not
 * re-analyse it and copying a project to another machine does not either.
 */

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.avi', '.webm', '.mts', '.m2ts']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff']);

export function mediaKindOf(path: string): MediaKind | undefined {
  const extension = extname(path).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return undefined;
}

/** Every media file under a path, recursively, in a stable order. */
export function findMedia(target: string): string[] {
  const stat = statSync(target);
  if (stat.isFile()) return mediaKindOf(target) ? [target] : [];

  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      // Skip our own directory, or ingesting a project would ingest its proxies.
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && mediaKindOf(path)) found.push(path);
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
  /** Files that could not be probed, with the reason. */
  failed: { path: string; reason: string }[];
}

export async function ingestPaths(targets: string[], options: IngestOptions): Promise<IngestResult> {
  const existing = [...(options.existing ?? [])];
  const byHash = new Map(existing.map((asset) => [asset.sha256, asset]));

  const files = targets.flatMap((target) => findMedia(resolve(target)));
  if (files.length === 0) {
    throw new EditorialError('not_found', 'no media files found', { targets });
  }

  const added: MediaAsset[] = [];
  const duplicates: IngestResult['duplicates'] = [];
  const failed: IngestResult['failed'] = [];
  let nextIndex = existing.length + 1;
  let done = 0;

  for (const file of files) {
    options.onProgress?.(basename(file), done++, files.length);

    const sha256 = await hashFile(file);
    const alreadyKnown = byHash.get(sha256);
    if (alreadyKnown) {
      duplicates.push({ path: file, existingId: alreadyKnown.id });
      continue;
    }

    let probe;
    try {
      probe = await probeWithCache(file, sha256, options);
    } catch (error) {
      // One unreadable file should not abandon an ingest of thirty.
      failed.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const kind = mediaKindOf(file) ?? 'video';
    const stat = statSync(file);
    const asset: MediaAsset = {
      id: seqId('asset', nextIndex++, 3),
      path: relativeToProject(file, options.projectRoot),
      file_name: basename(file),
      kind,
      sha256,
      byte_size: stat.size,
      // A still has no duration of its own; it gets one when it is used.
      duration_ms: kind === 'image' ? 0 : probe.duration_ms,
      ...(probe.width === undefined ? {} : { width: probe.width }),
      ...(probe.height === undefined ? {} : { height: probe.height }),
      ...(probe.fps_num && probe.fps_den
        ? { fps: probe.fps_num / probe.fps_den, fps_num: probe.fps_num, fps_den: probe.fps_den }
        : {}),
      ...(probe.video_codec === undefined ? {} : { video_codec: probe.video_codec }),
      ...(probe.audio_codec === undefined ? {} : { audio_codec: probe.audio_codec }),
      ...(probe.audio_channels === undefined ? {} : { audio_channels: probe.audio_channels }),
      ...(probe.audio_sample_rate === undefined ? {} : { audio_sample_rate: probe.audio_sample_rate }),
      ...(probe.container === undefined ? {} : { container: probe.container }),
      ...(probe.bit_rate === undefined ? {} : { bit_rate: probe.bit_rate }),
      ...(probe.rotation === undefined ? {} : { rotation: probe.rotation }),
      ...(probe.creation_time === undefined ? {} : { creation_time: probe.creation_time }),
      metadata: probe.metadata,
    };

    byHash.set(sha256, asset);
    existing.push(asset);
    added.push(asset);
  }

  options.onProgress?.('done', files.length, files.length);
  return { assets: existing, added, duplicates, failed };
}

async function probeWithCache(file: string, sha256: string, options: IngestOptions) {
  const parts = {
    operation: 'probe',
    mediaSha256: sha256,
    backend: options.probe.identity.backend,
    ...(options.probe.identity.model === undefined ? {} : { model: options.probe.identity.model }),
    pipelineVersion: PIPELINE_VERSION,
  };
  const cached = options.cache?.get<Awaited<ReturnType<MediaProbe['probe']>>>(parts);
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
 * Lays assets end to end on the capture timeline.
 *
 * Semantic events need one ordered axis, or "the previous event" means nothing
 * across thirty files. Capture time is that axis when the camera recorded it,
 * and file name is the fallback — cameras are not reliable about metadata, and a
 * wrong order is far more damaging than an arbitrary one, because it invents
 * continuity that was never there.
 */
export function placeAssets(assets: readonly MediaAsset[]): AssetPlacement[] {
  const everyAssetHasTime = assets.every((asset) => asset.creation_time);
  const ordered = [...assets].sort((a, b) => {
    if (everyAssetHasTime) {
      const byTime = (a.creation_time ?? '').localeCompare(b.creation_time ?? '');
      if (byTime !== 0) return byTime;
    }
    return a.file_name.localeCompare(b.file_name) || a.id.localeCompare(b.id);
  });

  let offset = 0;
  return ordered.map((asset, index) => {
    const placement: AssetPlacement = {
      asset_id: asset.id,
      offset_ms: offset,
      order: index,
      ordered_by: everyAssetHasTime ? 'creation_time' : 'file_name',
    };
    // A gap between files, so an event can never straddle two recordings by
    // accident of arithmetic.
    offset += asset.duration_ms + CAPTURE_TIMELINE_GAP_MS;
    return placement;
  });
}

/** Maps a time inside an asset to the capture timeline, and back. */
export function toCaptureTime(placements: readonly AssetPlacement[], assetId: string, ms: number): number {
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
