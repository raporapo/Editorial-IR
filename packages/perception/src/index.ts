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
export {
  FfprobeMediaProbe,
  toProbeResult,
  parseRational,
  pictureStream,
  isStillFormat,
  frameRates,
  PROBE_VERSION,
  MAX_NOMINAL_FPS,
  VFR_TOLERANCE,
  type FfprobeOutput,
  type FfprobeStream,
} from './ffmpeg/probe.js';
export {
  FfmpegMediaPreparer,
  AUDIO_SAMPLE_RATE,
  PROXY_MAX_FPS,
  proxyArgs,
  audioArgs,
  frameArgs,
  frameTimestampMs,
  frameFileName,
  frameTimestampsIn,
  framesDirName,
  proxyFileName,
  proxyFrameRate,
  audioFileName,
  measureSpeech,
  speechOf,
  chooseAudioStream,
  type StreamSpeech,
} from './ffmpeg/prepare.js';
export {
  FfmpegShotDetector,
  FFMPEG_SCENE_SCALE,
  sceneArgs,
  parseShowinfoTimes,
  buildShots,
} from './ffmpeg/shots.js';
export {
  WavAudioAnalyzer,
  analyseHops,
  silenceThreshold,
  hasDynamicRange,
  speechProbability,
  percentile,
  runsOf,
} from './ffmpeg/audio.js';
export {
  FfmpegVideoAnalyzer,
  analyseSamples,
  cellMaxDifference,
  motionArgs,
  MOTION_WIDTH,
  MOTION_HEIGHT,
} from './ffmpeg/video.js';
export {
  HashingTextEmbedding,
  normalizeText,
  fnv1a,
  l2normalize,
} from './text-embedding/hashing.js';
export { OpenAiCompatibleTextEmbedding } from './text-embedding/openai-compatible.js';
export {
  HeuristicContextModel,
  describeFromObservations,
  inferEventType,
  inferAffect,
  keywordsOf,
} from './context/heuristic.js';
export {
  OpenAiCompatibleContextModel,
  buildPrompt,
  toDataUrl,
} from './context/openai-compatible.js';
export { PythonWorkerClient, type PythonWorkerOptions } from './worker/client.js';
export * from './worker/models.js';
