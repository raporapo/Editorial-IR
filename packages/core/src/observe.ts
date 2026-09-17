import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsolute, resolve } from 'node:path';
import {
  EMPTY_OBSERVATIONS,
  PIPELINE_VERSION,
  seqId,
  type AudioEvent,
  type AudioProfile,
  type FrameFeature,
  type MediaAsset,
  type ObservationTimeline,
  type OcrObservation,
  type PrepareResult,
  type ProjectContext,
  type Shot,
  type Utterance,
} from '@editorial-ir/contracts';
import { ModelScheduler, frameFileName, type PerceptionSuite } from '@editorial-ir/perception';
import type { PerceptionCache } from './cache.js';
import type { ModelRunRecorder } from './model-runs.js';
import type { CacheKeyParts } from './fingerprint.js';

/**
 * Running perception over every asset.
 *
 * Ordered so that one model is loaded at a time — every file transcribed, then
 * every file embedded — because a 16 GB card cannot hold a transcriber and a
 * vision model at once, and because reloading a model per file costs more than
 * all the inference.
 *
 * Every result is cached on the media hash and the model identity, so adding a
 * sentence to the project background or changing the target duration re-runs
 * none of it.
 */
export interface ObserveOptions {
  projectRoot: string;
  workDir: string;
  suite: PerceptionSuite;
  cache?: PerceptionCache;
  context?: ProjectContext;
  runs: ModelRunRecorder;
  scheduler?: ModelScheduler;
  /** Frames per second sampled for visual analysis. */
  frameFps?: number;
  /** Hop for the loudness envelope. */
  audioHopMs?: number;
  onProgress?: (stage: string, message: string, done: number, total: number) => void;
}

/**
 * A stage the analysis went without.
 *
 * The reason belongs to the entry rather than to whoever prints it. Reusing an
 * earlier analysis drops the frame vectors, which is a different thing from
 * having no vision model, and a report that said "no model configured" for both
 * was describing one of them wrongly.
 */
export interface UnavailableStage {
  stage: string;
  reason: string;
}

export interface ObserveResult {
  observations: ObservationTimeline;
  /** Derivative paths per asset, needed later by the context builder for frames. */
  derived: Map<string, PrepareResult>;
  /**
   * Frame vectors, keyed `<asset_id>:<timestamp_ms>`.
   *
   * Kept out of the observation document because a one-hour project is tens of
   * megabytes of numbers no human will ever read in a diff, and held in memory
   * because both segmentation and the visual index need them during this compile.
   */
  frameVectors: Map<string, number[]>;
  /** Stages the analysis went without, and why. */
  unavailable: UnavailableStage[];
  /**
   * Assets a stage could not read, and why.
   *
   * One unreadable file must not abandon an analysis of thirty. The compile
   * continues with less information and says so, rather than failing at minute
   * forty of an hour of work.
   */
  failures: { stage: string; assetId: string; reason: string }[];
}

