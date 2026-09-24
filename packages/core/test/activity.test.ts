import { describe, expect, it } from 'vitest';
import {
  EMPTY_OBSERVATIONS,
  type MediaAsset,
  type ObservationTimeline,
} from '@editorial-ir/contracts';
import {
  INACTIVE_MARGIN_MS,
  inactiveMsWithin,
  inactiveSpans,
  isInactive,
  thinTimestamps,
} from '../src/activity.js';
import { makeAsset } from '../../../tests/support/ir.js';

/**
 * Where the footage is still and silent.
 *
 * The rules under test are the ones that make skipping safe: both conditions or
 * nothing, unknown is never inactive, words beat the level meter, and the edges
 * of a span stay active.
 */

function observations(overrides: Partial<ObservationTimeline> = {}): ObservationTimeline {
  return {
    project_id: 'prj_test',
    pipeline_version: '0.1.0',
    generated_at: '2026-09-24T00:00:00.000Z',
    fingerprint: 'test',
    ...EMPTY_OBSERVATIONS,
    ...overrides,
  };
}

const asset: MediaAsset = makeAsset({ id: 'asset_001', duration_ms: 60_000, audio_codec: 'aac' });

const staticEvent = (start: number, end: number, type: 'static' | 'black' = 'static') => ({
  id: `vev_${start}`,
  asset_id: 'asset_001',
  start_ms: start,
  end_ms: end,
  event_type: type,
  confidence: 0.9,
});

const silence = (start: number, end: number) => ({
  id: `aev_${start}`,
  asset_id: 'asset_001',
  start_ms: start,
  end_ms: end,
  event_type: 'silence' as const,
  confidence: 0.9,
});

const motion = { asset_id: 'asset_001', hop_ms: 200, motion: [1], luma: [100] };
/** Room tone for the whole minute: quiet enough for any silence event to count. */
const audioProfile = { asset_id: 'asset_001', hop_ms: 100, rms_db: Array(600).fill(-50) };

