import { describe, expect, it } from 'vitest';
import {
  STILL_SLOT_MS,
  UserAnnotation,
  type MediaAsset,
  type ObservationTimeline,
  type Shot,
  type Utterance,
} from '@editorial-ir/contracts';
import { segmentAssets, segmentAtoms, subdivideLongAtoms, type Atom } from '../src/index.js';

/**
 * Segmenting by what the material is.
 *
 * The rules that turn a raw camera recording into events were applied to
 * everything, and each input below came out wrong in its own way on a
 * real-shaped probe file. `raw` is untouched by all of this except the one
 * thing no raw footage in the worked example reaches: a take longer than an
 * event may be.
 */
const asset: MediaAsset = {
  id: 'asset_001',
  path: 'a.mov',
  file_name: 'a.mov',
  kind: 'video',
  sha256: 'a'.repeat(64),
  byte_size: 1,
  duration_ms: 60_000,
  metadata: {},
};

const placement = [
  { asset_id: 'asset_001', offset_ms: 0, order: 0, ordered_by: 'file_name' as const },
];
const edited = [{ asset_id: 'asset_001', kind: 'edited' as const }];

function shot(id: string, start: number, end: number): Shot {
  return {
    id,
    asset_id: 'asset_001',
    start_ms: start,
    end_ms: end,
    representative_frame_ms: start + Math.floor((end - start) / 3),
  };
}

/** Shots of the given lengths, laid end to end. */
function cutEvery(lengths: number[]): Shot[] {
  let at = 0;
  return lengths.map((length, i) => {
    const made = shot(`shot_${String(i).padStart(3, '0')}`, at, at + length);
    at += length;
    return made;
  });
}

function atom(start: number, end: number): Atom {
  return {
    asset_id: 'asset_001',
    start_ms: start,
    end_ms: end,
    shot_ids: [`shot_${start}`],
    representative_frame_ms: start + Math.floor((end - start) / 3),
  };
}

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
    ...overrides,
  };
}

function spread(drafts: readonly { start_ms: number; end_ms: number }[]): number {
  const lengths = drafts.map((d) => d.end_ms - d.start_ms);
  return Math.max(...lengths) / Math.min(...lengths);
}

