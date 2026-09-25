import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MediaAsset, ProbeResult } from '@editorial-ir/contracts';
import type { MediaProbe } from '@editorial-ir/perception';
import {
  captureClockFor,
  captureStartsApartMs,
  findMedia,
  ingestPaths,
  isMediaFile,
  placeAssets,
} from '../src/index.js';

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

function asset(id: string, fileName: string, extra: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    path: `footage/${fileName}`,
    file_name: fileName,
    kind: 'video',
    sha256: id.replace(/\D/g, '').padStart(64, '0'),
    byte_size: 1,
    duration_ms: 5000,
    metadata: {},
    ...extra,
  };
}

const order = (assets: MediaAsset[]) => {
  const names = new Map(assets.map((a) => [a.id, a.file_name]));
  return placeAssets(assets).map((p) => names.get(p.asset_id));
};

describe('finding media in a folder', () => {
  it('follows links to files and to folders, which is how footage on a card is gathered', () => {
    // Dirent.isFile() is false for a link, so a folder of links registered
    // nothing at all.
    const card = folder();
    writeFileSync(join(card, 'C0001.MP4'), 'clip');
    mkdirSync(join(card, 'DCIM'));
    writeFileSync(join(card, 'DCIM', 'IMG_0001.JPG'), 'photo');
    const project = folder();
    symlinkSync(join(card, 'C0001.MP4'), join(project, 'C0001.MP4'));
    symlinkSync(join(card, 'DCIM'), join(project, 'DCIM'));
    expect(findMedia(project).map((path) => path.slice(project.length + 1))).toEqual([
      'C0001.MP4',
      'DCIM/IMG_0001.JPG',
    ]);
  });

  it('walks a folder once, however many links lead back to it', () => {
    const dir = folder();
    writeFileSync(join(dir, 'a.mov'), 'clip');
    symlinkSync(dir, join(dir, 'again'));
    expect(findMedia(dir)).toHaveLength(1);
  });

  it('lists a link to nothing, so it is reported rather than silently skipped', () => {
    const dir = folder();
    symlinkSync(join(dir, 'gone.mp4'), join(dir, 'broken.mp4'));
    expect(findMedia(dir).map((path) => basename(path))).toEqual(['broken.mp4']);
  });

  it("skips dot-files, macOS's ._ shadows included", () => {
    const dir = folder();
    writeFileSync(join(dir, '._C0001.MP4'), 'resource fork');
    writeFileSync(join(dir, 'C0001.MP4'), 'clip');
    expect(findMedia(dir).map((path) => basename(path))).toEqual(['C0001.MP4']);
  });

  it('tells a transport stream from a TypeScript file, though both are .ts', () => {
    const dir = folder();
    const packets = new Uint8Array(188 * 3);
    packets[0] = packets[188] = packets[376] = 0x47;
    writeFileSync(join(dir, 'stream.ts'), packets);
    const m2ts = new Uint8Array(192 * 3);
    m2ts[4] = m2ts[196] = m2ts[388] = 0x47;
    writeFileSync(join(dir, 'avchd.ts'), m2ts);
    writeFileSync(join(dir, 'index.ts'), 'export const answer = 42;\n');
    expect(isMediaFile(join(dir, 'stream.ts'))).toBe(true);
    expect(isMediaFile(join(dir, 'index.ts'))).toBe(false);
    expect(findMedia(dir).map((path) => basename(path))).toEqual(['avchd.ts', 'stream.ts']);
  });

  it('accepts the broadcast, camera, audio and still containers by name', () => {
    const dir = folder();
    const names = [
      'a.mxf',
      'b.mpg',
      'c.mpeg',
      'd.mts',
      'e.m2ts',
      'f.3gp',
      'g.3g2',
      'h.aif',
      'i.aiff',
      'j.caf',
      'k.opus',
      'l.ogg',
      'm.oga',
      'n.flac',
      'o.webp',
      'p.avif',
      'q.heif',
      'r.heic',
    ];
    for (const name of names) writeFileSync(join(dir, name), 'x');
    expect(findMedia(dir).map((path) => basename(path))).toEqual(names);
  });
});

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

