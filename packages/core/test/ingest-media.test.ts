import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProbeResult } from '@editorial-ir/contracts';
import type { MediaProbe } from '@editorial-ir/perception';
import { MemoryCache, ingestPaths, mediaKindFromProbe, placeAssets } from '../src/index.js';

/**
 * Registering files whose kind or facts the extension does not tell.
 */

function footage(files: Record<string, string>): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'oea-ingest-media-'));
  const dir = join(root, 'footage');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return { root, dir };
}

class TableProbe implements MediaProbe {
  readonly identity;
  calls = 0;
  constructor(
    private readonly table: Record<string, ProbeResult>,
    modelVersion?: string,
  ) {
    this.identity = {
      backend: 'table',
      model: 'ffprobe',
      ...(modelVersion === undefined ? {} : { modelVersion }),
      locality: 'local' as const,
      mediaLeavesDevice: false,
    };
  }
  async probe(path: string): Promise<ProbeResult> {
    this.calls++;
    const name = path.split('/').at(-1) ?? '';
    const found = this.table[name];
    if (!found) throw new Error(`no probe for ${name}`);
    return found;
  }
}

describe('what kind of file it is', () => {
  it('is audio when an .mp4 or .mov holds nothing but sound', () => {
    // A voice memo exported as .m4v, a podcast rendered to .mp4: every picture
    // stage went looking for frames in them.
    expect(
      mediaKindFromProbe('episode.mp4', { audio_codec: 'aac', audio_streams: [{ index: 0 }] }),
    ).toBe('audio');
    expect(mediaKindFromProbe('memo.MOV', { audio_codec: 'aac' })).toBe('audio');
  });

  it('stays a video when there is a picture, and when the probe says nothing at all', () => {
    expect(
      mediaKindFromProbe('clip.mp4', { video_codec: 'h264', width: 1280, audio_codec: 'aac' }),
    ).toBe('video');
    expect(mediaKindFromProbe('clip.mp4', {})).toBe('video');
  });

  it('stays audio and image by name, whatever the probe reports', () => {
    expect(mediaKindFromProbe('song.mp3', { audio_codec: 'mp3' })).toBe('audio');
    expect(mediaKindFromProbe('IMG_2001.jpg', { video_codec: 'mjpeg', width: 4032 })).toBe('image');
  });
});

describe('ingest', () => {
  it('gives a still no frame rate, whatever the probe claims', async () => {
    // image2 reports 25/1 for every JPEG. Stored, it made a 30 fps project a
    // 25 fps sequence.
    const { root, dir } = footage({ 'IMG_2001.jpg': 'jpeg bytes' });
    const probe = new TableProbe({
      'IMG_2001.jpg': {
        duration_ms: 40,
        width: 4032,
        height: 3024,
        fps_num: 25,
        fps_den: 1,
        video_codec: 'mjpeg',
        metadata: {},
      },
    });
    const { added } = await ingestPaths([dir], { projectRoot: root, probe });
    expect(added[0]).toMatchObject({ kind: 'image', duration_ms: 0, width: 4032 });
    expect(added[0]?.fps).toBeUndefined();
    expect(added[0]?.fps_num).toBeUndefined();
  });

  it('keeps the audio streams, the nominal rate and the VFR flag', async () => {
    const { root, dir } = footage({ 'PXL_vfr.mp4': 'vfr bytes' });
    const probe = new TableProbe({
      'PXL_vfr.mp4': {
        duration_ms: 20_000,
        width: 1280,
        height: 720,
        fps_num: 30,
        fps_den: 1,
        avg_fps_num: 91,
        avg_fps_den: 4,
        variable_frame_rate: true,
        video_codec: 'h264',
        audio_codec: 'aac',
        audio_channels: 1,
        audio_streams: [{ index: 0, codec: 'aac', channels: 1, sample_rate: 48_000 }],
        metadata: {},
      },
    });
    const { added } = await ingestPaths([dir], { projectRoot: root, probe });
    expect(added[0]).toMatchObject({
      fps: 30,
      fps_num: 30,
      fps_den: 1,
      variable_frame_rate: true,
      avg_fps: 22.75,
      audio_streams: [{ index: 0, codec: 'aac', channels: 1, sample_rate: 48_000 }],
    });
  });

  it('refreshes what it knows about a file it already has, and nothing else', async () => {
    // A known file was never probed again, so a project ingested before the
    // stream list existed could never learn its camera had a second track.
    const { root, dir } = footage({ 'A.mp4': 'first', 'C0007.mp4': 'second' });
    const cache = new MemoryCache();
    const old = new TableProbe({
      'A.mp4': { duration_ms: 5000, video_codec: 'h264', width: 1280, metadata: {} },
      'C0007.mp4': {
        duration_ms: 30_000,
        video_codec: 'h264',
        width: 1280,
        height: 720,
        audio_codec: 'aac',
        audio_channels: 2,
        metadata: {},
      },
    });
    const first = await ingestPaths([dir], { projectRoot: root, probe: old, cache });
    const placedBefore = placeAssets(first.assets);

    const current = new TableProbe(
      {
        'A.mp4': { duration_ms: 5000, video_codec: 'h264', width: 1280, metadata: {} },
        'C0007.mp4': {
          duration_ms: 30_000,
          video_codec: 'h264',
          width: 1280,
          height: 720,
          audio_codec: 'aac',
          audio_channels: 2,
          audio_streams: [
            { index: 0, codec: 'aac', channels: 2 },
            { index: 1, codec: 'aac', channels: 1 },
          ],
          metadata: {},
        },
      },
      '2',
    );
    const again = await ingestPaths([dir], {
      projectRoot: root,
      probe: current,
      cache,
      existing: first.assets,
    });

    expect(again.added).toEqual([]);
    expect(again.duplicates).toHaveLength(2);
    expect(again.refreshed.map((a) => a.id)).toEqual(['asset_002']);
    const refreshed = again.assets.find((a) => a.file_name === 'C0007.mp4');
    const before = first.assets.find((a) => a.file_name === 'C0007.mp4');
    expect(refreshed?.audio_streams).toHaveLength(2);
    expect(refreshed).toMatchObject({ id: before?.id, path: before?.path, sha256: before?.sha256 });
    expect(placeAssets(again.assets)).toEqual(placedBefore);

    // And the probe is cached on its version, so the next re-ingest costs nothing.
    const calls = current.calls;
    const third = await ingestPaths([dir], {
      projectRoot: root,
      probe: current,
      cache,
      existing: again.assets,
    });
    expect(current.calls).toBe(calls);
    expect(third.refreshed).toEqual([]);
  });

  it('leaves a known asset alone when it cannot be read again', async () => {
    const { root, dir } = footage({ 'A.mp4': 'first' });
    const first = await ingestPaths([dir], {
      projectRoot: root,
      probe: new TableProbe({ 'A.mp4': { duration_ms: 5000, metadata: {} } }),
    });
    const again = await ingestPaths([dir], {
      projectRoot: root,
      probe: new TableProbe({}, '2'),
      existing: first.assets,
    });
    expect(again.assets).toEqual(first.assets);
    expect(again.failed).toEqual([]);
  });
});
