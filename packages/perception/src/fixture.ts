import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import {
  AnalyzeAudioResult,
  DescribeResult,
  DetectShotsResult,
  EditorialError,
  EmbedFramesResult,
  OcrResult,
  PrepareResult,
  ProbeResult,
  TranscribeResult,
  parseOrThrow,
} from '@editorial-ir/contracts';
import type {
  AudioModel,
  ContextModel,
  MediaPreparer,
  MediaProbe,
  ModelIdentity,
  OcrModel,
  PerceptionSuite,
  ShotDetector,
  SpeechModel,
  VisualEmbeddingModel,
} from './types.js';
import { HashingTextEmbedding } from './text-embedding/hashing.js';

/**
 * Perception replayed from a file.
 *
 * Three jobs, all of them load-bearing:
 *
 * 1. Tests. The compiler, the planner, the validator and every adapter can be
 *    exercised end to end without ffmpeg, a GPU or a network.
 * 2. Trying the product. `oea` runs on a machine with nothing installed, which
 *    is how someone decides whether the idea is worth installing anything for.
 * 3. Benchmarks. Freeze the perception and you can measure a change to
 *    segmentation, scoring or planning without the noise of a model that
 *    answers slightly differently each run.
 */
const AssetFixture = z
  .object({
    probe: ProbeResult.optional(),
    prepare: PrepareResult.optional(),
    transcribe: TranscribeResult.optional(),
    detect_shots: DetectShotsResult.optional(),
    embed_frames: EmbedFramesResult.optional(),
    analyze_audio: AnalyzeAudioResult.optional(),
    ocr: OcrResult.optional(),
  })
  .loose();

export const PerceptionFixture = z
  .object({
    /** Keyed by file name, so a fixture survives being moved between machines. */
    assets: z.record(z.string(), AssetFixture).default({}),
    /** Keyed by event id, for replaying multimodal descriptions. */
    describe: z.record(z.string(), DescribeResult).default({}),
  })
  .loose();
export type PerceptionFixture = z.infer<typeof PerceptionFixture>;

const FIXTURE_IDENTITY: ModelIdentity = {
  backend: 'fixture',
  model: 'replay',
  locality: 'local',
  mediaLeavesDevice: false,
};

export class FixturePerception
  implements MediaProbe, MediaPreparer, SpeechModel, ShotDetector, VisualEmbeddingModel, AudioModel, OcrModel, ContextModel
{
  readonly identity = FIXTURE_IDENTITY;
  dim = 0;

  constructor(private readonly fixture: PerceptionFixture) {}

  static fromFile(path: string): FixturePerception {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new EditorialError('io_error', `could not read perception fixture at ${path}`, {
        cause: String(error),
      });
    }
    return new FixturePerception(parseOrThrow(PerceptionFixture, raw, `perception fixture ${path}`));
  }

  private assetFixture(path: string): z.infer<typeof AssetFixture> {
    const key = basename(path);
    const found = this.fixture.assets[key] ?? this.fixture.assets[path];
    if (!found) {
      throw new EditorialError('not_found', `the perception fixture has no entry for "${key}"`, {
        known: Object.keys(this.fixture.assets),
      });
    }
    return found;
  }

  private require<T>(path: string, field: keyof z.infer<typeof AssetFixture>, value: T | undefined): T {
    if (value === undefined) {
      throw new EditorialError('not_found', `the perception fixture for "${basename(path)}" has no "${field}"`);
    }
    return value;
  }

  async probe(path: string) {
    return this.require(path, 'probe', this.assetFixture(path).probe);
  }

  async prepare(params: { path: string }) {
    // Absent `prepare` is normal: a fixture usually has no derivative files.
    return this.assetFixture(params.path).prepare ?? { frame_timestamps_ms: [] };
  }

  async transcribe(params: { audio_path: string }) {
    return this.require(params.audio_path, 'transcribe', this.assetFixture(params.audio_path).transcribe);
  }

  async detectShots(params: { path: string }) {
    return this.require(params.path, 'detect_shots', this.assetFixture(params.path).detect_shots);
  }

  async embedFrames(params: { path: string }) {
    const result = this.require(params.path, 'embed_frames', this.assetFixture(params.path).embed_frames);
    this.dim = result.dim;
    return result;
  }

  async analyzeAudio(params: { audio_path: string }) {
    return this.require(params.audio_path, 'analyze_audio', this.assetFixture(params.audio_path).analyze_audio);
  }

  async ocr(params: { path: string }) {
    return this.require(params.path, 'ocr', this.assetFixture(params.path).ocr);
  }

  async describe(params: { event_id: string }) {
    const found = this.fixture.describe[params.event_id];
    if (!found) {
      throw new EditorialError('not_found', `the perception fixture has no description for ${params.event_id}`);
    }
    return found;
  }
}

/**
 * A suite that replays a fixture.
 *
 * Only the capabilities the fixture actually carries are exposed. A suite that
 * advertised a visual model and then failed on the first call would be worse
 * than one that admits it has none: the compiler is built to degrade when a
 * model is missing, and it can only do that if it is told the truth.
 */
export function createFixtureSuite(fixture: PerceptionFixture): PerceptionSuite {
  const replay = new FixturePerception(fixture);
  const entries = Object.values(fixture.assets);
  const has = (field: keyof z.infer<typeof AssetFixture>): boolean =>
    entries.length > 0 && entries.some((entry) => entry[field] !== undefined);

  return {
    probe: replay,
    preparer: replay,
    text: new HashingTextEmbedding(),
    ...(has('transcribe') ? { speech: replay } : {}),
    ...(has('detect_shots') ? { shots: replay } : {}),
    ...(has('embed_frames') ? { visual: replay } : {}),
    ...(has('analyze_audio') ? { audio: replay } : {}),
    ...(has('ocr') ? { ocr: replay } : {}),
    ...(Object.keys(fixture.describe).length > 0 ? { context: replay } : {}),
  };
}
