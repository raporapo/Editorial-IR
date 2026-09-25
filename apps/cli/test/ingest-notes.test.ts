import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '@editorial-ir/contracts';
import { placeAssets } from '@editorial-ir/core';
import { mediaNotes, orderingSummary, refreshNote } from '../src/commands/ingest.js';

/**
 * What `oea ingest` says about a file beyond its size and length.
 *
 * Each of these facts changes what the analysis does with the file, and each
 * used to change it silently: a clip with no sound went through three audio
 * stages, a second audio track was never heard, dropped frames set the rate.
 */
function asset(overrides: Partial<MediaAsset>): MediaAsset {
  return {
    id: 'asset_001',
    path: 'footage/clip.mp4',
    file_name: 'clip.mp4',
    kind: 'video',
    sha256: 'c'.repeat(64),
    byte_size: 1,
    duration_ms: 10_000,
    fps: 30,
    fps_num: 30,
    fps_den: 1,
    metadata: {},
    ...overrides,
  };
}

describe('what ingest says about a file', () => {
  it('says a silent video has nothing to transcribe, and that it is not an error', () => {
    expect(mediaNotes(asset({ audio_streams: [] }))).toEqual([
      'no audio track; nothing will be transcribed, and that is not an error',
    ]);
  });

  it('says which of several audio streams will be listened to', () => {
    const notes = mediaNotes(
      asset({
        audio_streams: [
          { index: 0, channels: 2 },
          { index: 1, channels: 1 },
        ],
      }),
    );
    expect(notes[0]).toMatch(/^2 audio streams; the one with the most speech is analysed/);
  });

  it('names the rate a variable-rate clip is treated as', () => {
    expect(
      mediaNotes(
        asset({ variable_frame_rate: true, avg_fps: 22.75, audio_streams: [{ index: 0 }] }),
      ),
    ).toEqual([
      'variable frame rate (averaging 22.75); treated as 30 fps, the rate an editor will conform it to',
    ]);
  });

  it('names a start timecode, which an EDL or FCPXML counts from, and not a zero one', () => {
    expect(
      mediaNotes(asset({ audio_streams: [{ index: 0 }], start_timecode: '01:00:00;00' })),
    ).toEqual(['starts at timecode 01:00:00;00; an EDL or FCPXML export counts from there']);
    expect(
      mediaNotes(asset({ audio_streams: [{ index: 0 }], start_timecode: '00:00:00:00' })),
    ).toEqual([]);
  });

  it('says nothing about an ordinary file', () => {
    expect(
      mediaNotes(asset({ audio_streams: [{ index: 0 }], variable_frame_rate: false })),
    ).toEqual([]);
    // Nor about one registered before streams were listed: absent is not empty.
    expect(mediaNotes(asset({}))).toEqual([]);
  });
});

describe('what ingest says about files it read again', () => {
  it('does not promise an analysis already stored will use what was learned', () => {
    // A stored analysis is reused on content and models, not on what the probe
    // says, so the room tone stayed transcribed until --force.
    expect(refreshNote(['asset_001'], true)).toContain('oea analyze --force');
    expect(refreshNote(['asset_001'], false)).not.toContain('--force');
    expect(refreshNote(['asset_001', 'asset_004'], false)).toContain('asset_001, asset_004');
  });
});

describe('what ingest says about the order of the capture timeline', () => {
  const clip = (id: string, fileName: string, extra: Partial<MediaAsset> = {}) =>
    asset({ id, file_name: fileName, path: `footage/${fileName}`, ...extra });

  it('names each file whose place is a guess, and why, when the rest are dated', () => {
    // It printed the first placement's rule and nothing else: "creation_time"
    // while the photo's place was a guess, or "file_name" while the clips kept
    // their order.
    const assets = [
      clip('asset_001', 'A.MOV', { creation_time: '2026-05-17T10:00:10.000Z' }),
      clip('asset_002', 'B.MOV', { creation_time: '2026-05-17T10:00:00.000Z' }),
      clip('asset_003', 'photo.jpg', { kind: 'image', duration_ms: 0 }),
      clip('asset_004', 'song.mp3', {
        kind: 'audio',
        capture_time: { source: 'container', precision: 'date', raw: '2026', date: '2026' },
      }),
    ];
    const summary = orderingSummary(assets, placeAssets(assets));
    expect(summary.headline).toBe('capture time for 2 of 4; file name places the rest');
    expect(summary.warning).toBeUndefined();
    expect(summary.lines).toEqual([
      '  asset_003 photo.jpg: no capture time in the file; placed after asset_002 B.MOV, ' +
        'the dated file its name sorts after',
      '  asset_004 song.mp3: only a date (2026), which is not a time of day; placed after ' +
        'asset_002 B.MOV, the dated file its name sorts after',
    ]);
  });

  it('says a zone-less time was not read as UTC', () => {
    const assets = [
      clip('asset_001', 'PXL_1.mp4', { creation_time: '2026-05-17T09:00:00.000Z' }),
      clip('asset_002', 'DSC_1.JPG', {
        kind: 'image',
        duration_ms: 0,
        capture_time: {
          source: 'exif',
          precision: 'local',
          raw: '2026:05:17 18:05:00',
          local: '2026-05-17T18:05:00.000',
        },
      }),
    ];
    expect(orderingSummary(assets, placeAssets(assets)).lines[0]).toMatch(
      /^ {2}asset_002 DSC_1\.JPG: its time \(2026:05:17 18:05:00\) has no zone, and the others are instants/,
    );
  });

  it('warns only when nothing is dated, as it did', () => {
    const assets = [clip('asset_001', 'B.MOV'), clip('asset_002', 'A.MOV')];
    expect(orderingSummary(assets, placeAssets(assets))).toEqual({
      headline: 'file name',
      warning: 'no capture times in the metadata, so file name decides the order',
      lines: [],
    });
    const dated = [clip('asset_001', 'B.MOV', { creation_time: '2026-05-17T10:00:00.000Z' })];
    expect(orderingSummary(dated, placeAssets(dated))).toEqual({
      headline: 'capture time',
      lines: [],
    });
  });
});