describe('inactiveSpans', () => {
  it('finds a stretch that is both still and silent, less its margins', () => {
    const spans = inactiveSpans(
      observations({
        video_events: [staticEvent(10_000, 30_000)],
        audio_events: [silence(5_000, 40_000)],
        motion_profiles: [motion],
        audio_profiles: [audioProfile],
      }),
      [asset],
    );
    expect(spans).toEqual([
      {
        asset_id: 'asset_001',
        start_ms: 10_000 + INACTIVE_MARGIN_MS,
        end_ms: 30_000 - INACTIVE_MARGIN_MS,
      },
    ]);
  });

  it('never skips footage that is silent but moving', () => {
    // Measured: 65-73% of the test footage is silent, and a silent drone shot is
    // what a travel edit is made of.
    const spans = inactiveSpans(
      observations({
        audio_events: [silence(0, 60_000)],
        motion_profiles: [motion],
        audio_profiles: [audioProfile],
      }),
      [asset],
    );
    expect(spans).toEqual([]);
  });

  it('never skips someone talking to a locked-off camera', () => {
    const spans = inactiveSpans(
      observations({
        video_events: [staticEvent(0, 60_000)],
        motion_profiles: [motion],
        audio_profiles: [audioProfile],
      }),
      [asset],
    );
    expect(spans).toEqual([]);
  });

  it('treats words the transcriber heard as louder than the level meter', () => {
    // A whisper under a fan reads as silence to an RMS threshold. The transcript
    // is the better witness.
    const spans = inactiveSpans(
      observations({
        video_events: [staticEvent(0, 60_000)],
        audio_events: [silence(0, 60_000)],
        utterances: [
          {
            id: 'utt_1',
            asset_id: 'asset_001',
            start_ms: 20_000,
            end_ms: 22_000,
            text: 'quietly',
            confidence: 0.8,
          },
        ],
        motion_profiles: [motion],
        audio_profiles: [audioProfile],
      }),
      [asset],
    );
    for (const span of spans) {
      expect(span.end_ms <= 20_000 || span.start_ms >= 22_000).toBe(true);
    }
    expect(spans.length).toBe(2);
  });

  it('treats a picture nobody analysed as unknown, and unknown as active', () => {
    const spans = inactiveSpans(
      observations({ audio_events: [silence(0, 60_000)], audio_profiles: [audioProfile] }),
      [asset],
    );
    expect(spans).toEqual([]);
  });

  it('treats sound nobody analysed as unknown, and unknown as active', () => {
    const spans = inactiveSpans(
      observations({ video_events: [staticEvent(0, 60_000)], motion_profiles: [motion] }),
      [asset],
    );
    expect(spans).toEqual([]);
  });

  it('counts a file with no audio track at all as silent', () => {
    // The only case silence is taken without a measurement: there is nothing to
    // measure. A still, soundless stretch of drone footage is still and soundless.
    const mute = makeAsset({ id: 'asset_001', duration_ms: 60_000 });
    const spans = inactiveSpans(
      observations({ video_events: [staticEvent(10_000, 20_000)], motion_profiles: [motion] }),
      [mute],
    );
    expect(spans.length).toBe(1);
  });

  it('counts a muted track as silent although it has no silence events', () => {
    // The adaptive detector gives a flat recording no silence events on purpose.
    // The absolute floor is what catches a muted clip.
    const spans = inactiveSpans(
      observations({
        video_events: [staticEvent(0, 20_000)],
        motion_profiles: [motion],
        audio_profiles: [{ asset_id: 'asset_001', hop_ms: 100, rms_db: Array(600).fill(-100) }],
      }),
      [asset],
    );
    expect(spans).toEqual([
      { asset_id: 'asset_001', start_ms: INACTIVE_MARGIN_MS, end_ms: 20_000 - INACTIVE_MARGIN_MS },
    ]);
  });

  it('does not count quiet room tone as silent without a silence event', () => {
    const spans = inactiveSpans(
      observations({
        video_events: [staticEvent(0, 20_000)],
        motion_profiles: [motion],
        audio_profiles: [{ asset_id: 'asset_001', hop_ms: 100, rms_db: Array(600).fill(-50) }],
      }),
      [asset],
    );
    expect(spans).toEqual([]);
  });

  it('does not count the quiet between words as silent when music plays under it', () => {
    // The silence detector is relative to its file, so under a music bed the
    // gaps in the narration read as silence. A title card over music is not a
    // lens cap.
    const spans = inactiveSpans(
      observations({
        video_events: [staticEvent(0, 20_000)],
        audio_events: [silence(0, 20_000)],
        motion_profiles: [motion],
        audio_profiles: [{ asset_id: 'asset_001', hop_ms: 100, rms_db: Array(600).fill(-26) }],
      }),
      [asset],
    );
    expect(spans).toEqual([]);
  });

  it('takes the silence events alone when no level was measured', () => {
    // A replayed analysis can carry events and an empty envelope. Nothing
    // measured the level, so nothing can overrule the events.
    const spans = inactiveSpans(
      observations({
        video_events: [staticEvent(0, 20_000)],
        audio_events: [silence(0, 20_000)],
        motion_profiles: [motion],
        audio_profiles: [{ asset_id: 'asset_001', hop_ms: 100, rms_db: [] }],
      }),
      [asset],
    );
    expect(spans.length).toBe(1);
  });

  it('does not count dark as still', () => {
    // A city at night is dark, and in a travel edit it is often the ending.
    // Darkness is recorded; only stillness makes a stretch quiet.
    const spans = inactiveSpans(
      observations({
        video_events: [staticEvent(0, 10_000, 'black')],
        audio_events: [silence(0, 10_000)],
        motion_profiles: [motion],
        audio_profiles: [audioProfile],
      }),
      [asset],
    );
    expect(spans).toEqual([]);
  });

  it('ignores a span too short to be worth skipping', () => {
    const spans = inactiveSpans(
      observations({
        video_events: [staticEvent(10_000, 13_000)],
        audio_events: [silence(0, 60_000)],
        motion_profiles: [motion],
        audio_profiles: [audioProfile],
      }),
      [asset],
    );
    expect(spans).toEqual([]);
  });

  it('never marks a still image', () => {
    const still = makeAsset({ id: 'asset_001', kind: 'image', duration_ms: 0 });
    expect(inactiveSpans(observations(), [still])).toEqual([]);
  });
});

describe('using the spans', () => {
  const spans = [{ asset_id: 'asset_001', start_ms: 10_000, end_ms: 20_000 }];

  it('measures overlap within a range', () => {
    expect(inactiveMsWithin(spans, 'asset_001', 5_000, 15_000)).toBe(5_000);
    expect(inactiveMsWithin(spans, 'asset_002', 5_000, 15_000)).toBe(0);
  });

  it('answers for a single moment', () => {
    expect(isInactive(spans, 'asset_001', 12_000)).toBe(true);
    expect(isInactive(spans, 'asset_001', 20_000)).toBe(false);
  });

  it('thins timestamps inside a span to one, and leaves the rest alone', () => {
    const { kept, dropped } = thinTimestamps(
      [0, 5_000, 10_000, 11_000, 12_000, 19_000, 25_000],
      spans,
      'asset_001',
    );
    expect(kept).toEqual([0, 5_000, 10_000, 25_000]);
    expect(dropped).toBe(3);
  });

  it('changes nothing without spans', () => {
    expect(thinTimestamps([1, 2, 3], [], 'asset_001')).toEqual({ kept: [1, 2, 3], dropped: 0 });
  });
});
