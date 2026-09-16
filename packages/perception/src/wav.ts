import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { EditorialError } from '@editorial-ir/contracts';

/**
 * A minimal RIFF/WAVE reader for the one format this project produces.
 *
 * Reading the prepared 16 kHz mono PCM ourselves is dramatically better than
 * shelling out to ffmpeg for loudness statistics: exact values, no log parsing,
 * no locale surprises, and it works on any machine that got as far as having a
 * WAV file. Long files are read in fixed-size blocks, so an hour of audio costs
 * a megabyte of memory rather than a hundred.
 */
export interface WavFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

const READ_BLOCK_BYTES = 1 << 20;

export function readWavHeader(path: string): WavFormat {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(12);
    if (readSync(fd, head, 0, 12, 0) < 12) {
      throw new EditorialError('media_error', `not a WAV file: ${path}`);
    }
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new EditorialError('media_error', `not a RIFF/WAVE file: ${path}`);
    }

    const fileSize = statSync(path).size;
    let offset = 12;
    let format: Omit<WavFormat, 'dataOffset' | 'dataLength'> | undefined;
    const header = Buffer.alloc(8);

    while (offset + 8 <= fileSize) {
      if (readSync(fd, header, 0, 8, offset) < 8) break;
      const chunkId = header.toString('ascii', 0, 4);
      const chunkSize = header.readUInt32LE(4);
      const body = offset + 8;

      if (chunkId === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(chunkSize, 40));
        readSync(fd, fmt, 0, fmt.length, body);
        format = {
          audioFormat: fmt.readUInt16LE(0),
          channels: fmt.readUInt16LE(2),
          sampleRate: fmt.readUInt32LE(4),
          bitsPerSample: fmt.readUInt16LE(14),
        };
      } else if (chunkId === 'data') {
        if (!format) throw new EditorialError('media_error', `WAV data chunk precedes fmt: ${path}`);
        // A streamed WAV can declare size 0; fall back to what is actually there.
        const dataLength = chunkSize > 0 ? Math.min(chunkSize, fileSize - body) : fileSize - body;
        return { ...format, dataOffset: body, dataLength };
      }

      offset = body + chunkSize + (chunkSize % 2);
    }
    throw new EditorialError('media_error', `WAV file has no data chunk: ${path}`);
  } finally {
    closeSync(fd);
  }
}

export interface HopStatistics {
  hopMs: number;
  /** RMS level per hop, in dBFS. Silence is reported as -100. */
  rmsDb: number[];
  /** Zero-crossing rate per hop, in [0,1]. */
  zcr: number[];
  sampleRate: number;
  durationMs: number;
}

/**
 * Computes per-hop loudness and zero-crossing rate in one pass.
 *
 * Both are needed: loudness alone cannot tell speech from a passing lorry, and
 * zero-crossing rate alone cannot tell speech from silence.
 */
export function computeHopStatistics(path: string, hopMs: number): HopStatistics {
  const format = readWavHeader(path);
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new EditorialError(
      'media_error',
      `expected 16-bit PCM WAV, got format ${format.audioFormat} at ${format.bitsPerSample} bits`,
      { path },
    );
  }

  const bytesPerFrame = 2 * format.channels;
  const framesPerHop = Math.max(1, Math.round((format.sampleRate * hopMs) / 1000));
  const totalFrames = Math.floor(format.dataLength / bytesPerFrame);

  const rmsDb: number[] = [];
  const zcr: number[] = [];

  const fd = openSync(path, 'r');
  try {
    const block = Buffer.alloc(READ_BLOCK_BYTES - (READ_BLOCK_BYTES % bytesPerFrame));
    let position = format.dataOffset;
    let remaining = totalFrames;

    let sumSquares = 0;
    let crossings = 0;
    let framesInHop = 0;
    let previousSample = 0;
    let havePrevious = false;

    while (remaining > 0) {
      const wanted = Math.min(block.length, remaining * bytesPerFrame);
      const read = readSync(fd, block, 0, wanted, position);
      if (read <= 0) break;
      position += read;

      const frames = Math.floor(read / bytesPerFrame);
      for (let f = 0; f < frames; f++) {
        // Mixing to mono keeps the statistics comparable regardless of channel count.
        let sum = 0;
        for (let c = 0; c < format.channels; c++) {
          sum += block.readInt16LE(f * bytesPerFrame + c * 2);
        }
        const sample = sum / format.channels / 32768;

        sumSquares += sample * sample;
        if (havePrevious && previousSample >= 0 !== sample >= 0) crossings++;
        previousSample = sample;
        havePrevious = true;
        framesInHop++;

        if (framesInHop === framesPerHop) {
          rmsDb.push(toDb(Math.sqrt(sumSquares / framesInHop)));
          zcr.push(crossings / framesInHop);
          sumSquares = 0;
          crossings = 0;
          framesInHop = 0;
        }
      }
      remaining -= frames;
    }

    if (framesInHop > 0) {
      rmsDb.push(toDb(Math.sqrt(sumSquares / framesInHop)));
      zcr.push(crossings / framesInHop);
    }
  } finally {
    closeSync(fd);
  }

  return {
    hopMs,
    rmsDb,
    zcr,
    sampleRate: format.sampleRate,
    durationMs: Math.round((totalFrames / format.sampleRate) * 1000),
  };
}

export function toDb(amplitude: number): number {
  if (amplitude <= 1e-10) return -100;
  return Math.max(-100, 20 * Math.log10(amplitude));
}