export async function observeAssets(
  assets: readonly MediaAsset[],
  options: ObserveOptions,
): Promise<ObserveResult> {
  const scheduler = options.scheduler ?? new ModelScheduler();
  const ordered = [...assets].sort((a, b) => a.id.localeCompare(b.id));
  const derived = new Map<string, PrepareResult>();
  const unavailable: UnavailableStage[] = [];
  const failures: ObserveResult['failures'] = [];

  const attempt = async (
    stage: string,
    assetId: string,
    work: () => Promise<void>,
  ): Promise<void> => {
    try {
      await work();
    } catch (error) {
      failures.push({
        stage,
        assetId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const utterances: Utterance[] = [];
  const shots: Shot[] = [];
  const audioEvents: AudioEvent[] = [];
  const ocr: OcrObservation[] = [];
  const frameFeatures: FrameFeature[] = [];
  const audioProfiles: AudioProfile[] = [];

  const frameVectors = new Map<string, number[]>();
  const counters = { utt: 0, shot: 0, aev: 0, ocr: 0, frm: 0 };
  const frameFps = options.frameFps ?? 1;

  // ---- prepare -------------------------------------------------------------
  if (options.suite.preparer) {
    const preparer = options.suite.preparer;
    const runId = options.runs.fromIdentity('ingest', preparer.identity);
    void runId;
    let done = 0;
    for (const asset of ordered) {
      options.onProgress?.('prepare', asset.file_name, done++, ordered.length);
      await attempt('prepare', asset.id, async () => {
        const workDir = join(options.workDir, asset.sha256.slice(0, 12));
        mkdirSync(workDir, { recursive: true });
        derived.set(
          asset.id,
          await preparer.prepare({
            path: absolutePath(asset, options.projectRoot),
            work_dir: workDir,
            proxy_height: asset.kind === 'video' ? 480 : 0,
            extract_audio: asset.kind !== 'image',
            frame_fps: asset.kind === 'video' ? frameFps : 0,
          }),
        );
      });
    }
  } else {
    unavailable.push({ stage: 'prepare', reason: 'no model is configured for it' });
  }

  // ---- speech --------------------------------------------------------------
  if (options.suite.speech) {
    const speech = options.suite.speech;
    const runId = options.runs.fromIdentity('speech', speech.identity);
    await scheduler.withModel('speech', async () => {
      let done = 0;
      for (const asset of ordered) {
        if (asset.kind === 'image') continue;
        // Extracted audio when there is some; otherwise the media itself, which
        // every real transcriber can read and which is what a replayed fixture
        // is keyed by.
        const audioPath =
          derived.get(asset.id)?.audio_path ?? absolutePath(asset, options.projectRoot);
        options.onProgress?.('transcribe', asset.file_name, done++, ordered.length);

        const params = {
          audio_path: audioPath,
          ...(options.context?.editing_goal.language
            ? { language: options.context.editing_goal.language }
            : {}),
          vocabulary: options.context?.background.vocabulary ?? [],
          word_timestamps: true,
          diarize: false,
        };
        let result: Awaited<ReturnType<typeof speech.transcribe>> | undefined;
        await attempt('speech', asset.id, async () => {
          result = await cached(
            options.cache,
            keyFor('transcribe', asset, speech.identity, params),
            () => speech.transcribe(params),
          );
        });
        if (!result) continue;

        for (const utterance of result.utterances) {
          if (utterance.end_ms <= utterance.start_ms) continue;
          utterances.push({
            id: seqId('utt', ++counters.utt, 5),
            asset_id: asset.id,
            start_ms: utterance.start_ms,
            end_ms: utterance.end_ms,
            ...(utterance.speaker_id === undefined ? {} : { speaker_id: utterance.speaker_id }),
            text: utterance.text,
            ...(result.language === undefined ? {} : { language: result.language }),
            confidence: utterance.confidence,
            ...(utterance.words === undefined ? {} : { words: utterance.words }),
            model_run_id: runId,
          });
        }
      }
    });
  } else {
    unavailable.push({ stage: 'speech', reason: 'no model is configured for it' });
  }

  // ---- shots ---------------------------------------------------------------
  if (options.suite.shots) {
    const detector = options.suite.shots;
    const runId = options.runs.fromIdentity('shot_detection', detector.identity);
    let done = 0;
    for (const asset of ordered) {
      if (asset.kind !== 'video') continue;
      options.onProgress?.('shots', asset.file_name, done++, ordered.length);

      const source = derived.get(asset.id)?.proxy_path ?? absolutePath(asset, options.projectRoot);
      const params = { path: source, threshold: 0.3, min_shot_ms: 800 };
      let result: Awaited<ReturnType<typeof detector.detectShots>> | undefined;
      await attempt('shots', asset.id, async () => {
        result = await cached(
          options.cache,
          keyFor('detect_shots', asset, detector.identity, params),
          () => detector.detectShots(params),
        );
      });
      if (!result) continue;

      for (const shot of result.shots) {
        if (shot.end_ms <= shot.start_ms) continue;
        shots.push({
          id: seqId('shot', ++counters.shot, 5),
          asset_id: asset.id,
          start_ms: shot.start_ms,
          end_ms: Math.min(shot.end_ms, asset.duration_ms || shot.end_ms),
          representative_frame_ms: shot.representative_frame_ms,
          ...(shot.change_score === undefined ? {} : { change_score: shot.change_score }),
          model_run_id: runId,
        });
      }
    }
  } else {
    unavailable.push({ stage: 'shots', reason: 'no model is configured for it' });
  }

  // ---- audio ---------------------------------------------------------------
  if (options.suite.audio) {
    const audio = options.suite.audio;
    const runId = options.runs.fromIdentity('audio', audio.identity);
    let done = 0;
    for (const asset of ordered) {
      if (asset.kind === 'image') continue;
      const audioPath =
        derived.get(asset.id)?.audio_path ?? absolutePath(asset, options.projectRoot);
      options.onProgress?.('audio', asset.file_name, done++, ordered.length);

      const params = {
        audio_path: audioPath,
        hop_ms: options.audioHopMs ?? 100,
        silence_threshold_db: -40,
        classify_events: true,
      };
      let result: Awaited<ReturnType<typeof audio.analyzeAudio>> | undefined;
      await attempt('audio', asset.id, async () => {
        result = await cached(
          options.cache,
          keyFor('analyze_audio', asset, audio.identity, params),
          () => audio.analyzeAudio(params),
        );
      });
      if (!result) continue;

      for (const event of result.events) {
        if (event.end_ms <= event.start_ms) continue;
        audioEvents.push({
          id: seqId('aev', ++counters.aev, 5),
          asset_id: asset.id,
          start_ms: event.start_ms,
          end_ms: event.end_ms,
          event_type: event.event_type,
          ...(event.raw_label === undefined ? {} : { raw_label: event.raw_label }),
          confidence: event.confidence,
          model_run_id: runId,
        });
      }

      audioProfiles.push({
        asset_id: asset.id,
        hop_ms: result.hop_ms,
        rms_db: result.rms_db,
        ...(result.speech_prob === undefined ? {} : { speech_prob: result.speech_prob }),
        model_run_id: runId,
      });
    }
  } else {
    unavailable.push({ stage: 'audio', reason: 'no model is configured for it' });
  }

  // ---- visual --------------------------------------------------------------
  if (options.suite.visual) {
    const visual = options.suite.visual;
    const runId = options.runs.fromIdentity('visual', visual.identity);
    await scheduler.withModel('visual', async () => {
      let done = 0;
      for (const asset of ordered) {
        const prepared = derived.get(asset.id);
        const timestamps = frameTimestamps(prepared, shots, asset.id);
        if (timestamps.length === 0) continue;
        options.onProgress?.('visual', asset.file_name, done++, ordered.length);

        const params = {
          path: prepared?.proxy_path ?? absolutePath(asset, options.projectRoot),
          timestamps_ms: timestamps,
          label_vocabulary: [],
        };
        let result: Awaited<ReturnType<typeof visual.embedFrames>> | undefined;
        await attempt('visual', asset.id, async () => {
          result = await cached(
            options.cache,
            keyFor('embed_frames', asset, visual.identity, params),
            () => visual.embedFrames(params),
          );
        });
        if (!result) continue;

        for (const frame of result.frames) {
          const ref = `${asset.id}:${frame.timestamp_ms}`;
          if (frame.vector.length > 0) frameVectors.set(ref, frame.vector);
          frameFeatures.push({
            id: seqId('frm', ++counters.frm, 6),
            asset_id: asset.id,
            timestamp_ms: frame.timestamp_ms,
            labels: frame.labels,
            ...(frame.sharpness === undefined ? {} : { sharpness: frame.sharpness }),
            ...(frame.exposure === undefined ? {} : { exposure: frame.exposure }),
            ...(frame.motion === undefined ? {} : { motion: frame.motion }),
            embedding_ref: ref,
            model_run_id: runId,
          });
        }
      }
    });
  } else {
    unavailable.push({ stage: 'visual', reason: 'no model is configured for it' });
  }

  // ---- ocr -----------------------------------------------------------------
  if (options.suite.ocr) {
    const reader = options.suite.ocr;
    const runId = options.runs.fromIdentity('ocr', reader.identity);
    await scheduler.withModel('ocr', async () => {
      let done = 0;
      for (const asset of ordered) {
        const prepared = derived.get(asset.id);
        const timestamps = representativeFrames(shots, asset.id);
        if (timestamps.length === 0) continue;
        options.onProgress?.('ocr', asset.file_name, done++, ordered.length);

        const params = {
          path: prepared?.proxy_path ?? absolutePath(asset, options.projectRoot),
          timestamps_ms: timestamps,
          // Inside the project, never beside the footage. Excluded from the
          // cache key along with the other paths, because where the frames went
          // is not part of what was read.
          frames_dir: join(options.workDir, asset.sha256.slice(0, 12), 'ocr-frames'),
          ...(options.context?.editing_goal.language
            ? { language: options.context.editing_goal.language }
            : {}),
        };
        let result: Awaited<ReturnType<typeof reader.ocr>> | undefined;
        await attempt('ocr', asset.id, async () => {
          result = await cached(options.cache, keyFor('ocr', asset, reader.identity, params), () =>
            reader.ocr(params),
          );
        });
        if (!result) continue;

        for (const observation of result.observations) {
          if (observation.text.trim().length === 0) continue;
          ocr.push({
            id: seqId('ocr', ++counters.ocr, 5),
            asset_id: asset.id,
            start_ms: observation.start_ms,
            end_ms: Math.max(observation.end_ms, observation.start_ms + 1),
            text: observation.text,
            confidence: observation.confidence,
            ...(observation.bbox === undefined ? {} : { bbox: observation.bbox }),
            model_run_id: runId,
          });
        }
      }
    });
  } else {
    unavailable.push({ stage: 'ocr', reason: 'no model is configured for it' });
  }

  return {
    observations: {
      ...EMPTY_OBSERVATIONS,
      project_id: '',
      fingerprint: '',
      pipeline_version: PIPELINE_VERSION,
      generated_at: new Date().toISOString(),
      utterances,
      shots,
      audio_events: audioEvents,
      ocr,
      frame_features: frameFeatures,
      audio_profiles: audioProfiles,
    },
    derived,
    frameVectors,
    unavailable,
    failures,
  };
}

/**
 * Cosine similarity between two sampled frames, for segmentation.
 *
 * Returns undefined when either frame was never embedded, so the boundary scorer
 * can renormalise over the signals it actually has rather than reading a missing
 * vector as "these look identical".
 */
export function frameSimilarityFrom(
  frameVectors: Map<string, number[]>,
): (assetId: string, aMs: number, bMs: number) => number | undefined {
  const nearest = new Map<string, number[]>();
  for (const [key, vector] of frameVectors) nearest.set(key, vector);

  const lookup = (assetId: string, ms: number): number[] | undefined => {
    const exact = nearest.get(`${assetId}:${ms}`);
    if (exact) return exact;
    // Frames are sampled, so an exact timestamp rarely matches; take the closest
    // one within a second and give up beyond that.
    let best: number[] | undefined;
    let bestDistance = Infinity;
    for (const [key, vector] of nearest) {
      const separator = key.lastIndexOf(':');
      if (key.slice(0, separator) !== assetId) continue;
      const distance = Math.abs(Number(key.slice(separator + 1)) - ms);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = vector;
      }
    }
    return bestDistance <= 1000 ? best : undefined;
  };

  return (assetId, aMs, bMs) => {
    const a = lookup(assetId, aMs);
    const b = lookup(assetId, bMs);
    if (!a || !b) return undefined;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      dot += x * y;
      normA += x * x;
      normB += y * y;
    }
    if (normA === 0 || normB === 0) return undefined;
    return dot / Math.sqrt(normA * normB);
  };
}

/** Where a frame file for a given timestamp was written, when frames were sampled. */
export function framePathFor(
  prepared: PrepareResult | undefined,
  timestampMs: number,
  fps: number,
): string | undefined {
  if (!prepared?.frames_dir) return undefined;
  const index = Math.round((timestampMs * fps) / 1000) + 1;
  return join(prepared.frames_dir, frameFileName(Math.max(1, index)));
}

function frameTimestamps(
  prepared: PrepareResult | undefined,
  shots: readonly Shot[],
  assetId: string,
): number[] {
  // Prefer one frame per shot: it is the frame that represents a decision the
  // camera operator made, rather than an arbitrary sample.
  const perShot = representativeFrames(shots, assetId);
  if (perShot.length > 0) return perShot;
  return prepared?.frame_timestamps_ms ?? [];
}

function representativeFrames(shots: readonly Shot[], assetId: string): number[] {
  return shots
    .filter((shot) => shot.asset_id === assetId)
    .map((shot) => shot.representative_frame_ms)
    .sort((a, b) => a - b);
}

function absolutePath(asset: MediaAsset, projectRoot: string): string {
  return isAbsolute(asset.path) ? asset.path : resolve(projectRoot, asset.path);
}

function keyFor(
  operation: string,
  asset: MediaAsset,
  identity: { backend: string; model?: string; modelVersion?: string },
  parameters: Record<string, unknown>,
): CacheKeyParts {
  // Paths are excluded from the key: the same media analysed from a different
  // working directory is the same analysis, and including the path would turn
  // every move of a project into a full re-run.
  const {
    audio_path: _audio,
    path: _path,
    frames_dir: _framesDir,
    work_dir: _workDir,
    ...stable
  } = parameters;
  return {
    operation,
    mediaSha256: asset.sha256,
    backend: identity.backend,
    ...(identity.model === undefined ? {} : { model: identity.model }),
    ...(identity.modelVersion === undefined ? {} : { modelVersion: identity.modelVersion }),
    parameters: stable,
    pipelineVersion: PIPELINE_VERSION,
  };
}

async function cached<T>(
  cache: PerceptionCache | undefined,
  key: CacheKeyParts,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = cache?.get<T>(key);
  if (hit !== undefined) return hit;
  const value = await compute();
  cache?.set(key, value);
  return value;
}

export function existsOrUndefined(path: string | undefined): string | undefined {
  return path && existsSync(path) ? path : undefined;
}
