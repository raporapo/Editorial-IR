import { describe, expect, it } from 'vitest';
import type { ObservationTimeline, OcrObservation } from '@editorial-ir/contracts';
import { distinctLines, gatherObservations, isTimecodeLike, textRoles } from '../src/index.js';

/**
 * The text in a picture, read as what it is.
 *
 * The reads below are the ones the Python worker's OCR returned for the edited
 * probe programme: subtitles at the bottom of the frame, two title cards in the
 * middle, and a counter from the test pattern in the corner.
 */
function read(
  id: string,
  startMs: number,
  text: string,
  bbox?: [number, number, number, number],
): OcrObservation {
  return {
    id,
    asset_id: 'asset_001',
    start_ms: startMs,
    end_ms: startMs + 1000,
    text,
    confidence: 0.95,
    ...(bbox ? { bbox } : {}),
  };
}

const BOTTOM: [number, number, number, number] = [0.19, 0.873, 0.62, 0.067];
const MIDDLE: [number, number, number, number] = [0.26, 0.456, 0.49, 0.09];
const CORNER: [number, number, number, number] = [0.001, 0.006, 0.078, 0.023];

const programme = [
  read('ocr_01', 500, 'HARBOUR DAYS', MIDDLE),
  read('ocr_02', 2500, '80010:00:00', CORNER),
  read('ocr_03', 2500, 'We got to the harbour just before dawn', BOTTOM),
  read('ocr_04', 8166, 'The fishing boats were already coming in', BOTTOM),
  read('ocr_05', 18366, 'Thentherain started', BOTTOM),
  read('ocr_06', 19933, 'Then the rain started', BOTTOM),
  read('ocr_07', 31000, 'CHAPTERTWO', MIDDLE),
  read('ocr_08', 32833, '09:09:09.833', CORNER),
  read('ocr_09', 32833, '25', CORNER),
];

function observations(ocr: OcrObservation[]): ObservationTimeline {
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
    ocr,
    frame_features: [],
    audio_profiles: [],
    video_events: [],
    motion_profiles: [],
    syncs: [],
  };
}

describe('isTimecodeLike', () => {
  it('drops the counters a test pattern and a camera overlay burn into the picture', () => {
    for (const junk of ['80010:00:00', '09:09:09.833', '25', "000'20:60:60", '00:00:10.008', '390'])
      expect(isTimecodeLike(junk), junk).toBe(true);
  });

  it('keeps a number that says something, and anything with a letter in it', () => {
    for (const kept of ['29.97', '2026', '1920x1080', 'SHOP', 'ユニバーサルシティ駅', 'Gate 3'])
      expect(isTimecodeLike(kept), kept).toBe(false);
  });
});

describe('textRoles', () => {
  it('tells subtitles, scene text and counters apart by where and how often they appear', () => {
    const roles = textRoles(programme);
    expect(roles.get('ocr_03')).toBe('subtitle');
    expect(roles.get('ocr_06')).toBe('subtitle');
    expect(roles.get('ocr_01')).toBe('scene');
    expect(roles.get('ocr_07')).toBe('scene');
    expect(roles.get('ocr_02')).toBe('junk');
    expect(roles.get('ocr_09')).toBe('junk');
  });

  it('reads one sentence at the bottom of one frame as a sign, not as a subtitle track', () => {
    // Subtitles recur; a banner in shot does not.
    const roles = textRoles([read('ocr_01', 1000, 'Welcome to the harbour festival', BOTTOM)]);
    expect(roles.get('ocr_01')).toBe('scene');
  });

  it('reads text with no box as scene text, which is what the worked example records', () => {
    const roles = textRoles([
      read('ocr_01', 1000, 'UNIVERSAL STUDIOS JAPAN'),
      read('ocr_02', 5000, 'UNIVERSAL STUDIOS JAPAN'),
      read('ocr_03', 9000, 'UNIVERSAL STUDIOS JAPAN'),
    ]);
    expect([...roles.values()]).toEqual(['scene', 'scene', 'scene']);
  });

  it('never calls a word at the bottom of the frame a subtitle, however often it is read', () => {
    const sign = [1000, 5000, 9000].map((ms, i) => read(`ocr_0${i}`, ms, 'SHOP', BOTTOM));
    expect([...textRoles(sign).values()]).toEqual(['scene', 'scene', 'scene']);
  });
});

describe('distinctLines', () => {
  it('keeps one line however OCR spaced or cased it, and the spelling with the most words', () => {
    expect(
      distinctLines([
        'Thentherain started',
        'Then the rain started',
        'Theviewwasworth everystep',
        'The view was worth every step',
        'THE VIEW WAS WORTH EVERY STEP',
      ]),
    ).toEqual(['Then the rain started', 'The view was worth every step']);
  });
});

describe('gatherObservations', () => {
  const draft = {
    asset_id: 'asset_001',
    start_ms: 0,
    end_ms: 34_000,
    shot_ids: [],
    method: 'shot' as const,
    boundary_confidence: 0.9,
  };

  it('puts what was said in subtitles once each, and keeps scene text free of it', () => {
    const observed = gatherObservations(draft, observations(programme));
    expect(observed.subtitles).toEqual([
      'We got to the harbour just before dawn',
      'The fishing boats were already coming in',
      'Then the rain started',
    ]);
    // The title cards are what was shown; the counter is nothing.
    expect(observed.ocr).toEqual(['HARBOUR DAYS', 'CHAPTERTWO']);
  });

  it('adds no subtitles field to footage that has none, so nothing about it changes', () => {
    const observed = gatherObservations(
      draft,
      observations([read('ocr_01', 1000, 'SHOP'), read('ocr_02', 2000, 'SHOP')]),
    );
    expect(observed.subtitles).toBeUndefined();
    expect(observed.ocr).toEqual(['SHOP']);
  });
});
