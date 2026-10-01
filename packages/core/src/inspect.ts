import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  EditorialError,
  type EditorialIR,
  type MediaAsset,
  type ObservationTimeline,
  type SemanticEvent,
  type Shot,
} from '@editorial-ir/contracts';
import { NodeCommandRunner, frameFileName, framesDirName } from '@editorial-ir/perception';
import { projectPaths } from './paths.js';

/**
 * Looking closer at one moment.
 *
 * The representation is a hierarchy — project, asset, chapter, event, shot,
 * frame — and almost everything works at the event level, because that is the
 * level at which editing decisions are made and the level at which an hour of
 * footage is small enough to reason about. The layers below exist for the cases
 * where the summary was not enough, and descending into them is deliberate
 * rather than automatic: a frame costs an image, and an agent that looks at
 * every frame is the design this project exists to avoid.
 *
 * So this is a staircase, not a firehose. Ask for the shots inside an event;
 * if that is still not enough, ask for its frames; if you need to actually see
 * it, ask for a contact sheet, which is one image rather than twelve.
 */

/** A shot inside an event, with where it sits relative to the event's start. */
export interface ShotDetail {
  shot: Shot;
  /** Milliseconds from the start of the event. */
  offset_ms: number;
  duration_ms: number;
  /** Whether the shot is entirely inside the event or clipped by its edge. */
  whole: boolean;
}

/**
 * The shots an event is made of.
 *
 * An event is a stretch of meaning and a shot is a stretch of camera, and the
 * two do not line up: "arriving at the park" can be four shots, and one long
 * handheld shot can span three events. Which is exactly why this is worth being
 * able to ask — "why does this event look like that" is often answered by
 * "because it is four shots and one of them is of the ground".
 */
export function shotsIn(
  observations: ObservationTimeline,
  event: Pick<SemanticEvent, 'source_ranges'>,
): ShotDetail[] {
  const details: ShotDetail[] = [];
  for (const range of event.source_ranges) {
    for (const shot of observations.shots) {
      if (shot.asset_id !== range.asset_id) continue;
      if (shot.end_ms <= range.source_in_ms || shot.start_ms >= range.source_out_ms) continue;
      const start = Math.max(shot.start_ms, range.source_in_ms);
      const end = Math.min(shot.end_ms, range.source_out_ms);
      details.push({
        shot,
        offset_ms: start - range.source_in_ms,
        duration_ms: end - start,
        whole: shot.start_ms >= range.source_in_ms && shot.end_ms <= range.source_out_ms,
      });
    }
  }
  return details.sort((a, b) => a.shot.start_ms - b.shot.start_ms);
}

/** A sampled frame that exists on disk. */
export interface FrameRef {
  path: string;
  asset_id: string;
  /** Position in the source asset. */
  source_ms: number;
}

export interface FramesOptions {
  /** How many frames to return, spread across the event. Default 4. */
  count?: number;
  /** The rate frames were sampled at during ingestion. Default 1. */
  fps?: number;
  /**
   * Take one frame per shot instead of spreading evenly.
   *
   * A shot boundary is a decision somebody made with a camera, so its frame
   * shows something a regular sample can miss entirely.
   */
  perShot?: boolean;
  observations?: ObservationTimeline;
}

/**
 * Frame files for an event, if frames were sampled when the media was ingested.
 *
 * Returns only paths that exist. Frames are a derivative — the work directory is
 * safe to delete, and after deleting it this correctly returns nothing rather
 * than a list of paths that will fail to open later.
 */
export function framesIn(
  ir: EditorialIR,
  projectRoot: string,
  event: Pick<SemanticEvent, 'source_ranges'>,
  options: FramesOptions = {},
): FrameRef[] {
  const fps = options.fps ?? 1;
  const count = Math.max(1, options.count ?? 4);
  const work = projectPaths(projectRoot).workDir;

  const wanted: { asset_id: string; source_ms: number }[] = [];
  for (const range of event.source_ranges) {
    if (options.perShot && options.observations) {
      for (const detail of shotsIn(options.observations, { source_ranges: [range] })) {
        wanted.push({ asset_id: range.asset_id, source_ms: detail.shot.representative_frame_ms });
      }
      continue;
    }
    const span = range.source_out_ms - range.source_in_ms;
    // Inset from both edges: the first and last frames of an event are often
    // the tail of the previous shot and the head of the next.
    for (let i = 0; i < count; i++) {
      const fraction = count === 1 ? 0.5 : 0.1 + (0.8 * i) / (count - 1);
      wanted.push({ asset_id: range.asset_id, source_ms: range.source_in_ms + span * fraction });
    }
  }

  const seen = new Set<string>();
  const frames: FrameRef[] = [];
  for (const point of wanted) {
    const asset = ir.assets.find((a) => a.id === point.asset_id);
    if (!asset) continue;
    const path = framePath(work, asset, point.source_ms, fps);
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    frames.push({ path, asset_id: point.asset_id, source_ms: Math.round(point.source_ms) });
  }
  return frames.sort((a, b) => a.source_ms - b.source_ms);
}

