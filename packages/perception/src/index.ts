/**
 * @editorial-ir/perception
 *
 * Interfaces for every model the pipeline can use, the media ingestion that
 * needs only ffmpeg, and the transport to the Python runtime where the heavy
 * machine learning lives.
 *
 * The rule this package exists to enforce: no stage above it ever names a model.
 */
export * from './types.js';
export * from './command.js';
export * from './wav.js';
export * from './scheduler.js';
export * from './suite.js';
export * from './fixture.js';
export { FfprobeMediaProbe, toProbeResult, parseRational } from './ffmpeg/probe.js';
export {
  FfmpegMediaPreparer,
  AUDIO_SAMPLE_RATE,
  proxyArgs,
  audioArgs,
  frameArgs,
  frameTimestampMs,
  frameFileName,
} from './ffmpeg/prepare.js';
export { FfmpegShotDetector, sceneArgs, parseShowinfoTimes, buildShots } from './ffmpeg/shots.js';
export {
  WavAudioAnalyzer,
  analyseHops,
  silenceThreshold,
  hasDynamicRange,
  speechProbability,
  percentile,
  runsOf,
} from './ffmpeg/audio.js';
export { HashingTextEmbedding, normalizeText, fnv1a, l2normalize } from './text-embedding/hashing.js';
export { OpenAiCompatibleTextEmbedding } from './text-embedding/openai-compatible.js';
export {
  HeuristicContextModel,
  describeFromObservations,
  inferEventType,
  inferAffect,
  keywordsOf,
} from './context/heuristic.js';
export { OpenAiCompatibleContextModel, buildPrompt, toDataUrl } from './context/openai-compatible.js';
export { PythonWorkerClient, type PythonWorkerOptions } from './worker/client.js';
export * from './worker/models.js';