describe('a HEIC the installed ffmpeg cannot read', () => {
  it('is reported as that, with what would fix it, not as a corrupt file', async () => {
    const root = folder();
    const heic = Uint8Array.from([
      0,
      0,
      0,
      24,
      ...Buffer.from('ftypheic', 'latin1'),
      0,
      0,
      0,
      0,
      ...Buffer.from('mif1heic', 'latin1'),
    ]);
    writeFileSync(join(root, 'IMG_0001.HEIC'), heic);
    writeFileSync(join(root, 'broken.mp4'), 'not a movie');
    const { failed } = await ingestPaths([root], { projectRoot: root, probe: new TableProbe({}) });
    const photo = failed.find((f) => f.path.endsWith('IMG_0001.HEIC'));
    expect(photo?.reason).toBe(
      'a HEIF/HEIC photo, and the installed ffmpeg cannot read HEIF (ffprobe: moov atom not found)',
    );
    expect(photo?.fix).toMatch(/FFmpeg 7\.1 or newer.*JPEG/);
    // A file that is not a HEIF keeps its own reason.
    expect(failed.find((f) => f.path.endsWith('broken.mp4'))?.fix).toBeUndefined();
  });
});

describe('the capture timeline when some files have no capture time', () => {
  it('keeps the dated clips in capture order when one photo has no date', () => {
    // Measured: B.MOV at 10:00:00 and A.MOV at 10:00:10 were laid out A, B as
    // soon as a photo.jpg without a date joined them.
    const assets = [
      asset('asset_001', 'A.MOV', { creation_time: '2026-05-17T10:00:10.000Z' }),
      asset('asset_002', 'B.MOV', { creation_time: '2026-05-17T10:00:00.000Z' }),
      asset('asset_003', 'photo.jpg', { kind: 'image', duration_ms: 0 }),
    ];
    const placements = placeAssets(assets);
    expect(order(assets)).toEqual(['B.MOV', 'photo.jpg', 'A.MOV']);
    expect(placements.map((p) => p.ordered_by)).toEqual([
      'creation_time',
      'file_name',
      'creation_time',
    ]);
    expect(placements[1]?.beside).toEqual({ asset_id: 'asset_002', side: 'after' });
  });

  it("sets an undated file beside the one its name follows, as a camera's numbering does", () => {
    const assets = [
      asset('asset_001', 'IMG_0040.MOV', { creation_time: '2026-05-17T10:00:00.000Z' }),
      asset('asset_002', 'IMG_0043.MOV', { creation_time: '2026-05-17T10:30:00.000Z' }),
      asset('asset_003', 'IMG_0041.PNG', { kind: 'image', duration_ms: 0 }),
      asset('asset_004', 'IMG_0044.PNG', { kind: 'image', duration_ms: 0 }),
      asset('asset_005', 'AAA_intro.mp4'),
    ];
    expect(order(assets)).toEqual([
      'AAA_intro.mp4',
      'IMG_0040.MOV',
      'IMG_0041.PNG',
      'IMG_0043.MOV',
      'IMG_0044.PNG',
    ]);
    expect(placeAssets(assets)[0]?.beside).toEqual({ asset_id: 'asset_001', side: 'before' });
  });

  it('lays out a project with every file dated, or none, exactly as before', () => {
    const dated = [
      asset('asset_001', 'A.MOV', { creation_time: '2026-05-17T10:00:10.000Z' }),
      asset('asset_002', 'B.MOV', { creation_time: '2026-05-17T10:00:00.000Z' }),
    ];
    expect(placeAssets(dated)).toEqual([
      { asset_id: 'asset_002', offset_ms: 0, order: 0, ordered_by: 'creation_time', clock: 'utc' },
      {
        asset_id: 'asset_001',
        offset_ms: 6000,
        order: 1,
        ordered_by: 'creation_time',
        clock: 'utc',
      },
    ]);
    const undated = [asset('asset_001', 'B.MOV'), asset('asset_002', 'A.MOV')];
    expect(placeAssets(undated)).toEqual([
      { asset_id: 'asset_002', offset_ms: 0, order: 0, ordered_by: 'file_name' },
      { asset_id: 'asset_001', offset_ms: 6000, order: 1, ordered_by: 'file_name' },
    ]);
  });

  it('orders on the wall clock when most files know only that, and the rest agree on one zone', () => {
    // A camera's photos carry no zone; the phone's clips carry +09:00. On the
    // wall clock they interleave; read as UTC the photos were nine hours late.
    const local = (at: string) => ({
      source: 'exif' as const,
      precision: 'local' as const,
      raw: at,
      local: at,
    });
    const assets = [
      asset('asset_001', 'DSC_0001.JPG', {
        kind: 'image',
        duration_ms: 0,
        capture_time: local('2026-05-17T18:05:00.000'),
      }),
      asset('asset_002', 'DSC_0002.JPG', {
        kind: 'image',
        duration_ms: 0,
        capture_time: local('2026-05-17T18:15:00.000'),
      }),
      asset('asset_003', 'IMG_0041.MOV', {
        creation_time: '2026-05-17T09:00:00.000Z',
        capture_time: {
          source: 'quicktime',
          precision: 'instant',
          raw: '2026-05-17T18:00:00+0900',
          local: '2026-05-17T18:00:00.000',
          utc_offset_minutes: 540,
        },
      }),
      asset('asset_004', 'IMG_0042.MOV', {
        creation_time: '2026-05-17T09:10:00.000Z',
        capture_time: {
          source: 'quicktime',
          precision: 'instant',
          raw: '2026-05-17T18:10:00+0900',
          local: '2026-05-17T18:10:00.000',
          utc_offset_minutes: 540,
        },
      }),
    ];
    expect(captureClockFor(assets)).toBe('local');
    expect(order(assets)).toEqual(['IMG_0041.MOV', 'DSC_0001.JPG', 'IMG_0042.MOV', 'DSC_0002.JPG']);
    expect(placeAssets(assets).every((p) => p.clock === 'local')).toBe(true);
  });

  it('never orders on the wall clock across two time zones', () => {
    const zoned = (id: string, name: string, localAt: string, offset: number) =>
      asset(id, name, {
        creation_time: new Date(Date.parse(`${localAt}Z`) - offset * 60_000).toISOString(),
        capture_time: {
          source: 'quicktime',
          precision: 'instant',
          raw: localAt,
          local: localAt,
          utc_offset_minutes: offset,
        },
      });
    const assets = [
      // 18:00 in Tokyo is 09:00 UTC; 11:00 in Paris the same day is 09:00 UTC too,
      // and later by the wall clock only if the zones are ignored.
      zoned('asset_001', 'tokyo.mov', '2026-05-17T18:00:00.000', 540),
      zoned('asset_002', 'paris.mov', '2026-05-17T11:30:00.000', 120),
      asset('asset_003', 'camera.jpg', {
        kind: 'image',
        duration_ms: 0,
        capture_time: {
          source: 'exif',
          precision: 'local',
          raw: 'x',
          local: '2026-05-17T12:00:00.000',
        },
      }),
      asset('asset_004', 'camera2.jpg', {
        kind: 'image',
        duration_ms: 0,
        capture_time: {
          source: 'exif',
          precision: 'local',
          raw: 'x',
          local: '2026-05-17T12:30:00.000',
        },
      }),
    ];
    expect(captureClockFor(assets)).toBe('utc');
    expect(order(assets).filter((name) => name?.endsWith('.mov'))).toEqual([
      'tokyo.mov',
      'paris.mov',
    ]);
  });

  it('never compares a zone-less time with a UTC one', () => {
    const phone = asset('asset_001', 'PXL_1.mp4', { creation_time: '2026-05-17T09:00:00.000Z' });
    const camera = asset('asset_002', 'DSC_1.JPG', {
      kind: 'image',
      duration_ms: 0,
      capture_time: {
        source: 'exif',
        precision: 'local',
        raw: 'x',
        local: '2026-05-17T18:05:00.000',
      },
    });
    expect(captureStartsApartMs(phone, camera)).toBeUndefined();
    const placements = placeAssets([phone, camera]);
    expect(placements.find((p) => p.asset_id === 'asset_002')?.ordered_by).toBe('file_name');
    const otherCamera = {
      ...camera,
      capture_time: { ...camera.capture_time!, local: '2026-05-17T18:35:00.000' },
    };
    expect(captureStartsApartMs(camera, otherCamera)).toBe(30 * 60_000);
  });
});
