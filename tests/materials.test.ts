import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_TIMELINE_GAP_MS,
  IR_VERSION,
  ProjectContext,
  STILL_SLOT_MS,
  compareText,
  newId,
  type EditorialIR,
} from '@editorial-ir/contracts';
import {
  FileProjectStore,
  MemoryCache,
  compileProject,
  ingestPaths,
  placeAssets,
} from '@editorial-ir/core';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { createFixtureSuite, PerceptionFixture } from '@editorial-ir/perception';
import { SkillRegistry } from '@editorial-ir/skills';
import { planEdit } from '@editorial-ir/agent';

/**
 * Material that is not raw camera footage, end to end and with no model.
 *
 * Each project here is the shape of a probe file that came out wrong: an edited
 * programme with a music bed and no transcript planned no clips at all; a folder
 * of eight clips the user had trimmed kept two; four photographs beside a video
 * disappeared. The perception is replayed, so what is tested is the compiler.
 */
type Fixture = PerceptionFixture['assets'][string];

async function project(files: Record<string, Fixture>, background: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'editorial-ir-materials-'));
  mkdirSync(join(root, 'footage'));
  // Stand-in media: the bytes only have to differ, so every file hashes apart.
  for (const name of Object.keys(files)) writeFileSync(join(root, 'footage', name), name);

  const store = new FileProjectStore(root, new MemoryCache());
  const now = '2026-09-24T00:00:00.000Z';
  const id = newId('prj');
  store.initialise(
    {
      id,
      title: 'materials',
      status: 'created',
      ir_version: IR_VERSION,
      created_at: now,
      updated_at: now,
    },
    ProjectContext.parse({ project_id: id, background, updated_at: now }),
  );
  const suite = createFixtureSuite(PerceptionFixture.parse({ assets: files, describe: {} }));
  const ingested = await ingestPaths([join(root, 'footage')], {
    projectRoot: root,
    probe: suite.probe,
    cache: store.cache,
  });
  store.writeAssets(ingested.assets);
  return { store, suite };
}

async function compile(files: Record<string, Fixture>, background: Record<string, unknown> = {}) {
  const { store, suite } = await project(files, background);
  const result = await compileProject({ store, suite, decision: new HeuristicDecisionBackend() });
  return { ...result, store, suite };
}

function plan(ir: EditorialIR, observations: Parameters<typeof planEdit>[0]['observations']) {
  return planEdit({
    ir,
    skill: SkillRegistry.withBuiltIns().resolve('travel-vlog'),
    targetDurationMs: 30_000,
    ...(observations ? { observations } : {}),
  });
}

/** The edited probe: 60 s, 22 shots with a dark title card at 0 s and at 30.5 s, a music bed. */
function editedProgramme(): Record<string, Fixture> {
  const lengths = [
    ...[1500, 3000, 2500, 3500, 2000, 4000, 3000, 2500, 3000, 2000, 3500],
    ...[1500, 2500, 3000, 4000, 2000, 3000, 2500, 3500, 2000, 3000, 2500],
  ];
  let at = 0;
  const shots = lengths.map((length) => {
    const shot = {
      start_ms: at,
      end_ms: at + length,
      representative_frame_ms: at + Math.floor(length / 3),
    };
    at += length;
    return shot;
  });
  const cards = [
    { start: 0, end: 1500 },
    { start: 30_500, end: 32_000 },
  ];
  const motion: number[] = [];
  const luma: number[] = [];
  for (let t = 0; t < 60_000; t += 200) {
    const onCard = cards.some((c) => t >= c.start && t < c.end);
    const firstOfCard = cards.some((c) => t - 200 < c.start && t >= c.start);
    motion.push(onCard && !firstOfCard ? 0.01 : 12);
    luma.push(onCard ? 4.1 : 118);
  }
  return {
    'harbour_days_final.mp4': {
      probe: {
        duration_ms: 60_000,
        width: 1280,
        height: 720,
        fps_num: 30,
        fps_den: 1,
        video_codec: 'h264',
        audio_codec: 'aac',
        audio_channels: 2,
        metadata: {},
      },
      detect_shots: { shots },
      // A music bed: loud all the way through, so no silence and no speech.
      analyze_audio: { hop_ms: 100, rms_db: Array.from({ length: 600 }, () => -22), events: [] },
      analyze_video: { hop_ms: 200, motion, luma, events: [] },
    },
  };
}

describe('an edited programme with no transcript', () => {
  it('is recognised as edited, cut evenly, opened at its title cards, and planned', async () => {
    const { ir, observations } = await compile(editedProgramme());

    expect(ir.materials[0]).toMatchObject({ kind: 'edited', provenance: 'inferred' });
    const cardEvents = ir.events.filter((e) => e.segmentation.method === 'title_card');
    expect(cardEvents.map((e) => e.source_ranges[0]!.source_in_ms)).toEqual([0, 30_500]);
    // The second card begins a chapter instead of ending the first.
    expect(ir.chapters.map((c) => c.start_ms)).toEqual([0, cardEvents[1]!.start_ms]);

    const lengths = ir.events.map((e) => e.end_ms - e.start_ms);
    // It was one 34.5-second event and nine single shots.
    expect(Math.max(...lengths)).toBeLessThanOrEqual(2.5 * Math.min(...lengths));

    // Every event used to be a duplicate of every other, and nothing was planned.
    expect(ir.relations.some((r) => r.relation_type === 'duplicate_of')).toBe(false);
    expect(plan(ir, observations).tracks.video.length).toBeGreaterThan(1);
  });
});

