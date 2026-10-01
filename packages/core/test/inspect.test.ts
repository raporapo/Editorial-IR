import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditorialIR, ObservationTimeline } from '@editorial-ir/contracts';
import { framesDirName } from '@editorial-ir/perception';
import { framePathFor } from '../src/observe.js';
import { contactSheet, framePath, framesIn, shotsIn, tileFilter } from '../src/inspect.js';
import { projectPaths } from '../src/paths.js';

/**
 * Descending the hierarchy.
 *
 * The event layer is where almost everything happens; these are the two layers
 * below it, which exist for the cases where the event summary was not enough.
 */
const observations = {
  project_id: 'prj_1',
  created_at: '2026-05-17T09:00:00.000Z',
  utterances: [],
  audio_events: [],
  ocr: [],
  frames: [],
  shots: [
    {
      id: 'sht_0001',
      asset_id: 'asset_001',
      start_ms: 0,
      end_ms: 4000,
      representative_frame_ms: 2000,
    },
    {
      id: 'sht_0002',
      asset_id: 'asset_001',
      start_ms: 4000,
      end_ms: 9000,
      representative_frame_ms: 6000,
    },
    {
      id: 'sht_0003',
      asset_id: 'asset_001',
      start_ms: 9000,
      end_ms: 20_000,
      representative_frame_ms: 12_000,
    },
    {
      id: 'sht_0004',
      asset_id: 'asset_002',
      start_ms: 0,
      end_ms: 5000,
      representative_frame_ms: 2500,
    },
  ],
} as unknown as ObservationTimeline;

const event = {
  source_ranges: [{ asset_id: 'asset_001', source_in_ms: 3000, source_out_ms: 11_000 }],
};

describe('shotsIn', () => {
  it('finds every shot the event overlaps', () => {
    // An event is a stretch of meaning and a shot is a stretch of camera; they
    // do not line up, which is the whole reason to be able to ask.
    expect(shotsIn(observations, event).map((d) => d.shot.id)).toEqual([
      'sht_0001',
      'sht_0002',
      'sht_0003',
    ]);
  });

  it('says which shots the event cuts through and which it contains', () => {
    const [first, middle, last] = shotsIn(observations, event);
    expect(first!.whole).toBe(false);
    expect(middle!.whole).toBe(true);
    expect(last!.whole).toBe(false);
  });

  it('measures each shot from the start of the event, not of the asset', () => {
    const [first, middle] = shotsIn(observations, event);
    expect(first!.offset_ms).toBe(0);
    expect(first!.duration_ms).toBe(1000);
    expect(middle!.offset_ms).toBe(1000);
  });

  it('ignores shots in another asset', () => {
    expect(shotsIn(observations, event).some((d) => d.shot.asset_id === 'asset_002')).toBe(false);
  });

  it('finds nothing for an event outside every shot', () => {
    const elsewhere = {
      source_ranges: [{ asset_id: 'asset_001', source_in_ms: 50_000, source_out_ms: 60_000 }],
    };
    expect(shotsIn(observations, elsewhere)).toEqual([]);
  });
});

describe('framePath', () => {
  it('agrees with where ingestion actually wrote the frame', () => {
    // Two derivations of the same path, in two files, for two different reasons:
    // ingestion knows the work directory it just created, and inspection has to
    // work without having just ingested anything. If they drift, frames simply
    // never resolve and looking closer silently returns nothing.
    const workDir = '/projects/trip/.oea/work';
    const asset = { sha256: 'abcdef0123456789abcdef' };
    const assetWorkDir = join(workDir, asset.sha256.slice(0, 12));

    for (const ms of [0, 1000, 2500, 61_000]) {
      expect(framePath(workDir, asset, ms, 1)).toBe(
        framePathFor(
          { frames_dir: join(assetWorkDir, framesDirName(1)), frame_timestamps_ms: [] },
          ms,
          1,
        ),
      );
    }
  });

  it('looks where prepare writes, which is named for the rate and the size', () => {
    // Prepare names the directory after its rate so frames sampled at another
    // rate are never read as these; a path derived by hand from `frames/`
    // found nothing at all once it did.
    expect(framePath('/w', { sha256: 'a'.repeat(64) }, 0, 1)).toContain('/frames-1fps-768px/');
    expect(framePath('/w', { sha256: 'a'.repeat(64) }, 0, 2)).toContain('/frames-2fps-768px/');
  });

  it('never asks for a frame before the first one', () => {
    expect(framePath('/w', { sha256: 'a'.repeat(64) }, -5000, 1)).toContain('00000001.jpg');
  });
});

