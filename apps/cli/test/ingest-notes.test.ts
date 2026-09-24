import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '@editorial-ir/contracts';
import { mediaNotes, refreshNote } from '../src/commands/ingest.js';

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