describe('segmenting by material', () => {
  it('keeps a clip the user already trimmed as one event, even with no shot detector', () => {
    // The fallback windows turned a seven-second clip into five seconds and two.
    const clip = { ...asset, duration_ms: 7000 };
    const drafts = segmentAssets([clip], observations(), [], {}, undefined, placement, [
      { asset_id: 'asset_001', kind: 'clip' },
    ]);
    expect(drafts).toEqual([
      expect.objectContaining({ start_ms: 0, end_ms: 7000, method: 'asset' }),
    ]);
  });

  it('still lets the user split a clip, because the user outranks the classification', () => {
    const clip = { ...asset, duration_ms: 12_000 };
    const split = UserAnnotation.parse({
      id: 'ann_0001',
      type: 'boundary',
      action: 'split',
      target: { kind: 'asset', asset_id: 'asset_001' },
      at_ms: 6000,
      created_at: '2026-09-24T00:00:00.000Z',
    });
    const drafts = segmentAssets([clip], observations(), [split], {}, undefined, placement, [
      { asset_id: 'asset_001', kind: 'clip' },
    ]);
    expect(drafts.map((d) => d.start_ms)).toEqual([0, 6000]);
    expect(drafts[1]!.method).toBe('user');
  });

  it('keeps a whole recording as one moment when the user says merge on the asset', () => {
    // Advertised by `oea annotate`, and it pointed at a boundary past the end of
    // the file, so it was accepted, reported, and did nothing.
    const merge = UserAnnotation.parse({
      id: 'ann_0001',
      type: 'boundary',
      action: 'merge_with_next',
      target: { kind: 'asset', asset_id: 'asset_001' },
      created_at: '2026-09-24T00:00:00.000Z',
    });
    const shots = observations({ shots: cutEvery([20_000, 20_000, 20_000]) });
    const before = segmentAssets([asset], shots, [], {}, undefined, placement);
    const after = segmentAssets([asset], shots, [merge], {}, undefined, placement);
    expect(before.length).toBeGreaterThan(1);
    expect(after).toEqual([
      expect.objectContaining({ start_ms: 0, end_ms: 60_000, method: 'user' }),
    ]);
  });

  it('makes every still image an event of its own, over the slot it has on the timeline', () => {
    const still: MediaAsset = { ...asset, id: 'asset_002', kind: 'image', duration_ms: 0 };
    const drafts = segmentAssets([asset, still], observations(), [], {}, undefined, [
      ...placement,
      { asset_id: 'asset_002', offset_ms: 61_000, order: 1, ordered_by: 'file_name' },
    ]);
    expect(drafts.filter((d) => d.asset_id === 'asset_002')).toEqual([
      expect.objectContaining({ start_ms: 0, end_ms: STILL_SLOT_MS, method: 'asset' }),
    ]);
  });

  it('begins an event at a title card in an edited video, and the card belongs to what it introduces', () => {
    // A 1.5 s card used to be absorbed into the end of the event before it, and
    // then gave the chapter before it its name.
    const shots = cutEvery([
      3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 1500, 3000, 3000, 3000,
    ]);
    const card = { start_ms: 24_000, end_ms: 25_500 };
    const observed = observations({
      shots,
      video_events: [
        { id: 'vev_1', asset_id: 'asset_001', ...card, event_type: 'black', confidence: 0.9 },
      ],
    });
    const drafts = segmentAssets(
      [{ ...asset, duration_ms: 34_500 }],
      observed,
      [],
      {},
      undefined,
      placement,
      edited,
    );

    const opened = drafts.find((d) => d.start_ms === card.start_ms);
    expect(opened?.method).toBe('title_card');
    expect(opened!.end_ms).toBeGreaterThan(card.end_ms);
    expect(drafts.some((d) => d.end_ms === card.end_ms)).toBe(false);
    // Nothing else moved: every boundary is still one of the edit's own cuts.
    const cuts = new Set(shots.map((s) => s.start_ms));
    for (const draft of drafts) expect(cuts.has(draft.start_ms)).toBe(true);
  });

  it('leaves a card at the very end to close the event it follows', () => {
    const observed = observations({
      shots: cutEvery([10_000, 10_000, 1500]),
      video_events: [
        {
          id: 'vev_1',
          asset_id: 'asset_001',
          start_ms: 20_000,
          end_ms: 21_500,
          event_type: 'black',
          confidence: 0.9,
        },
      ],
    });
    const drafts = segmentAssets(
      [{ ...asset, duration_ms: 21_500 }],
      observed,
      [],
      {},
      undefined,
      placement,
      edited,
    );
    expect(drafts.some((d) => d.method === 'title_card')).toBe(false);
    expect(drafts.at(-1)!.end_ms).toBe(21_500);
  });

  it('gives the user the last word over a card', () => {
    const shots = cutEvery([10_000, 10_000, 1500, 10_000]);
    const observed = observations({
      shots,
      video_events: [
        {
          id: 'vev_1',
          asset_id: 'asset_001',
          start_ms: 20_000,
          end_ms: 21_500,
          event_type: 'black',
          confidence: 0.9,
        },
      ],
    });
    const merge = UserAnnotation.parse({
      id: 'ann_0001',
      type: 'boundary',
      action: 'merge_with_next',
      target: { kind: 'time_range', start_ms: 20_000, end_ms: 20_500 },
      created_at: '2026-09-24T00:00:00.000Z',
    });
    const drafts = segmentAssets(
      [{ ...asset, duration_ms: 31_500 }],
      observed,
      [merge],
      { mergeThreshold: 0 },
      undefined,
      placement,
      edited,
    );
    expect(drafts.some((d) => d.start_ms === 20_000)).toBe(false);
  });

  it('cuts an edit with nothing to tell its boundaries apart into even events', () => {
    // Ten minutes of 3-second shots, no transcript, no vision model, a music bed:
    // first-wins made seven 45-second events and then ninety-two 3-second ones.
    const atoms = Array.from({ length: 200 }, (_, i) => atom(i * 3000, (i + 1) * 3000));
    const plain = { utterances: [], audioEvents: [] };
    expect(spread(segmentAtoms(atoms, plain, { balancedTies: true }))).toBeLessThanOrEqual(2);
    expect(spread(segmentAtoms(atoms, plain))).toBeGreaterThan(5);
  });

  it('balances ties for an edited asset and leaves raw footage on the rule it has', () => {
    const observed = observations({ shots: cutEvery(Array.from({ length: 40 }, () => 3000)) });
    const recording = { ...asset, duration_ms: 120_000 };
    const asEdit = segmentAssets([recording], observed, [], {}, undefined, placement, edited);
    const asRaw = segmentAssets([recording], observed, [], {}, undefined, placement);
    expect(spread(asEdit)).toBeLessThanOrEqual(2);
    expect(spread(asRaw)).toBeGreaterThan(2);
  });
});

