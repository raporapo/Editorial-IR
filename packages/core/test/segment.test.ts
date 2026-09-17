import { describe, expect, it } from 'vitest';
import type { MediaAsset, ObservationTimeline, Shot } from '@editorial-ir/contracts';
import {
  buildAtoms,
  segmentAssets,
  segmentAtoms,
  separationScore,
  signalsAt,
  type Atom,
} from '../src/index.js';

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

function shot(id: string, start: number, end: number, changeScore?: number): Shot {
  return {
    id,
    asset_id: 'asset_001',
    start_ms: start,
    end_ms: end,
    representative_frame_ms: start + Math.floor((end - start) / 3),
    ...(changeScore === undefined ? {} : { change_score: changeScore }),
  };
}

function observations(overrides: Partial<ObservationTimeline> = {}): ObservationTimeline {
  return {
    project_id: 'prj_test',
    fingerprint: 'test',
    pipeline_version: '0.1.0',
    generated_at: '2026-09-16T00:00:00.000Z',
    model_runs: [],
    failures: [],
    utterances: [],
    shots: [],
    audio_events: [],
    ocr: [],
    frame_features: [],
    audio_profiles: [],
    ...overrides,
  };
}

function atom(start: number, end: number, changeScore?: number): Atom {
  return {
    asset_id: 'asset_001',
    start_ms: start,
    end_ms: end,
    shot_ids: [`shot_${start}`],
    representative_frame_ms: start + Math.floor((end - start) / 3),
    ...(changeScore === undefined ? {} : { change_score: changeScore }),
  };
}

describe('buildAtoms', () => {
  it('uses shots when there are shots', () => {
    const atoms = buildAtoms(asset, [shot('shot_1', 0, 5000), shot('shot_2', 5000, 12_000)]);
    expect(atoms).toHaveLength(2);
    expect(atoms[0]!.shot_ids).toEqual(['shot_1']);
  });

  it('falls back to fixed windows, so a machine without shot detection still gets events', () => {
    const atoms = buildAtoms(asset, []);
    expect(atoms.length).toBeGreaterThan(1);
    expect(atoms.at(-1)!.end_ms).toBe(60_000);
    // A single forty-minute event is not an event.
    for (const a of atoms) expect(a.end_ms - a.start_ms).toBeLessThanOrEqual(9000);
  });

  it('produces nothing for a zero-length asset', () => {
    expect(buildAtoms({ ...asset, duration_ms: 0 }, [])).toEqual([]);
  });
});

