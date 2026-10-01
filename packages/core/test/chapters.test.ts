import { describe, expect, it } from 'vitest';
import type { MediaAsset, SemanticEvent } from '@editorial-ir/contracts';
import { buildChapters } from '../src/index.js';
import { makeAsset, makeEvent, type EventSpec } from '../../../tests/support/ir.js';

/**
 * Chapters on material that is not one long recording.
 *
 * Every rule here was measured wrong on a probe file: a folder of eight clips
 * came out as one chapter titled `90010:00:60`, an edited programme's second
 * title card ended its first chapter and named it, and twenty changes of subject
 * in one recording came out as chapters of [18, 2, 2, ...].
 */
function events(specs: (EventSpec & { card?: boolean })[]): SemanticEvent[] {
  let at = 0;
  return specs.map((spec, index) => {
    const duration = spec.duration_ms ?? 8000;
    const event = makeEvent({ start_ms: at, duration_ms: duration, ...spec }, index);
    at = event.end_ms + (spec.asset_id !== specs[index + 1]?.asset_id ? 1000 : 0);
    return spec.card
      ? { ...event, segmentation: { method: 'title_card', boundary_confidence: 1 } }
      : event;
  });
}

function sizes(chapters: { event_ids: string[] }[]): number[] {
  return chapters.map((chapter) => chapter.event_ids.length);
}

describe('title cards', () => {
  const programme = events([
    { description: 'harbour at dawn', event_type: 'b_roll', ocr: ['HARBOUR DAYS'], card: true },
    { description: 'harbour at dawn boats', event_type: 'b_roll' },
    { description: 'harbour at dawn market', event_type: 'b_roll' },
    { description: 'harbour at dawn rain', event_type: 'b_roll', ocr: ['CHAPTERTWO'], card: true },
    { description: 'harbour at dawn noodles', event_type: 'b_roll' },
    { description: 'harbour at dawn lighthouse', event_type: 'b_roll' },
  ]);

  it('start a chapter, and name it, rather than ending the one before', () => {
    const { chapters } = buildChapters(programme);
    expect(sizes(chapters)).toEqual([3, 3]);
    expect(chapters.map((c) => c.title.value)).toEqual(['HARBOUR DAYS', 'CHAPTERTWO']);
  });

  it('carry what follows when they stand alone, instead of joining what came before', () => {
    // A card that is only a card, followed by a change of subject, is a group of
    // one, and one-event groups are folded away; folded backwards, the card
    // became the last event of the chapter before and named it.
    const alone = events([
      { description: 'harbour', event_type: 'b_roll', places: ['harbour'] },
      { description: 'harbour', event_type: 'b_roll', places: ['harbour'] },
      {
        description: 'card',
        event_type: 'title',
        ocr: ['PART TWO'],
        card: true,
        duration_ms: 1500,
      },
      { description: 'lighthouse', event_type: 'b_roll', places: ['lighthouse'] },
      { description: 'lighthouse', event_type: 'b_roll', places: ['lighthouse'] },
    ]);
    const { chapters } = buildChapters(alone);
    expect(sizes(chapters)).toEqual([2, 3]);
    expect(chapters.map((c) => c.title.value)).toEqual(['harbour', 'PART TWO']);
  });

  it('keep a section the programme marked as a chapter, however short', () => {
    // The edited probe in the worker: its first section came out as one event,
    // and folding it into the next erased the chapter the programme began with.
    const sections = events([
      { description: 'harbour at dawn', event_type: 'b_roll', ocr: ['HARBOUR DAYS'], card: true },
      { description: 'harbour at dawn', event_type: 'b_roll', ocr: ['CHAPTERTWO'], card: true },
      { description: 'harbour at dawn', event_type: 'b_roll' },
      { description: 'harbour at dawn', event_type: 'b_roll' },
    ]);
    const { chapters } = buildChapters(sections);
    expect(sizes(chapters)).toEqual([1, 3]);
    expect(chapters.map((c) => c.title.value)).toEqual(['HARBOUR DAYS', 'CHAPTERTWO']);
  });
});

