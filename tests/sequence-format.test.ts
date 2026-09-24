import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '@editorial-ir/skills';
import { planEdit } from '@editorial-ir/agent';
import type { EditorialIR } from '@editorial-ir/contracts';
import { makeAsset, makeIR } from './support/ir.js';

/**
 * Which files decide the sequence's frame size and rate.
 *
 * Measured on a folder of four phone photos beside one 1280x720 clip at 30 fps:
 * the sequence came out 4032x3024 at 25 fps. Every asset was ranked by picture
 * area, stills included, and the largest photo won — carrying the 25/1 that
 * ffmpeg's image reader reports for every JPEG. The one video was conformed into
 * a 4:3 sequence at the wrong rate.
 */
const registry = SkillRegistry.withBuiltIns();

function sequenceOf(ir: EditorialIR) {
  return planEdit({ ir, skill: registry.resolve('travel-vlog'), targetDurationMs: 10_000 })
    .sequence;
}

const clip = makeAsset({
  id: 'asset_005',
  file_name: 'IMG_2004.mp4',
  duration_ms: 60_000,
  width: 1280,
  height: 720,
  fps: 30,
  fps_num: 30,
  fps_den: 1,
});

describe('the sequence format', () => {
  it('is set by the video, not by a larger photo beside it', () => {
    const photo = makeAsset({
      id: 'asset_001',
      file_name: 'IMG_2001.jpg',
      kind: 'image',
      duration_ms: 0,
      width: 4032,
      height: 3024,
      // What an asset ingested before stills lost their rate still carries.
      fps: 25,
      fps_num: 25,
      fps_den: 1,
    });
    const ir = makeIR({
      assets: [photo, clip],
      events: [
        { description: 'the only moving picture', duration_ms: 20_000, asset_id: 'asset_005' },
      ],
    });
    expect(sequenceOf(ir)).toMatchObject({
      width: 1280,
      height: 720,
      frame_rate_num: 30,
      frame_rate_den: 1,
    });
  });

  it("is not set by a podcast's album art", () => {
    const podcast = makeAsset({
      id: 'asset_001',
      file_name: 'episode.mp3',
      kind: 'audio',
      duration_ms: 60_000,
      width: 3000,
      height: 3000,
    });
    const ir = makeIR({
      assets: [podcast, clip],
      events: [{ description: 'the clip', duration_ms: 20_000, asset_id: 'asset_005' }],
    });
    expect(sequenceOf(ir)).toMatchObject({ width: 1280, height: 720 });
  });

  it('falls back to 1920x1080 at 30 when there is no video at all', () => {
    const memo = makeAsset({
      id: 'asset_001',
      file_name: 'memo.m4a',
      kind: 'audio',
      duration_ms: 60_000,
    });
    const { width: _w, height: _h, fps: _f, fps_num: _n, fps_den: _d, ...soundOnly } = memo;
    const ir = makeIR({
      assets: [soundOnly],
      events: [{ description: 'a voice', duration_ms: 20_000 }],
    });
    expect(sequenceOf(ir)).toMatchObject({
      width: 1920,
      height: 1080,
      frame_rate: 30,
      frame_rate_num: 30,
      frame_rate_den: 1,
    });
  });

  it('breaks a tie between equally large videos by id, not by where they sit in the list', () => {
    const a = makeAsset({ id: 'asset_001', file_name: 'a.mov', fps: 25, fps_num: 25, fps_den: 1 });
    const b = makeAsset({ id: 'asset_002', file_name: 'b.mov', fps: 50, fps_num: 50, fps_den: 1 });
    const forwards = makeIR({
      assets: [a, b],
      events: [{ description: 'x', duration_ms: 20_000 }],
    });
    const backwards = { ...forwards, assets: [b, a] };
    expect(sequenceOf(forwards).frame_rate_num).toBe(25);
    expect(sequenceOf(backwards).frame_rate_num).toBe(25);
  });
});
