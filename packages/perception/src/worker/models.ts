import type {
  AnalyzeAudioParams,
  AnalyzeAudioResult,
  DescribeParams,
  DescribeResult,
  DetectShotsParams,
  DetectShotsResult,
  EmbedFramesParams,
  EmbedFramesResult,
  HealthResult,
  OcrParams,
  OcrResult,
  PrepareParams,
  PrepareResult,
  ProbeResult,
} from '@editorial-ir/contracts';
import type {
  AudioModel,
  ContextModel,
  MediaPreparer,
  MediaProbe,
  ModelIdentity,
  OcrModel,
  ShotDetector,
  SpeechModel,
  TextEmbeddingModel,
  VisualEmbeddingModel,
} from '../types.js';
import type { PythonWorkerClient } from './client.js';

/**
 * Model implementations that delegate to the Python worker.
 *
 * Each is a thin shim, and that is the point: the worker owns the machine
 * learning, the contract owns the shape, and nothing in between gets to have an
 * opinion of its own.
 */

function identity(model: string, extra: Partial<ModelIdentity> = {}): ModelIdentity {
  return {
    backend: 'python-worker',
    model,
    locality: 'local',
    mediaLeavesDevice: false,
    ...extra,
  };
}

/** Minutes, because the first call to a model includes downloading and loading it. */
const LONG_TIMEOUT_MS = 30 * 60_000;

export class WorkerMediaProbe implements MediaProbe {
  readonly identity = identity('ffprobe');
  constructor(private readonly client: PythonWorkerClient) {}
  async probe(path: string): Promise<ProbeResult> {
    return this.client.request('probe', { path }, { timeoutMs: 120_000 });
  }
}

export class WorkerMediaPreparer implements MediaPreparer {
  readonly identity = identity('ffmpeg');
  constructor(private readonly client: PythonWorkerClient) {}
  async prepare(params: PrepareParams): Promise<PrepareResult> {
    return this.client.request('prepare', params, { timeoutMs: LONG_TIMEOUT_MS });
  }
}

export class WorkerSpeechModel implements SpeechModel {
  readonly identity: ModelIdentity;
  constructor(
    private readonly client: PythonWorkerClient,
    model = 'asr',
  ) {
    this.identity = identity(model);
  }
  async transcribe(params: TranscribeParamsLike): Promise<TranscribeResultLike> {
    return this.client.request('transcribe', params, { timeoutMs: LONG_TIMEOUT_MS });
  }
}

type TranscribeParamsLike = Parameters<SpeechModel['transcribe']>[0];
type TranscribeResultLike = Awaited<ReturnType<SpeechModel['transcribe']>>;

export class WorkerShotDetector implements ShotDetector {
  readonly identity = identity('scene-detect');
  constructor(private readonly client: PythonWorkerClient) {}
  async detectShots(params: DetectShotsParams): Promise<DetectShotsResult> {
    return this.client.request('detect_shots', params, { timeoutMs: LONG_TIMEOUT_MS });
  }
}

export class WorkerVisualEmbeddingModel implements VisualEmbeddingModel {
  readonly identity: ModelIdentity;
  /** Learned from the first response; the worker owns the real value. */
  dim = 0;
  constructor(
    private readonly client: PythonWorkerClient,
    model = 'visual-embedding',
  ) {
    this.identity = identity(model);
  }
  async embedFrames(params: EmbedFramesParams): Promise<EmbedFramesResult> {
    const result = await this.client.request('embed_frames', params, {
      timeoutMs: LONG_TIMEOUT_MS,
    });
    this.dim = result.dim;
    return result;
  }
}

export class WorkerAudioModel implements AudioModel {
  readonly identity = identity('audio-tagging');
  constructor(private readonly client: PythonWorkerClient) {}
  async analyzeAudio(params: AnalyzeAudioParams): Promise<AnalyzeAudioResult> {
    return this.client.request('analyze_audio', params, { timeoutMs: LONG_TIMEOUT_MS });
  }
}

export class WorkerOcrModel implements OcrModel {
  readonly identity = identity('ocr');
  constructor(private readonly client: PythonWorkerClient) {}
  async ocr(params: OcrParams): Promise<OcrResult> {
    return this.client.request('ocr', params, { timeoutMs: LONG_TIMEOUT_MS });
  }
}

export class WorkerContextModel implements ContextModel {
  readonly identity: ModelIdentity;
  constructor(
    private readonly client: PythonWorkerClient,
    model = 'vlm',
  ) {
    this.identity = identity(model);
  }
  async describe(params: DescribeParams): Promise<DescribeResult> {
    return this.client.request('describe', params, { timeoutMs: LONG_TIMEOUT_MS });
  }
}

export class WorkerTextEmbeddingModel implements TextEmbeddingModel {
  readonly identity: ModelIdentity;
  dim = 0;
  constructor(
    private readonly client: PythonWorkerClient,
    model = 'text-embedding',
  ) {
    this.identity = identity(model);
  }
  async embed(texts: string[], role: 'query' | 'passage' = 'passage'): Promise<number[][]> {
    const result = await this.client.request(
      'embed_text',
      { texts, role },
      { timeoutMs: LONG_TIMEOUT_MS },
    );
    this.dim = result.dim;
    return result.vectors;
  }
}

export async function workerHealth(client: PythonWorkerClient): Promise<HealthResult> {
  return client.request('health', {}, { timeoutMs: 60_000 });
}
