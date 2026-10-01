import { describe, expect, it } from 'vitest';
import {
  EMPTY_OBSERVATIONS,
  PIPELINE_VERSION,
  type ObservationTimeline,
  type OcrObservation,
  type Shot,
  type VideoEvent,
} from '@editorial-ir/contracts';
import {
  MAX_EXTRA_OCR_READS,
  ocrTimestamps,
  readUntil,
  takeEvidence,
  type InactiveSpan,
} from '../src/index.js';

/**
 * Where on-screen text is read, measured against the probes that broke it.
 *
 * Text was read at one frame per shot. The 60 s screen recording of six slides
 * was one shot, read at 20 s, and five slides were never read; burned-in
 * subtitles under a long take were read once for the whole take.
 */

const video = { id: 'asset_001', kind: 'video' as const, duration_ms: 60_000 };

function shot(
  start: number,
  end: number,
  representative = start + Math.floor((end - start) / 3),
): Shot {
  return {
    id: `shot_${String(start).padStart(6, '0')}`,
    asset_id: 'asset_001',
    start_ms: start,
    end_ms: end,
    representative_frame_ms: representative,
  };
}

function still(start: number, end: number): VideoEvent {
  return {
    id: `vev_${String(start).padStart(6, '0')}`,
    asset_id: 'asset_001',
    start_ms: start,
    end_ms: end,
    event_type: 'static',
    confidence: 0.9,
  };
}

/** The screen-recording probe as measured: one shot, a cursor for 2 s of each slide. */
const slides = [0, 1, 2, 3, 4, 5].map((i) => still(i * 10_000 + 2200, (i + 1) * 10_000));

describe('reading on-screen text', () => {
  it('reads every slide of a one-shot screen recording, once each, before it changes', () => {
    const { kept } = ocrTimestamps([shot(0, 60_000, 20_000)], slides, [], video);
    expect(kept).toEqual([9500, 19_500, 20_000, 29_500, 39_500, 49_500, 59_500]);
    // Every slide has a read inside the time it is on screen.
    for (let i = 0; i < 6; i++) {
      expect(kept.some((t) => t >= i * 10_000 && t < (i + 1) * 10_000)).toBe(true);
    }
  });

  it('reads a long moving take every five seconds, for the subtitles under it', () => {
    // Measured on a 40 s take with ten 4 s subtitle lines: one read found one
    // line; these seven found seven.
    const { kept } = ocrTimestamps([shot(0, 40_000, 13_333)], [], [], {
      ...video,
      duration_ms: 40_000,
    });
    expect(kept).toEqual([5000, 10_000, 13_333, 20_000, 25_000, 30_000, 35_000]);
  });

  it('leaves a short shot to its one read, as it always was', () => {
    const shots = [shot(0, 4000), shot(4000, 9000), shot(9000, 12_000)];
    expect(ocrTimestamps(shots, [], [], video).kept).toEqual([1333, 5666, 10_000]);
  });

  it('reads a long still stretch every ten seconds, not every five, and not once', () => {
    // Nothing on screen can change without ending a still stretch (a subtitle
    // change moved the thumbnail by 3.2-4.7 against a threshold of 0.5), so
    // five seconds would read each still picture twice; one read for a whole
    // minute is what a fade under the threshold could hide in.
    const { kept } = ocrTimestamps([shot(0, 60_000, 20_000)], [still(0, 60_000)], [], video);
    // Back from the end in tens, but not beside the shot's own read at 20 s.
    expect(kept).toEqual([9500, 20_000, 29_500, 39_500, 49_500, 59_500]);
  });

  it('thins a still, silent span to one read per ten seconds, where it was one per span', () => {
    // A camera left on a table: the shot detector finds cuts in its noise.
    const shots = Array.from({ length: 30 }, (_, i) => shot(i * 2000, (i + 1) * 2000));
    const quiet: InactiveSpan[] = [{ asset_id: 'asset_001', start_ms: 500, end_ms: 59_500 }];
    const { kept, dropped } = ocrTimestamps(shots, [], quiet, video);
    expect(kept).toEqual([666, 10_666, 20_666, 30_666, 40_666, 50_666]);
    expect(dropped).toBe(24);
  });

  it('spends a capped number of reads on a very long take, the changes of picture first', () => {
    const hours = 2 * 3600_000;
    const changes = Array.from({ length: 150 }, (_, i) =>
      still(i * 40_000 + 5000, i * 40_000 + 35_000),
    );
    const { kept } = ocrTimestamps([shot(0, hours, 1000)], changes, [], {
      ...video,
      duration_ms: hours,
    });
    expect(kept.length).toBe(1 + MAX_EXTRA_OCR_READS);
    // The cap went to the changes of picture, spread through the whole file.
    expect(kept.at(-1)).toBe(149 * 40_000 + 34_500);
  });

  it('reads a still at its only frame, and nothing in a file with no picture', () => {
    expect(
      ocrTimestamps([], [], [], { id: 'asset_002', kind: 'image', duration_ms: 0 }).kept,
    ).toEqual([0]);
    expect(
      ocrTimestamps([], [], [], { id: 'asset_003', kind: 'audio', duration_ms: 9000 }).kept,
    ).toEqual([]);
  });
});

describe('how long text read at a moment was on screen', () => {
  it('ends when the picture changed, not a second later', () => {
    // Read at 9.5 s and said to last until 10.5 s, slide one was attached to the
    // event of slide two, and every event after the first was described with
    // the slide before it.
    const spans = [{ start: 2200, end: 10_000 }];
    expect(readUntil({ start_ms: 9500, end_ms: 10_500 }, spans)).toBe(10_000);
    expect(readUntil({ start_ms: 5000, end_ms: 6000 }, spans)).toBe(6000);
    expect(readUntil({ start_ms: 11_000, end_ms: 12_000 }, spans)).toBe(12_000);
  });
});

describe('a change of slide text between two reads', () => {
  function timeline(reads: [number, string][], events: VideoEvent[]): ObservationTimeline {
    return {
      ...EMPTY_OBSERVATIONS,
      project_id: 'p',
      fingerprint: 'f',
      pipeline_version: PIPELINE_VERSION,
      generated_at: '2026-09-01T00:00:00.000Z',
      video_events: events,
      ocr: reads.map(([at, text], i): OcrObservation => ({
        id: `ocr_${String(i + 1).padStart(5, '0')}`,
        asset_id: 'asset_001',
        start_ms: at,
        end_ms: at + 500,
        text,
        confidence: 0.9,
      })),
    };
  }

  it('is placed where the picture changed, not halfway between the reads', () => {
    // Measured on the screen recording once every slide was read: midpoints
    // put boundaries at 44.5 and 54.5 s against slide changes at 40 and 50.
    const observed = timeline(
      [
        [39_500, 'oea analyze --project ./demo'],
        [49_500, 'Timeline evt_0001 arrival at the station'],
        [59_500, 'Summary install analyze plan'],
      ],
      [still(32_200, 40_000), still(42_200, 50_000), still(52_200, 60_000)],
    );
    expect(takeEvidence('asset_001', observed).visual).toEqual([40_000, 50_000, 60_000]);
  });

  it('is halfway between the reads when nothing measured the picture changing', () => {
    const observed = timeline(
      [
        [10_000, 'Platform 3 departures'],
        [20_000, 'Exit to the harbour'],
      ],
      [],
    );
    expect(takeEvidence('asset_001', observed).visual).toEqual([15_000]);
  });
});