describe('a take longer than an event may be', () => {
  it('is divided where the picture changes, so six slides are six events', () => {
    // The screen-recording probe: one 60 s shot, the picture still between slide
    // changes every ten seconds. It was one event, and OCR read one slide of six.
    const observed = observations({
      shots: [shot('shot_001', 0, 60_000)],
      video_events: [0, 1, 2, 3, 4, 5].map((i) => ({
        id: `vev_${i}`,
        asset_id: 'asset_001',
        start_ms: i * 10_000 + 2200,
        end_ms: (i + 1) * 10_000,
        event_type: 'static' as const,
        confidence: 0.9,
      })),
    });
    const drafts = segmentAssets([asset], observed, [], {}, undefined, placement, [
      { asset_id: 'asset_001', kind: 'screen_recording' },
    ]);
    expect(drafts.map((d) => d.start_ms)).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000]);
    expect(drafts.slice(1).every((d) => d.method === 'similarity')).toBe(true);
  });

  it('is divided at the pauses between utterances when the picture says nothing', () => {
    const talk = (id: string, start: number, end: number): Utterance => ({
      id,
      asset_id: 'asset_001',
      start_ms: start,
      end_ms: end,
      text: 'still talking about the same thing',
      confidence: 0.9,
    });
    const observed = observations({
      shots: [shot('shot_001', 0, 90_000)],
      utterances: [
        talk('utt_1', 1000, 28_000),
        talk('utt_2', 33_000, 58_000),
        talk('utt_3', 63_000, 89_000),
      ],
    });
    const drafts = segmentAssets(
      [{ ...asset, duration_ms: 90_000 }],
      observed,
      [],
      {},
      undefined,
      placement,
    );
    expect(drafts.map((d) => d.start_ms)).toEqual([0, 30_500, 60_500]);
    expect(drafts.slice(1).every((d) => d.method === 'speech')).toBe(true);
  });

  it('is divided into the fewest equal parts that fit when nothing marks a change', () => {
    // A ten-minute take with no evidence at all used to be one ten-minute event.
    const drafts = segmentAssets(
      [{ ...asset, duration_ms: 600_000 }],
      observations({ shots: [shot('shot_001', 0, 600_000)] }),
      [],
      {},
      undefined,
      placement,
    );
    expect(drafts).toHaveLength(14);
    for (const draft of drafts) expect(draft.end_ms - draft.start_ms).toBeLessThanOrEqual(45_000);
    expect(drafts[0]!.start_ms).toBe(0);
    expect(drafts.at(-1)!.end_ms).toBe(600_000);
    for (let i = 1; i < drafts.length; i++) expect(drafts[i]!.start_ms).toBe(drafts[i - 1]!.end_ms);
  });

  it('leaves every atom that already fits exactly as it was', () => {
    // The worked example's longest shot is 41.5 s, which is why its events do
    // not move.
    const atoms = [atom(0, 41_500), atom(41_500, 45_000)];
    expect(subdivideLongAtoms(atoms, { visual: [10_000], pauses: [], silences: [] })).toEqual(
      atoms,
    );
  });
});