describe('a folder of clips', () => {
  const clipAt = (id: string, minutes: number): MediaAsset =>
    makeAsset({
      id,
      file_name: `${id}.mp4`,
      duration_ms: 8000,
      creation_time: new Date(Date.UTC(2026, 8, 1, 9, 0) + minutes * 60_000).toISOString(),
    });

  it('is grouped by real capture time, not one chapter per file', () => {
    // Six clips a few minutes apart in the morning, four in the evening.
    const minutes = [0, 4, 9, 15, 22, 30, 540, 545, 552, 560];
    const assets = minutes.map((m, i) => clipAt(`asset_${String(i + 1).padStart(3, '0')}`, m));
    const list = events(
      assets.map((asset) => ({ asset_id: asset.id, description: 'a walk', event_type: 'b_roll' })),
    );
    const { chapters } = buildChapters(
      list,
      {},
      {
        assets,
        materials: assets.map((a) => ({ asset_id: a.id, kind: 'clip' as const })),
      },
    );
    expect(sizes(chapters)).toEqual([6, 4]);
  });

  it('keeps clips with no capture time together unless something else changes', () => {
    const assets = ['asset_001', 'asset_002', 'asset_003', 'asset_004'].map((id) =>
      makeAsset({ id, duration_ms: 5000 }),
    );
    const list = events(
      assets.map((asset) => ({ asset_id: asset.id, description: 'a walk', event_type: 'b_roll' })),
    );
    const knowledge = {
      assets,
      materials: assets.map((a) => ({ asset_id: a.id, kind: 'clip' as const })),
    };
    expect(buildChapters(list, {}, knowledge).chapters).toHaveLength(1);
    // With one-event chapters allowed, so the fold cannot hide the rule: clips
    // stay together, while the same events with nothing known about the files
    // are one recording each, and each recording is its own moment of the day,
    // as it always was.
    expect(buildChapters(list, { minEvents: 1 }, knowledge).chapters).toHaveLength(1);
    expect(buildChapters(list, { minEvents: 1 }).chapters).toHaveLength(4);
  });

  it('still starts a chapter between recordings made hours apart', () => {
    const assets = [
      makeAsset({
        id: 'asset_001',
        duration_ms: 540_000,
        creation_time: '2026-05-16T08:12:04.000Z',
      }),
      makeAsset({
        id: 'asset_002',
        duration_ms: 660_000,
        creation_time: '2026-05-16T11:41:22.000Z',
      }),
    ];
    const list = events([
      { asset_id: 'asset_001', description: 'morning', event_type: 'travel' },
      { asset_id: 'asset_001', description: 'morning', event_type: 'travel' },
      { asset_id: 'asset_002', description: 'morning', event_type: 'travel' },
      { asset_id: 'asset_002', description: 'morning', event_type: 'travel' },
    ]);
    expect(sizes(buildChapters(list, {}, { assets }).chapters)).toEqual([2, 2]);
  });

  it("measures a gap between two cameras' zone-less times, and never against a UTC one", () => {
    // A zone-less 11:41 read as UTC was three and a half hours after a phone's
    // 08:12Z, a gap nobody measured: the camera's zone is not known.
    const zoneless = (id: string, local: string) =>
      makeAsset({
        id,
        duration_ms: 540_000,
        capture_time: { source: 'exif', precision: 'local', raw: local, local },
      });
    const clips = (assets: MediaAsset[]) => ({
      assets,
      materials: assets.map((a) => ({ asset_id: a.id, kind: 'clip' as const })),
    });
    const list = events([
      { asset_id: 'asset_001', description: 'morning', event_type: 'travel' },
      { asset_id: 'asset_001', description: 'morning', event_type: 'travel' },
      { asset_id: 'asset_002', description: 'morning', event_type: 'travel' },
      { asset_id: 'asset_002', description: 'morning', event_type: 'travel' },
    ]);
    const bothLocal = [
      zoneless('asset_001', '2026-05-16T08:12:04.000'),
      zoneless('asset_002', '2026-05-16T11:41:22.000'),
    ];
    expect(sizes(buildChapters(list, {}, clips(bothLocal)).chapters)).toEqual([2, 2]);
    const mixed = [
      makeAsset({
        id: 'asset_001',
        duration_ms: 540_000,
        creation_time: '2026-05-16T08:12:04.000Z',
      }),
      zoneless('asset_002', '2026-05-16T11:41:22.000'),
    ];
    expect(sizes(buildChapters(list, {}, clips(mixed)).chapters)).toEqual([4]);
  });
});

describe('the chapter cap', () => {
  it('keeps chapters even inside one recording, where every gap is zero', () => {
    // Twenty-four changes of subject, alternating, in one file.
    const list = events(
      Array.from({ length: 48 }, (_, i) => ({
        description: i % 4 < 2 ? 'ramen shop counter' : 'river bridge crossing',
        event_type: i % 4 < 2 ? 'meal' : 'travel',
      })),
    );
    const { chapters } = buildChapters(list, { maxChapters: 12 });
    expect(chapters).toHaveLength(12);
    expect(Math.max(...sizes(chapters))).toBeLessThanOrEqual(2 * Math.min(...sizes(chapters)));
  });
});

describe('chapter titles', () => {
  it('are never a counter or a timecode burned into the picture', () => {
    const list = events([
      { description: 'clip', event_type: 'b_roll', ocr: ['90010:00:60', 'BE', 'Harbour Market'] },
      { description: 'clip', event_type: 'b_roll', ocr: ['00:00:10.008'] },
    ]);
    expect(buildChapters(list).chapters[0]!.title.value).toBe('Harbour Market');
  });
});