describe('a folder of clips the user already trimmed', () => {
  const clips = (): Record<string, Fixture> =>
    Object.fromEntries(
      [3000, 4000, 5000, 6000, 7000, 8000, 3500, 4500].map((duration, i) => [
        `IMG_41${String(i + 1).padStart(2, '0')}.mp4`,
        {
          probe: {
            duration_ms: duration,
            width: 1280,
            height: 720,
            video_codec: 'h264',
            audio_codec: 'aac',
            metadata: {},
          },
          // One of them stuttered: ten 0.8-second "shots" in eight seconds.
          detect_shots: {
            shots:
              duration === 8000
                ? Array.from({ length: 10 }, (_, k) => ({
                    start_ms: k * 800,
                    end_ms: (k + 1) * 800,
                    representative_frame_ms: k * 800 + 266,
                  }))
                : [
                    {
                      start_ms: 0,
                      end_ms: duration,
                      representative_frame_ms: Math.floor(duration / 3),
                    },
                  ],
          },
          analyze_audio: {
            hop_ms: 100,
            rms_db: [],
            events: [{ start_ms: 0, end_ms: duration, event_type: 'speech', confidence: 0.5 }],
          },
        },
      ]),
    );

  it('keeps every clip whole and plans more than two of them', async () => {
    const { ir, observations } = await compile(clips());
    expect(ir.materials.every((m) => m.kind === 'clip')).toBe(true);
    expect(ir.events).toHaveLength(8);
    for (const event of ir.events) {
      const asset = ir.assets.find((a) => a.id === event.source_ranges[0]!.asset_id)!;
      expect(event.segmentation.method).toBe('asset');
      expect(event.source_ranges[0]).toMatchObject({
        source_in_ms: 0,
        source_out_ms: asset.duration_ms,
      });
    }
    // Offline, five of eight had the same description and six were dropped as
    // "another take of the same thing".
    expect(plan(ir, observations).tracks.video.length).toBeGreaterThan(2);
  });

  it('takes the user’s word for what a file is', async () => {
    const { ir } = await compile(clips(), { materials: { 'IMG_4101.mp4': 'raw' } });
    const first = ir.materials.find((m) => m.asset_id === 'asset_001')!;
    expect(first).toMatchObject({ kind: 'raw', provenance: 'user_provided', confidence: 1 });
  });
});

describe('still images beside a video', () => {
  const files = (): Record<string, Fixture> => ({
    'IMG_2001.jpg': { probe: { duration_ms: 0, width: 4032, height: 3024, metadata: {} } },
    'IMG_2002.jpg': { probe: { duration_ms: 0, width: 3024, height: 4032, metadata: {} } },
    'IMG_2004.mp4': {
      probe: { duration_ms: 6000, width: 1280, height: 720, video_codec: 'h264', metadata: {} },
      detect_shots: { shots: [{ start_ms: 0, end_ms: 6000, representative_frame_ms: 2000 }] },
    },
  });

  it('are events of their own, with no gap and nothing straddling', async () => {
    const { ir } = await compile(files());
    expect(ir.events).toHaveLength(3);
    for (const event of ir.events.filter((e) => e.segmentation.method === 'asset')) {
      const asset = ir.assets.find((a) => a.id === event.source_ranges[0]!.asset_id)!;
      if (asset.kind !== 'image') continue;
      expect(asset.duration_ms).toBe(0);
      expect(event.source_ranges[0]).toMatchObject({
        source_in_ms: 0,
        source_out_ms: STILL_SLOT_MS,
      });
    }
    // Laid end to end in file-name order, each still taking its slot.
    expect(ir.placements.map((p) => p.offset_ms)).toEqual([
      0,
      STILL_SLOT_MS + CAPTURE_TIMELINE_GAP_MS,
      2 * (STILL_SLOT_MS + CAPTURE_TIMELINE_GAP_MS),
    ]);
    for (let i = 1; i < ir.events.length; i++) {
      expect(ir.events[i]!.start_ms).toBeGreaterThanOrEqual(ir.events[i - 1]!.end_ms);
    }
  });

  it('move no capture time in a project that has none', async () => {
    // Every capture-time annotation a user wrote is measured from these offsets.
    const { store } = await project(editedProgramme());
    const assets = store.readAssets();
    const expected: number[] = [];
    let offset = 0;
    for (const asset of [...assets].sort((a, b) => compareText(a.file_name, b.file_name))) {
      expected.push(offset);
      offset += asset.duration_ms + CAPTURE_TIMELINE_GAP_MS;
    }
    expect(placeAssets(assets).map((p) => p.offset_ms)).toEqual(expected);
  });
});

describe('a reused analysis', () => {
  it('is classified exactly as a fresh one', async () => {
    const { store, suite } = await project(editedProgramme());
    const decision = new HeuristicDecisionBackend();
    const fresh = await compileProject({ store, suite, decision });
    store.writeObservations(fresh.observations);
    const reused = await compileProject({ store, suite, decision });
    expect(reused.report.reusedObservations).toBe(true);
    expect(reused.ir.materials).toEqual(fresh.ir.materials);
    expect(reused.ir.events.map((e) => [e.start_ms, e.end_ms])).toEqual(
      fresh.ir.events.map((e) => [e.start_ms, e.end_ms]),
    );
  });
});