describe('framesIn', () => {
  function projectWithFrames(present: number[]): { root: string; ir: EditorialIR } {
    const root = mkdtempSync(join(tmpdir(), 'oea-inspect-'));
    const sha = 'fedcba9876543210';
    const frames = join(projectPaths(root).workDir, sha.slice(0, 12), framesDirName(1));
    mkdirSync(frames, { recursive: true });
    for (const index of present) {
      writeFileSync(join(frames, `${String(index).padStart(8, '0')}.jpg`), 'not really a jpeg');
    }
    const ir = { assets: [{ id: 'asset_001', sha256: sha }] } as unknown as EditorialIR;
    return { root, ir };
  }

  it('returns the frames that are actually on disk', () => {
    // Frames for the whole span the event covers, 3s to 11s.
    const { root, ir } = projectWithFrames([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const frames = framesIn(ir, root, event, { count: 4, fps: 1 });
    expect(frames).toHaveLength(4);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame.path).toMatch(/\d{8}\.jpg$/);
  });

  it('returns nothing when the work directory was deleted', () => {
    // Frames are a derivative and the work directory is documented as safe to
    // delete. Returning paths that will fail to open later is worse than
    // returning none.
    const { root, ir } = projectWithFrames([]);
    expect(framesIn(ir, root, event, { fps: 1 })).toEqual([]);
  });

  it('takes one frame per shot when asked', () => {
    const { root, ir } = projectWithFrames([3, 7, 13]); // 2000ms, 6000ms, 12000ms
    const frames = framesIn(ir, root, event, {
      perShot: true,
      observations,
      fps: 1,
    });
    // The representative frames of the three shots the event overlaps.
    expect(frames.map((f) => f.source_ms)).toEqual([2000, 6000, 12_000]);
  });

  it('does not return the same frame twice', () => {
    const { root, ir } = projectWithFrames([4, 5, 6, 7, 8, 9, 10, 11]);
    const frames = framesIn(ir, root, event, { count: 40, fps: 1 });
    expect(new Set(frames.map((f) => f.path)).size).toBe(frames.length);
  });
});

describe('contactSheet', () => {
  const frames = [
    { path: '/w/a.jpg', asset_id: 'asset_001', source_ms: 1000 },
    { path: '/w/b.jpg', asset_id: 'asset_001', source_ms: 2000 },
  ];

  it('passes every frame to ffmpeg and writes one image', async () => {
    let seen: readonly string[] = [];
    const out = await contactSheet(frames, join(tmpdir(), 'sheet.jpg'), {
      run: async (_binary, args) => {
        seen = args;
      },
    });
    expect(out).toContain('sheet.jpg');
    expect(seen.filter((a) => a === '-i')).toHaveLength(2);
    expect(seen).toContain('/w/a.jpg');
    expect(seen).toContain('/w/b.jpg');
    expect(seen).toContain('-frames:v');
  });

  it('maps the filter graph to the file, or ffmpeg refuses the whole command', async () => {
    // `-filter_complex` that names its output needs an explicit `-map`, or
    // automatic stream selection ignores it: "Filter xstack:default has an
    // unconnected output", and nothing is written. Every other test here stubs
    // the runner, so only a real ffmpeg over real frames found it — which is
    // what `oea inspect --sheet` is.
    for (const count of [1, 2, 5, 9]) {
      let seen: readonly string[] = [];
      const many = Array.from({ length: count }, (_, i) => ({
        path: `/w/${i}.jpg`,
        asset_id: 'asset_001',
        source_ms: i * 1000,
      }));
      await contactSheet(many, join(tmpdir(), 'sheet.jpg'), {
        run: async (_binary, args) => {
          seen = args;
        },
      });
      const graph = seen[seen.indexOf('-filter_complex') + 1]!;
      expect(graph, `${count} frames`).toContain('[out]');
      expect(seen[seen.indexOf('-map') + 1], `${count} frames`).toBe('[out]');
    }
  });

  it('explains itself when there is nothing to look at', async () => {
    // "0 frames" with no explanation reads as a broken tool. The reason is
    // almost always that the media was never ingested with frame sampling.
    await expect(contactSheet([], '/tmp/x.jpg')).rejects.toThrow(/no sampled frames/);
  });
});

describe('tileFilter', () => {
  it('scales every cell to the same size before stacking', () => {
    // xstack refuses inputs of differing sizes, and source frames differ
    // whenever the footage does.
    const filter = tileFilter(4, 2, 2, 180);
    expect(filter.match(/scale=-2:180/g)).toHaveLength(4);
    expect(filter).toContain('xstack=inputs=4');
  });

  it('lays the cells out left to right, then down', () => {
    expect(tileFilter(4, 2, 2, 180)).toContain('layout=0_0|w0*1_0|0_h0*1|w0*1_h0*1');
  });

  it('does not stack a single frame', () => {
    expect(tileFilter(1, 1, 1, 180)).not.toContain('xstack');
  });
});
