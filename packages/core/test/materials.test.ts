import { describe, expect, it } from 'vitest';
import type {
  MediaAsset,
  MotionProfile,
  ObservationTimeline,
  OcrObservation,
  Shot,
} from '@editorial-ir/contracts';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { classifyMaterials, compileProject, steadyShots, titleCards } from '../src/index.js';
import { makeAsset } from '../../../tests/support/ir.js';
import { exampleSuite, makeExampleProject } from '../../../tests/support/project.js';

function observations(overrides: Partial<ObservationTimeline> = {}): ObservationTimeline {
  return {
    project_id: 'prj_test',
    fingerprint: 'test',
    pipeline_version: '0.1.1',
    generated_at: '2026-09-24T00:00:00.000Z',
    model_runs: [],
    failures: [],
    utterances: [],
    shots: [],
    audio_events: [],
    ocr: [],
    frame_features: [],
    audio_profiles: [],
    video_events: [],
    motion_profiles: [],
    syncs: [],
    ...overrides,
  };
}

/** Shots of the given lengths, laid end to end from zero. */
function shotsOf(lengthsMs: number[], assetId = 'asset_001'): Shot[] {
  let at = 0;
  return lengthsMs.map((length, i) => {
    const shot = {
      id: `shot_${assetId}_${String(i).padStart(3, '0')}`,
      asset_id: assetId,
      start_ms: at,
      end_ms: at + length,
      representative_frame_ms: at + Math.floor(length / 3),
    };
    at += length;
    return shot;
  });
}

function video(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return makeAsset({ video_codec: 'h264', audio_codec: 'aac', ...overrides });
}

function only(assets: MediaAsset[], observed: ObservationTimeline, context?: unknown) {
  const profiles = classifyMaterials(
    assets,
    observed,
    context as Parameters<typeof classifyMaterials>[2],
  );
  return profiles[0]!;
}

describe('classifyMaterials', () => {
  it('reads the worked example’s three recordings as raw, so they take the path they always took', async () => {
    const store = await makeExampleProject();
    const { ir } = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
    });
    expect(ir.materials.map((m) => [m.kind, m.provenance])).toEqual([
      ['raw', 'inferred'],
      ['raw', 'inferred'],
      ['raw', 'inferred'],
    ]);
    // It cuts 3.4 to 4.1 times a minute, inside the gap between raw and edited;
    // what says raw is that the cuts interrupt long takes.
    for (const profile of ir.materials) {
      expect(profile.signals.cut_rate_per_min).toBeGreaterThan(3);
      expect(profile.signals.median_shot_ms).toBeGreaterThan(11_000);
    }
  }, 60_000);

  it('recognises an edited programme by how often it cuts and how short its shots are', () => {
    // The synthetic probe programme: 60 s, 21 cuts.
    const shots = shotsOf([
      ...[1500, 3000, 2500, 3500, 2000, 4000, 3000, 2500, 3000, 2000, 3500],
      ...[1500, 2500, 3000, 4000, 2000, 3000, 2500, 3500, 2000, 3000, 2500],
    ]);
    const duration = shots.at(-1)!.end_ms;
    const profile = only([video({ duration_ms: duration })], observations({ shots }));
    expect(profile.kind).toBe('edited');
    expect(profile.confidence).toBeGreaterThanOrEqual(0.9);
    expect(profile.signals.cuts).toBe(21);
    expect(profile.evidence.join(' ')).toContain('cuts a minute');
  });

  it('does not call a handful of quick cuts in a short file an edit', () => {
    // Two cuts in twenty seconds is six a minute, and could be a camera stopping twice.
    const shots = shotsOf([6000, 7000, 7000]);
    expect(only([video({ duration_ms: 20_000 })], observations({ shots })).kind).toBe('raw');
  });

  it('keeps a short clip whole whether or not a shot detector looked at it', () => {
    const detected = only([video({ duration_ms: 7000 })], observations({ shots: shotsOf([7000]) }));
    const unmeasured = only([video({ duration_ms: 7000 })], observations());
    expect(detected.kind).toBe('clip');
    expect(unmeasured.kind).toBe('clip');
  });

  it('does not let a detector stuttering over fast movement turn a clip into an edit', () => {
    // Measured: an 8-second clip came back as ten 0.8-second shots.
    const shots = shotsOf(Array.from({ length: 10 }, () => 800));
    const profile = only([video({ duration_ms: 8000 })], observations({ shots }));
    expect(profile.kind).toBe('clip');
    expect(profile.signals.cuts).toBe(0);
  });

  it('knows a still, and a file with nothing to see', () => {
    expect(
      only([makeAsset({ kind: 'image', duration_ms: 0, file_name: 'a.jpg' })], observations()).kind,
    ).toBe('still');
    expect(only([makeAsset({ kind: 'audio', duration_ms: 40_000 })], observations()).kind).toBe(
      'audio_only',
    );
    const noPicture = makeAsset({ duration_ms: 40_000 });
    delete noPicture.width;
    delete noPicture.height;
    expect(only([noPicture], observations()).kind).toBe('audio_only');
  });

  it('takes a screen recorder’s own file names as evidence', () => {
    for (const name of [
      'screen_2026-09-01_tutorial.mp4',
      'Screen Recording 2026-09-01 at 10.00.00.mov',
      'ScreenRecording_09-01-2026.MP4',
      '画面収録 2026-09-01 10.00.00.mov',
      'obs_capture_gappy_audio.mp4',
    ]) {
      const profile = only([video({ file_name: name, duration_ms: 60_000 })], observations());
      expect(profile.kind, name).toBe('screen_recording');
    }
    for (const name of ['jobs_fair.mp4', 'observatory.mov', 'IMG_4101.MOV']) {
      const profile = only([video({ file_name: name, duration_ms: 60_000 })], observations());
      expect(profile.kind, name).toBe('raw');
    }
  });

  it('recognises an unnamed screen recording by its variable rate, its stillness and its text', () => {
    const lines = ['Settings', 'Resolution', '1920x1080', 'Frame rate', '29.97'];
    const ocr: OcrObservation[] = lines.map((text, i) => ({
      id: `ocr_${i}`,
      asset_id: 'asset_001',
      start_ms: 20_000,
      end_ms: 21_000,
      text,
      confidence: 0.9,
    }));
    const profile = only(
      [video({ duration_ms: 60_000, variable_frame_rate: true })],
      observations({
        shots: shotsOf([60_000]),
        ocr,
        motion_profiles: [{ asset_id: 'asset_001', hop_ms: 200, motion: [], luma: [] }],
        video_events: [
          {
            id: 'vev_1',
            asset_id: 'asset_001',
            start_ms: 2000,
            end_ms: 58_000,
            event_type: 'static',
            confidence: 0.9,
          },
        ],
      }),
    );
    expect(profile.kind).toBe('screen_recording');
  });

  it('lets the user’s word win, by file name or by asset id, and marks it as theirs', () => {
    const asset = video({ file_name: 'final_v3.mp4', duration_ms: 90_000 });
    const byName = only([asset], observations(), {
      background: { materials: { 'final_v3.mp4': 'edited' } },
    });
    expect(byName).toMatchObject({ kind: 'edited', provenance: 'user_provided', confidence: 1 });

    // The id is the more specific handle and wins where both are given.
    const both = only([asset], observations(), {
      background: { materials: { 'final_v3.mp4': 'edited', asset_001: 'raw' } },
    });
    expect(both.kind).toBe('raw');
  });

  it('takes nothing for the user’s word that the user did not write', () => {
    // A file with no extension named like a property of every object found that
    // property in the overrides and was classified as a function.
    for (const name of ['constructor', 'toString', '__proto__']) {
      const profile = only([video({ file_name: name, duration_ms: 60_000 })], observations(), {
        background: { materials: {} },
      });
      expect(profile, name).toMatchObject({ kind: 'raw', provenance: 'inferred' });
    }
  });

  it('is the same classification on every run, in asset order', () => {
    const assets = [
      video({ id: 'asset_002', file_name: 'b.mp4', duration_ms: 5000 }),
      video({ id: 'asset_001', file_name: 'a.mp4', duration_ms: 600_000 }),
    ];
    const first = classifyMaterials(assets, observations());
    expect(first.map((p) => p.asset_id)).toEqual(['asset_001', 'asset_002']);
    expect(JSON.stringify(classifyMaterials([...assets].reverse(), observations()))).toBe(
      JSON.stringify(first),
    );
  });
});