/**
 * Where a sampled frame lives.
 *
 * Derived from the asset's content hash rather than read from the ingestion
 * result, so that looking at a frame does not require having just ingested the
 * media. The same derivation as the ingest stage, and a test holds them
 * together.
 */
export function framePath(
  workDir: string,
  asset: Pick<MediaAsset, 'sha256'>,
  sourceMs: number,
  fps: number,
): string {
  const index = Math.max(1, Math.round((sourceMs * fps) / 1000) + 1);
  // The directory is named for its rate, as prepare names it, so frames sampled
  // at another rate are never read as these.
  return join(workDir, asset.sha256.slice(0, 12), framesDirName(fps), frameFileName(index));
}

export interface ContactSheetOptions {
  /** Columns in the grid. Rows follow from the number of frames. */
  columns?: number;
  /** Height of each cell in pixels. */
  cellHeight?: number;
  binary?: string;
  run?: (binary: string, args: readonly string[]) => Promise<unknown>;
}

/**
 * Lays frames out as a single image.
 *
 * One image instead of twelve is the whole point. A hosted vision model charges
 * per image, and a grid of eight frames answers "what happens here" about as
 * well as eight separate frames do, for an eighth of the cost — and it shows
 * the order, which separate images do not.
 */
export async function contactSheet(
  frames: readonly FrameRef[],
  outputPath: string,
  options: ContactSheetOptions = {},
): Promise<string> {
  if (frames.length === 0) {
    throw new EditorialError('not_found', 'there are no sampled frames for this moment', {
      hint: 'frames are written during "oea ingest"; the work directory may have been deleted',
    });
  }

  const columns = Math.max(1, Math.min(options.columns ?? 4, frames.length));
  const rows = Math.ceil(frames.length / columns);
  const cellHeight = options.cellHeight ?? 180;
  mkdirSync(join(outputPath, '..'), { recursive: true });

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...frames.flatMap((frame) => ['-i', frame.path]),
    '-filter_complex',
    tileFilter(frames.length, columns, rows, cellHeight),
    // A filter graph that names its output has to be mapped to the file, or
    // ffmpeg's automatic stream selection ignores it and refuses the whole
    // command: "Filter xstack:default has an unconnected output". Nothing here
    // could catch it, because every test of this stubs the runner out — it
    // needs a real ffmpeg and real frames, which is what `--sheet` has.
    '-map',
    '[out]',
    '-frames:v',
    '1',
    outputPath,
  ];

  const run = options.run ?? defaultRunner;
  await run(options.binary ?? 'ffmpeg', args);
  return outputPath;
}

/** Scales every input to the same cell and tiles them into one frame. */
export function tileFilter(
  frameCount: number,
  columns: number,
  rows: number,
  cellHeight: number,
): string {
  // Each input is scaled and padded to an identical cell, because xstack
  // refuses to lay out inputs of differing sizes and source frames differ
  // whenever the footage does.
  const scaled = Array.from(
    { length: frameCount },
    (_, i) => `[${i}:v]scale=-2:${cellHeight},pad=iw+4:ih+4:2:2:color=black,setsar=1[c${i}]`,
  ).join(';');

  const inputs = Array.from({ length: frameCount }, (_, i) => `[c${i}]`).join('');
  const layout = Array.from({ length: frameCount }, (_, i) => {
    const column = i % columns;
    const row = Math.floor(i / columns);
    return `${column === 0 ? '0' : `w0*${column}`}_${row === 0 ? '0' : `h0*${row}`}`;
  }).join('|');

  if (frameCount === 1) return `${scaled};[c0]null[out]`;
  void rows;
  return `${scaled};${inputs}xstack=inputs=${frameCount}:layout=${layout}:fill=black[out]`;
}

async function defaultRunner(binary: string, args: readonly string[]): Promise<void> {
  await new NodeCommandRunner().run(binary, [...args], { timeoutMs: 60_000 });
}
