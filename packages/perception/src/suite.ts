import type { PerceptionSuite } from './types.js';
import { NodeCommandRunner, type CommandRunner } from './command.js';
import { FfprobeMediaProbe } from './ffmpeg/probe.js';
import { FfmpegMediaPreparer } from './ffmpeg/prepare.js';
import { FfmpegShotDetector } from './ffmpeg/shots.js';
import { WavAudioAnalyzer } from './ffmpeg/audio.js';
import { HashingTextEmbedding } from './text-embedding/hashing.js';
import { HeuristicContextModel } from './context/heuristic.js';

/**
 * The suite that needs nothing but ffmpeg.
 *
 * No Python, no GPU, no network, no API key. It sees shots, loudness, silence
 * and on-screen nothing, and it understands events only as well as a rule can —
 * but it produces a real Editorial IR, and every part of it is an interface that
 * a better model can replace one at a time.
 *
 * This is the floor the project guarantees, and keeping that floor working is
 * what stops the architecture from quietly assuming a GPU.
 */
export interface LocalSuiteOptions {
  runner?: CommandRunner;
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  embeddingDim?: number;
}

export function createLocalSuite(options: LocalSuiteOptions = {}): PerceptionSuite {
  const runner = options.runner ?? new NodeCommandRunner();
  const ffmpeg = options.ffmpegBinary ?? 'ffmpeg';
  const ffprobe = options.ffprobeBinary ?? 'ffprobe';

  return {
    probe: new FfprobeMediaProbe({ runner, binary: ffprobe }),
    preparer: new FfmpegMediaPreparer({ runner, binary: ffmpeg }),
    shots: new FfmpegShotDetector({ runner, binary: ffmpeg }),
    audio: new WavAudioAnalyzer(),
    context: new HeuristicContextModel(),
    text: new HashingTextEmbedding(options.embeddingDim ? { dim: options.embeddingDim } : {}),
    // Speech, visual embeddings and OCR are absent by design: they need models,
    // and the compiler degrades honestly rather than failing.
  };
}