describe('steadyShots', () => {
  it('folds a burst of detections into the shot before it', () => {
    const shots = shotsOf([12_500, 800, 800, 800, 3100]);
    expect(steadyShots('asset_001', shots)).toEqual([
      { start_ms: 0, end_ms: 14_900 },
      { start_ms: 14_900, end_ms: 18_000 },
    ]);
  });
});

describe('titleCards', () => {
  /** A 200 ms envelope: moving bright pictures, with a still dark card at 30.5-32 s. */
  function envelope(): MotionProfile {
    const motion: number[] = [];
    const luma: number[] = [];
    for (let at = 0; at < 60_000; at += 200) {
      const onCard = at >= 30_500 && at < 32_000;
      // The first sample of the card compares it with the shot before.
      motion.push(at === 30_600 ? 142 : onCard ? 0.01 : 9);
      luma.push(onCard ? 5.4 : 110);
    }
    return { asset_id: 'asset_001', hop_ms: 200, motion, luma };
  }
  const asset = video({ duration_ms: 60_000 });
  const shots = [
    ...shotsOf([30_500]),
    {
      id: 'shot_card',
      asset_id: 'asset_001',
      start_ms: 30_500,
      end_ms: 32_000,
      representative_frame_ms: 31_000,
    },
    {
      id: 'shot_after',
      asset_id: 'asset_001',
      start_ms: 32_000,
      end_ms: 60_000,
      representative_frame_ms: 41_000,
    },
  ];

  it('finds a title card the black detector cannot, because its letters are bright', () => {
    const cards = titleCards(asset, observations({ shots, motion_profiles: [envelope()] }));
    expect(cards).toEqual([{ start_ms: 30_500, end_ms: 32_000 }]);
  });

  it('calls nothing a card where the picture was not analysed', () => {
    expect(titleCards(asset, observations({ shots }))).toEqual([]);
  });

  it('does not take a dark shot that moves for a card', () => {
    const moving = envelope();
    moving.motion = moving.motion.map(() => 9);
    expect(titleCards(asset, observations({ shots, motion_profiles: [moving] }))).toEqual([]);
  });
});
