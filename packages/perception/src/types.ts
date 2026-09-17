import type {
  AnalyzeAudioParams,
  AnalyzeAudioResult,
  DescribeParams,
  DescribeResult,
  DetectShotsParams,
  DetectShotsResult,
  EmbedFramesParams,
  EmbedFramesResult,
  ExecutionLocality,
  HealthResult,
  OcrParams,
  OcrResult,
  PrepareParams,
  PrepareResult,
  ProbeResult,
  TranscribeParams,
  TranscribeResult,
} from '@editorial-ir/contracts';

/**
 * Perception is where existing technology belongs.
 *
 * Nothing in this project tries to be a better speech recogniser or a better
 * vision model. What it does insist on is that every one of them sits behind an
 * interface, so that swapping Whisper for something else next year is a
 * configuration change rather than a migration.
 */

/** Everything needed to attribute a result to a model and to cost it. */
export interface ModelIdentity {
  /** Implementation id, e.g. `python-worker`, `ffprobe`, `hashing`. */
  readonly backend: string;
  /** Opaque model name as reported by the backend, when there is one. */
  readonly model?: string;
  readonly modelVersion?: string;
  readonly locality: ExecutionLocality;
  /** True when media or media-derived content leaves the machine. Surfaced to the user. */
  readonly mediaLeavesDevice: boolean;
  /** Parameters that change the output, and therefore the cache key. */
  readonly parameters?: Record<string, unknown>;
}

export interface PerceptionModel {
  readonly identity: ModelIdentity;
}

/** Reads container metadata. Never decodes more than it must. */
export interface MediaProbe extends PerceptionModel {
  probe(path: string): Promise<ProbeResult>;
}

/** Produces the cheap derivatives everything downstream reads: proxy, audio, frames. */
export interface MediaPreparer extends PerceptionModel {
  prepare(params: PrepareParams): Promise<PrepareResult>;
}

export interface SpeechModel extends PerceptionModel {
  transcribe(params: TranscribeParams): Promise<TranscribeResult>;
}

export interface ShotDetector extends PerceptionModel {
  detectShots(params: DetectShotsParams): Promise<DetectShotsResult>;
}

export interface VisualEmbeddingModel extends PerceptionModel {
  readonly dim: number;
  embedFrames(params: EmbedFramesParams): Promise<EmbedFramesResult>;
}

export interface AudioModel extends PerceptionModel {
  analyzeAudio(params: AnalyzeAudioParams): Promise<AnalyzeAudioResult>;
}

export interface OcrModel extends PerceptionModel {
  ocr(params: OcrParams): Promise<OcrResult>;
}

/**
 * The multimodal model that says what an event *is*.
 *
 * This is the expensive one, and it is called per event rather than per video.
 * Its output is not Editorial IR — it still has to be validated, attributed and
 * reconciled with user knowledge before it becomes canonical.
 */
export interface ContextModel extends PerceptionModel {
  describe(params: DescribeParams): Promise<DescribeResult>;
}

export interface TextEmbeddingModel extends PerceptionModel {
  readonly dim: number;
  /**
   * True when similarity from this encoder comes only from shared surface forms.
   *
   * A hashing vectoriser is lexical: two texts with no feature in common can
   * only score above zero through a hash collision. Retrieval uses this to throw
   * those away, because a collision is noise dressed as evidence — searching for
   * ラーメン otherwise returns 最高だった at a confident-looking 0.29.
   *
   * A real embedding model must leave this unset. Finding "night view" for 夜景
   * with nothing in common is exactly what it is for.
   */
  readonly lexical?: boolean;
  embed(texts: string[], role?: 'query' | 'passage'): Promise<number[][]>;
}

/**
 * The set of models a run has available.
 *
 * Every model except the probe is optional, and the compiler degrades instead of
 * failing: a machine with no GPU and no API key still produces an Editorial IR,
 * with fewer observations and honestly lower confidence.
 */
export interface PerceptionSuite {
  readonly probe: MediaProbe;
  readonly preparer?: MediaPreparer;
  readonly speech?: SpeechModel;
  readonly shots?: ShotDetector;
  readonly visual?: VisualEmbeddingModel;
  readonly audio?: AudioModel;
  readonly ocr?: OcrModel;
  readonly context?: ContextModel;
  readonly text: TextEmbeddingModel;
  /** Reports what is actually available, for `oea doctor`. */
  health?(): Promise<HealthResult>;
  /** Releases subprocesses and model memory. */
  close?(): Promise<void>;
}

export type PerceptionCapability =
  'probe' | 'prepare' | 'speech' | 'shots' | 'visual' | 'audio' | 'ocr' | 'context' | 'text';

export function availableCapabilities(suite: PerceptionSuite): PerceptionCapability[] {
  const caps: PerceptionCapability[] = ['probe', 'text'];
  if (suite.preparer) caps.push('prepare');
  if (suite.speech) caps.push('speech');
  if (suite.shots) caps.push('shots');
  if (suite.visual) caps.push('visual');
  if (suite.audio) caps.push('audio');
  if (suite.ocr) caps.push('ocr');
  if (suite.context) caps.push('context');
  return caps;
}

/**
 * Whether a base URL names this machine.
 *
 * Three copies of this regex had grown, one per backend, and the one place that
 * needed it most had none: the Python worker's context model hardcoded
 * `locality: 'local'` whatever endpoint its `describe` was pointed at.
 */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

export function isLocalEndpoint(baseUrl: string | undefined): boolean {
  return baseUrl === undefined || LOOPBACK.test(baseUrl);
}

/** What a backend should record about where it ran, given the endpoint it uses. */
export function localityOf(baseUrl: string | undefined): {
  locality: ExecutionLocality;
  remote: boolean;
} {
  const remote = !isLocalEndpoint(baseUrl);
  return { locality: remote ? 'remote_api' : 'local', remote };
}