describe('separationScore', () => {
  it('treats a sentence crossing the boundary as almost no separation', () => {
    expect(separationScore({ speechSpanning: true, visual: 1, shotChange: 1 })).toBeLessThan(0.1);
  });

  it('honours a boundary the user demanded, whatever the signals say', () => {
    expect(separationScore({ forced: 'split', speechSpanning: true })).toBe(1);
    expect(separationScore({ forced: 'merge', visual: 1 })).toBe(0);
  });

  it('renormalises over the signals that exist', () => {
    // With only a shot change available, a strong one must still read as strong.
    expect(separationScore({ shotChange: 0.9 })).toBeCloseTo(0.9, 6);
    // Adding an agreeing signal does not weaken it.
    expect(separationScore({ shotChange: 0.9, visual: 0.9 })).toBeCloseTo(0.9, 6);
  });

  it('is neutral when nothing is known', () => {
    expect(separationScore({})).toBe(0.5);
  });

  it('stays inside [0,1]', () => {
    expect(
      separationScore({ visual: 1, silence: 1, shotChange: 1, topic: 1, speakerChange: 1 }),
    ).toBeLessThanOrEqual(1);
    expect(
      separationScore({ visual: 0, silence: 0, shotChange: 0, topic: 0, speakerChange: 0 }),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('signalsAt', () => {
  it('sees a sentence spanning the boundary', () => {
    const signals = signalsAt(atom(0, 5000), atom(5000, 10_000), {
      utterances: [
        {
          id: 'utt_1',
          asset_id: 'asset_001',
          start_ms: 3000,
          end_ms: 7000,
          text: 'still talking',
          confidence: 0.9,
        },
      ],
      audioEvents: [],
    });
    expect(signals.speechSpanning).toBe(true);
  });

  it('sees a pause at the boundary', () => {
    const signals = signalsAt(atom(0, 5000), atom(5000, 10_000), {
      utterances: [],
      audioEvents: [
        {
          id: 'aev_1',
          asset_id: 'asset_001',
          start_ms: 4600,
          end_ms: 5600,
          event_type: 'silence',
          confidence: 0.8,
        },
      ],
    });
    expect(signals.silence).toBeGreaterThan(0.5);
  });

  it('sees a change of speaker', () => {
    const signals = signalsAt(atom(0, 5000), atom(5000, 10_000), {
      utterances: [
        {
          id: 'utt_1',
          asset_id: 'asset_001',
          start_ms: 1000,
          end_ms: 4000,
          speaker_id: 'A',
          text: 'hello',
          confidence: 0.9,
        },
        {
          id: 'utt_2',
          asset_id: 'asset_001',
          start_ms: 6000,
          end_ms: 9000,
          speaker_id: 'B',
          text: 'goodbye',
          confidence: 0.9,
        },
      ],
      audioEvents: [],
    });
    expect(signals.speakerChange).toBe(1);
  });

  it('sees a visual change when a vision model supplied one', () => {
    const signals = signalsAt(atom(0, 5000), atom(5000, 10_000), {
      utterances: [],
      audioEvents: [],
      frameSimilarity: () => 0.2,
    });
    expect(signals.visual).toBeCloseTo(0.8, 6);
  });
});

describe('segmentAtoms', () => {
  const plain = { utterances: [], audioEvents: [] };

  it('never produces an event shorter than the minimum', () => {
    const atoms = [atom(0, 900), atom(900, 1800), atom(1800, 12_000)];
    const segments = segmentAtoms(atoms, plain, { minEventMs: 2000 });
    for (const segment of segments)
      expect(segment.end_ms - segment.start_ms).toBeGreaterThanOrEqual(2000);
  });

  it('never produces an event longer than the maximum', () => {
    const atoms = Array.from({ length: 20 }, (_, i) => atom(i * 3000, (i + 1) * 3000));
    const segments = segmentAtoms(atoms, plain, { maxEventMs: 20_000 });
    for (const segment of segments)
      expect(segment.end_ms - segment.start_ms).toBeLessThanOrEqual(20_000);
  });

  it('covers the whole asset with no gaps and no overlaps', () => {
    const atoms = Array.from({ length: 12 }, (_, i) => atom(i * 4000, (i + 1) * 4000));
    const segments = segmentAtoms(atoms, plain);
    expect(segments[0]!.start_ms).toBe(0);
    expect(segments.at(-1)!.end_ms).toBe(48_000);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.start_ms).toBe(segments[i - 1]!.end_ms);
    }
  });

  it('keeps a strong boundary and merges a weak one', () => {
    const atoms = [atom(0, 6000), atom(6000, 12_000, 0.05), atom(12_000, 18_000, 0.95)];
    const segments = segmentAtoms(atoms, plain, { mergeThreshold: 0.5, minEventMs: 1000 });
    // The near-identical pair collapses; the sharp change survives.
    expect(segments).toHaveLength(2);
    expect(segments[0]!.end_ms).toBe(12_000);
  });

  it('will not merge across a boundary the user demanded', () => {
    const atoms = [atom(0, 4000), atom(4000, 8000, 0.02)];
    const segments = segmentAtoms(atoms, { ...plain, forcedSplits: [4000] }, { minEventMs: 1000 });
    expect(segments).toHaveLength(2);
    expect(segments[1]!.method).toBe('user');
  });

  it('merges where the user demanded it, even across a sharp cut', () => {
    const atoms = [atom(0, 4000), atom(4000, 8000, 0.99)];
    const segments = segmentAtoms(
      atoms,
      { ...plain, forcedMerges: [4000] },
      { mergeThreshold: 0.1 },
    );
    expect(segments).toHaveLength(1);
  });

  it('keeps a sentence and its shots together', () => {
    const atoms = [atom(0, 3000), atom(3000, 6000), atom(6000, 9000)];
    const segments = segmentAtoms(
      atoms,
      {
        utterances: [
          {
            id: 'utt_1',
            asset_id: 'asset_001',
            start_ms: 1000,
            end_ms: 8000,
            text: 'one long sentence',
            confidence: 0.9,
          },
        ],
        audioEvents: [],
      },
      { minEventMs: 1000, mergeThreshold: 0.3 },
    );
    expect(segments).toHaveLength(1);
  });

  it('keeps the number of events proportional to the material', () => {
    const atoms = Array.from({ length: 60 }, (_, i) => atom(i * 2000, (i + 1) * 2000, 0.9));
    // Two minutes of sharply cut footage should not become sixty events.
    const segments = segmentAtoms(atoms, plain, { targetEventMs: 9000 });
    expect(segments.length).toBeLessThanOrEqual(Math.ceil((120_000 / 9000) * 1.5));
    expect(segments.length).toBeGreaterThan(3);
  });

  it('is deterministic', () => {
    const atoms = Array.from({ length: 15 }, (_, i) => atom(i * 3000, (i + 1) * 3000, (i % 4) / 4));
    expect(JSON.stringify(segmentAtoms(atoms, plain))).toBe(
      JSON.stringify(segmentAtoms(atoms, plain)),
    );
  });

  it('returns nothing for no atoms', () => {
    expect(segmentAtoms([], plain)).toEqual([]);
  });
});

describe('segmentAssets', () => {
  it('never lets an event straddle two recordings', () => {
    const second: MediaAsset = {
      ...asset,
      id: 'asset_002',
      file_name: 'b.mov',
      sha256: 'b'.repeat(64),
    };
    const segments = segmentAssets(
      [asset, second],
      observations({
        shots: [
          shot('shot_1', 0, 30_000),
          shot('shot_2', 30_000, 60_000),
          { ...shot('shot_3', 0, 60_000), asset_id: 'asset_002' },
        ],
      }),
      [],
    );
    for (const segment of segments) {
      expect(['asset_001', 'asset_002']).toContain(segment.asset_id);
    }
    expect(segments.some((s) => s.asset_id === 'asset_001')).toBe(true);
    expect(segments.some((s) => s.asset_id === 'asset_002')).toBe(true);
  });

  it('produces events for an asset with no shots at all', () => {
    const segments = segmentAssets([asset], observations(), []);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.at(-1)!.end_ms).toBe(60_000);
  });

  describe('a boundary the user demanded', () => {
    const second: MediaAsset = {
      ...asset,
      id: 'asset_002',
      file_name: 'b.mov',
      sha256: 'b'.repeat(64),
    };
    // Laid end to end, the way placeAssets does it.
    const placements = [
      { asset_id: 'asset_001', offset_ms: 0, order: 0, ordered_by: 'creation_time' as const },
      { asset_id: 'asset_002', offset_ms: 61_000, order: 1, ordered_by: 'creation_time' as const },
    ];
    const shots = observations({
      shots: [
        shot('shot_1', 0, 30_000),
        shot('shot_2', 30_000, 60_000),
        { ...shot('shot_3', 0, 30_000), asset_id: 'asset_002' },
        { ...shot('shot_4', 30_000, 60_000), asset_id: 'asset_002' },
      ],
    });
    const split = (atMs: number) => [
      {
        id: 'ann_1',
        type: 'boundary' as const,
        action: 'split' as const,
        target: { kind: 'time_range' as const, start_ms: atMs, end_ms: atMs + 1000 },
        anchor: [],
        priority: 0,
        created_at: '2026-05-17T09:00:00.000Z',
      },
    ];

    it('is read in capture time, which is the only time the user can write', () => {
      // `oea annotate` offers no syntax for an asset-local time, and its own help
      // calls a bare range "a stretch of the capture timeline". This value was
      // passed through unconverted, so a split at 00:10:00 was compared against
      // ten minutes into every file rather than ten minutes into the recording.
      const segments = segmentAssets(
        [asset, second],
        shots,
        split(76_000),
        {},
        undefined,
        placements,
      );
      const forced = segments.filter((s) => s.method === 'user');

      expect(forced).toHaveLength(1);
      // 76s capture is 15s into the second recording.
      expect(forced[0]!.asset_id).toBe('asset_002');
      expect(forced[0]!.start_ms).toBe(15_000);
    });

    it('applies to the one recording it lands in, not to every recording', () => {
      const segments = segmentAssets(
        [asset, second],
        shots,
        split(15_000),
        {},
        undefined,
        placements,
      );
      const forced = segments.filter((s) => s.method === 'user');

      expect(forced).toHaveLength(1);
      expect(forced[0]!.asset_id).toBe('asset_001');
    });

    it('cuts the shot rather than looking for a nearby one', () => {
      // A forced split used to be honoured only at an existing atom edge, so
      // "split here" quietly meant "split here if a shot change happens to be
      // within six hundred milliseconds". The user saw two moments where the
      // camera saw one take; that is the correction this exists to accept.
      const single = observations({ shots: [shot('shot_1', 0, 60_000)] });
      const segments = segmentAssets([asset], single, split(20_000), {}, undefined, [
        placements[0]!,
      ]);

      expect(segments.length).toBeGreaterThan(1);
      expect(segments.some((s) => s.start_ms === 20_000 && s.method === 'user')).toBe(true);
    });

    it('ignores a time that falls outside every recording', () => {
      const segments = segmentAssets(
        [asset, second],
        shots,
        split(999_000),
        {},
        undefined,
        placements,
      );
      expect(segments.some((s) => s.method === 'user')).toBe(false);
    });

    it('keeps an asset-scoped time in that asset’s own frame', () => {
      const scoped = [
        {
          id: 'ann_1',
          type: 'boundary' as const,
          action: 'split' as const,
          target: {
            kind: 'time_range' as const,
            asset_id: 'asset_002',
            start_ms: 15_000,
            end_ms: 16_000,
          },
          anchor: [],
          priority: 0,
          created_at: '2026-05-17T09:00:00.000Z',
        },
      ];
      const segments = segmentAssets([asset, second], shots, scoped, {}, undefined, placements);
      const forced = segments.filter((s) => s.method === 'user');

      expect(forced).toHaveLength(1);
      expect(forced[0]!.asset_id).toBe('asset_002');
      expect(forced[0]!.start_ms).toBe(15_000);
    });
  });
});
