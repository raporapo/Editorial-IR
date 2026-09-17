import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WavAudioAnalyzer, computeHopStatistics, readWavHeader, toDb } from '../src/index.js';

/**
 * The WAV reader, against real files.
 *
 * Reading the prepared audio directly rather than parsing ffmpeg's log output is
 * what makes loudness exact and bounded in memory. It is also the one place in
 * the project that parses a binary format by hand, so it is worth testing
 * against bytes rather than against a mock.
 */
const directory = mkdtempSync(join(tmpdir(), 'editorial-ir-wav-'));

/** Writes a 16-bit mono PCM WAV from a sample generator. */
function writeWav(name: string, sampleRate: number, samples: number[]): string {
  const path = join(directory, name);
  const data = Buffer.alloc(samples.length * 2);
  for (const [index, sample] of samples.entries()) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), index * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

function tone(sampleRate: number, seconds: number, hz: number, amplitude: number): number[] {
  const samples: number[] = [];
  for (let i = 0; i < sampleRate * seconds; i++) {
    samples.push(amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate));
  }
  return samples;
}

function silence(sampleRate: number, seconds: number): number[] {
  return new Array(Math.round(sampleRate * seconds)).fill(0);
}

describe('readWavHeader', () => {
  it('reads the format this project produces', () => {
    const path = writeWav('tone.wav', 16_000, tone(16_000, 0.5, 440, 0.5));
    const header = readWavHeader(path);
    expect(header).toMatchObject({
      audioFormat: 1,
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
    });
    expect(header.dataLength).toBe(16_000 * 0.5 * 2);
  });

  it('refuses something that is not a WAV', () => {
    const path = join(directory, 'not-a-wav.wav');
    writeFileSync(path, 'this is a text file');
    expect(() => readWavHeader(path)).toThrow(/RIFF|WAV/);
  });
});

describe('computeHopStatistics', () => {
  it('measures loudness that matches the amplitude that was written', () => {
    const path = writeWav('loud.wav', 16_000, tone(16_000, 1, 440, 0.5));
    const stats = computeHopStatistics(path, 100);

    expect(stats.rmsDb).toHaveLength(10);
    // A sine at half scale has an RMS of 0.5/sqrt(2), which is about -9 dBFS.
    for (const db of stats.rmsDb) expect(db).toBeCloseTo(-9, 0);
  });

  it('measures the zero-crossing rate of a known frequency', () => {
    const path = writeWav('pitch.wav', 16_000, tone(16_000, 1, 400, 0.5));
    const stats = computeHopStatistics(path, 100);
    // 400 Hz crosses zero 800 times a second, which at 16 kHz is 0.05 per sample.
    for (const zcr of stats.zcr) expect(zcr).toBeCloseTo(0.05, 2);
  });

  it('reports digital silence as the floor', () => {
    const path = writeWav('quiet.wav', 16_000, silence(16_000, 0.5));
    const stats = computeHopStatistics(path, 100);
    for (const db of stats.rmsDb) expect(db).toBe(-100);
  });

  it('gets the duration right', () => {
    const path = writeWav('duration.wav', 16_000, tone(16_000, 2.5, 200, 0.2));
    expect(computeHopStatistics(path, 100).durationMs).toBe(2500);
  });

  it('handles a file whose length is not a whole number of hops', () => {
    const path = writeWav('ragged.wav', 16_000, tone(16_000, 0.25, 440, 0.4));
    const stats = computeHopStatistics(path, 100);
    // Two and a half hops: the remainder is still measured rather than dropped.
    expect(stats.rmsDb).toHaveLength(3);
  });

  it('reads a file larger than one internal block', () => {
    // Enough samples to cross the read-block boundary, which is where an
    // off-by-one in the streaming loop would show.
    const path = writeWav('long.wav', 16_000, tone(16_000, 40, 300, 0.3));
    const stats = computeHopStatistics(path, 100);
    expect(stats.rmsDb).toHaveLength(400);
    for (const db of stats.rmsDb) expect(db).toBeCloseTo(-13.5, 0);
  });
});

describe('WavAudioAnalyzer', () => {
  it('finds the quiet stretch between two sounds', async () => {
    const path = writeWav('speechlike.wav', 16_000, [
      ...tone(16_000, 1, 300, 0.4),
      ...silence(16_000, 1),
      ...tone(16_000, 1, 300, 0.4),
    ]);

    const result = await new WavAudioAnalyzer().analyzeAudio({
      audio_path: path,
      hop_ms: 100,
      silence_threshold_db: -40,
      classify_events: true,
    });

    const quiet = result.events.filter((event) => event.event_type === 'silence');
    expect(quiet).toHaveLength(1);
    expect(quiet[0]!.start_ms).toBeCloseTo(1000, -2);
    expect(quiet[0]!.end_ms).toBeCloseTo(2000, -2);
  });

  it('reports itself as local, so the privacy report is accurate', () => {
    const analyzer = new WavAudioAnalyzer();
    expect(analyzer.identity.locality).toBe('local');
    expect(analyzer.identity.mediaLeavesDevice).toBe(false);
  });
});

describe('toDb', () => {
  it('maps amplitude to decibels, with a floor', () => {
    expect(toDb(1)).toBeCloseTo(0, 6);
    expect(toDb(0.5)).toBeCloseTo(-6.02, 1);
    expect(toDb(0)).toBe(-100);
  });
});
