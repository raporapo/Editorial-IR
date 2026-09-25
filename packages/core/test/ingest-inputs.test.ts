import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProbeResult } from '@editorial-ir/contracts';
import type { MediaProbe } from '@editorial-ir/perception';
import { ingestPaths } from '../src/index.js';

/**
 * What ingest accepts, and where it puts what it accepts.
 *
 * Each case here was a folder that ingested wrongly or not at all: footage
 * assembled from links to a card registered nothing, a TypeScript file named
 * `.ts` was an MPEG transport stream that could not be read, one photo without
 * a date put a day of clips in file-name order, and a camera's zone-less time
 * was read as UTC and sorted nine hours out.
 */

function folder(): string {
  return mkdtempSync(join(tmpdir(), 'oea-ingest-inputs-'));
}

class TableProbe implements MediaProbe {
  readonly identity = {
    backend: 'table',
    model: 'ffprobe',
    locality: 'local' as const,
    mediaLeavesDevice: false,
  };
  constructor(private readonly table: Record<string, ProbeResult>) {}
  async probe(path: string): Promise<ProbeResult> {
    const found = this.table[basename(path)];
    if (!found) throw new Error(`ffprobe failed\n${basename(path)}: moov atom not found`);
    return found;
  }
}

const video = (extra: Partial<ProbeResult> = {}): ProbeResult => ({
  duration_ms: 5000,
  width: 1280,
  height: 720,
  video_codec: 'h264',
  audio_streams: [],
  metadata: {},
  ...extra,
});

/** A JPEG whose APP1 holds an EXIF DateTimeOriginal, and optionally its offset. */
function jpegTakenAt(date: string, offset?: string): Uint8Array {
  const tags: [number, string][] = [
    [0x9003, date],
    ...(offset ? [[0x9011, offset] as [number, string]] : []),
  ];
  const bytes: number[] = [0x49, 0x49, 42, 0, 8, 0, 0, 0];
  const push16 = (v: number) => bytes.push(v & 0xff, v >> 8);
  const push32 = (v: number) => bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24);
  const exifAt = 8 + 2 + 12 + 4;
  push16(1);
  push16(0x8769);
  push16(4);
  push32(1);
  push32(exifAt);
  push32(0);
  const data: number[] = [];
  const dataAt = exifAt + 2 + tags.length * 12 + 4;
  push16(tags.length);
  for (const [tag, value] of tags) {
    const encoded = [...Buffer.from(`${value}\0`, 'latin1')];
    push16(tag);
    push16(2);
    push32(encoded.length);
    push32(dataAt + data.length);
    data.push(...encoded);
  }
  push32(0);
  const app1 = [...Buffer.from('Exif\0\0', 'latin1'), ...bytes, ...data];
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe1,
    (app1.length + 2) >> 8,
    (app1.length + 2) & 0xff,
    ...app1,
    0xff,
    0xd9,
  ]);
}

describe('capture times at ingest', () => {
  it("reads a JPEG's EXIF date, which ffprobe does not, and invents no zone for it", async () => {
    const root = folder();
    writeFileSync(join(root, 'IMG_0042.JPG'), jpegTakenAt('2026:05:17 18:05:00'));
    writeFileSync(join(root, 'IMG_0043.JPG'), jpegTakenAt('2026:05:17 18:06:00', '+09:00'));
    const probe = new TableProbe({
      'IMG_0042.JPG': { duration_ms: 40, width: 4032, video_codec: 'mjpeg', metadata: {} },
      'IMG_0043.JPG': { duration_ms: 40, width: 4032, video_codec: 'mjpeg', metadata: {} },
    });
    const { added } = await ingestPaths([root], { projectRoot: root, probe });
    expect(added[0]?.creation_time).toBeUndefined();
    expect(added[0]?.capture_time).toEqual({
      source: 'exif',
      precision: 'local',
      raw: '2026:05:17 18:05:00',
      local: '2026-05-17T18:05:00.000',
    });
    expect(added[1]?.creation_time).toBe('2026-05-17T09:06:00.000Z');
    expect(added[1]?.capture_time).toMatchObject({ precision: 'instant', utc_offset_minutes: 540 });
  });

  it('keeps a year as a date, and never as midnight on New Year', async () => {
    const root = folder();
    writeFileSync(join(root, 'ep12.mp3'), 'audio');
    const probe = new TableProbe({
      'ep12.mp3': { duration_ms: 60_000, audio_codec: 'mp3', creation_time: '2026', metadata: {} },
    });
    const { added } = await ingestPaths([root], { projectRoot: root, probe });
    expect(added[0]?.creation_time).toBeUndefined();
    expect(added[0]?.capture_time).toEqual({
      source: 'container',
      precision: 'date',
      raw: '2026',
      date: '2026',
    });
  });

  it("says a time came from Apple's creationdate, which keeps its place through a trim", async () => {
    const root = folder();
    writeFileSync(join(root, 'IMG_0041.MOV'), 'clip');
    const probe = new TableProbe({
      'IMG_0041.MOV': video({
        creation_time: '2026-05-17T18:00:00+0900',
        metadata: {
          'com.apple.quicktime.creationdate': '2026-05-17T18:00:00+0900',
          creation_time: '2026-05-18T00:00:00.000000Z',
        },
      }),
    });
    const { added } = await ingestPaths([root], { projectRoot: root, probe });
    expect(added[0]?.creation_time).toBe('2026-05-17T09:00:00.000Z');
    expect(added[0]?.capture_time).toMatchObject({
      source: 'quicktime',
      local: '2026-05-17T18:00:00.000',
      utc_offset_minutes: 540,
    });
  });

  it('stores the start timecode of a clip, and none for a still', async () => {
    const root = folder();
    writeFileSync(join(root, 'A001.MOV'), 'clip');
    writeFileSync(join(root, 'still.png'), 'still');
    const probe = new TableProbe({
      'A001.MOV': video({ start_timecode: '01:00:00;00' }),
      'still.png': { duration_ms: 0, width: 800, start_timecode: '00:00:00:00', metadata: {} },
    });
    const { added } = await ingestPaths([root], { projectRoot: root, probe });
    expect(added.find((a) => a.file_name === 'A001.MOV')?.start_timecode).toBe('01:00:00;00');
    expect(added.find((a) => a.file_name === 'still.png')?.start_timecode).toBeUndefined();
  });
});
