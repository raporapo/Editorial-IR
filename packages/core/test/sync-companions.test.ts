import { describe, expect, it } from 'vitest';
import {
  EMPTY_OBSERVATIONS,
  type AudioSync,
  type ObservationTimeline,
  type Utterance,
} from '@editorial-ir/contracts';
import {
  MAX_SYNC_PAIRS,
  audioCompanions,
  declaredSyncs,
  measureSync,
  recordersCovered,
  sameMoments,
  syncPairs,
  videoOffsets,
  withCompanionSpeech,
  type SyncCandidate,
} from '../src/sync.js';
import { makeEvent } from '../../../tests/support/ir.js';

/**
 * A separate recorder as the sound of a camera: which pairs are compared, which
 * recorder a video takes, and what the video's events then hear.
 *
 * The measurement itself is tested in sync.test.ts; these tests take its answers
 * as given and check what is done with them.
 */

const camera = { id: 'asset_cam', file_name: 'C0001.MP4', kind: 'video', duration_ms: 60_000 };
const recorder = {
  id: 'asset_rec',
  file_name: 'ZOOM0001.WAV',
  kind: 'audio',
  duration_ms: 90_000,
};
const assets = [camera, recorder];

function sync(overrides: Partial<AudioSync> = {}): AudioSync {
  return {
    asset_id: recorder.id,
    reference_asset_id: camera.id,
    // The recorder was started 3.2 s before the camera.
    offset_ms: -3_200,
    score: 4,
    confidence: 0.8,
    method: 'onset_xcorr',
    ...overrides,
  };
}

function candidate(overrides: Partial<SyncCandidate> & { asset_id: string }): SyncCandidate {
  return { kind: 'video', duration_ms: 60_000, hasAudio: true, ...overrides };
}

describe('syncPairs', () => {
  it('compares every recorder with every video that has sound, and nothing silent', () => {
    const { pairs, skipped } = syncPairs([
      candidate({ asset_id: 'b_cam' }),
      candidate({ asset_id: 'a_cam' }),
      candidate({ asset_id: 'drone', hasAudio: false }),
      candidate({ asset_id: 'photo', kind: 'image', duration_ms: 0, hasAudio: false }),
      candidate({ asset_id: 'rec', kind: 'audio' }),
    ]);
    expect(pairs).toEqual([
      ['rec', 'a_cam'],
      ['rec', 'b_cam'],
    ]);
    expect(skipped).toBe(0);
  });

  it('compares two cameras only when their capture times overlap', () => {
    const at = (iso: string) => ({ creation_time: iso });
    const { pairs } = syncPairs([
      candidate({ asset_id: 'a', ...at('2026-05-01T10:00:00Z') }),
      // Started 30 s into the first: the same moment from another angle.
      candidate({ asset_id: 'b', ...at('2026-05-01T10:00:30Z') }),
      // An hour later: another scene.
      candidate({ asset_id: 'c', ...at('2026-05-01T11:00:00Z') }),
      // No clock: no reason to think it overlaps anything.
      candidate({ asset_id: 'd' }),
    ]);
    expect(pairs).toEqual([['b', 'a']]);
  });

  it('says how many pairs a cap left out, and leaves out the same ones every time', () => {
    const many = [
      ...Array.from({ length: 30 }, (_, i) =>
        candidate({ asset_id: `cam_${String(i).padStart(2, '0')}` }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        candidate({ asset_id: `rec_${String(i).padStart(2, '0')}`, kind: 'audio' }),
      ),
    ];
    const first = syncPairs(many);
    expect(first.pairs).toHaveLength(MAX_SYNC_PAIRS);
    expect(first.skipped).toBe(600 - MAX_SYNC_PAIRS);
    expect(syncPairs([...many].reverse())).toEqual(first);
  });
});

describe('measureSync', () => {
  it('refuses an alignment where the two barely overlap', () => {
    // Two short envelopes whose only agreement is at the very edge of the search.
    const a = [-60, -60, -20, -60, ...new Array<number>(40).fill(-60)];
    const b = [...new Array<number>(40).fill(-60), -60, -20, -60, -60];
    expect(measureSync(a, b)).toBeUndefined();
  });
});

describe('audioCompanions', () => {
  it('takes a recorder that covers the video as its sound', () => {
    expect(audioCompanions([sync()], assets)).toEqual([
      {
        asset_id: camera.id,
        audio_asset_id: recorder.id,
        offset_ms: -3_200,
        confidence: 0.8,
        provenance: 'inferred',
      },
    ]);
  });

  it('does not take a recorder that heard less than half of the video', () => {
    // Started 40 s into a 60 s clip: most of the clip would be the camera's own mic.
    const late = sync({ offset_ms: 40_000 });
    expect(audioCompanions([late], assets)).toEqual([]);
  });

  it('takes the better-matched of two recorders, and the first by id on a tie', () => {
    const other = { ...recorder, id: 'asset_arec', file_name: 'LAV.WAV' };
    const both = [sync({ score: 3 }), sync({ asset_id: other.id, score: 5 })];
    expect(audioCompanions(both, [...assets, other])[0]!.audio_asset_id).toBe(other.id);
    const tied = [sync({ score: 4 }), sync({ asset_id: other.id, score: 4 })];
    expect(audioCompanions(tied, [...assets, other])[0]!.audio_asset_id).toBe(other.id);
  });

  it('pairs no two cameras: a second angle is not a recorder', () => {
    const second = { ...camera, id: 'asset_cam2' };
    const angles = sync({ asset_id: second.id });
    expect(audioCompanions([angles], [...assets, second])).toEqual([]);
  });

  it('lets the user’s pairing win however little it covers', () => {
    const other = { ...recorder, id: 'asset_arec' };
    const said = sync({ asset_id: other.id, offset_ms: 50_000, method: 'user', score: 0 });
    const companions = audioCompanions([sync({ score: 9 }), said], [...assets, other]);
    expect(companions).toHaveLength(1);
    expect(companions[0]).toMatchObject({
      audio_asset_id: other.id,
      offset_ms: 50_000,
      provenance: 'user_provided',
    });
  });
});

describe('recordersCovered', () => {
  it('gives a recorder that is mostly some video’s sound no events of its own', () => {
    const companions = audioCompanions([sync()], assets);
    // The 60 s camera covers 60 of the recorder's 90 s.
    expect([...recordersCovered(companions, assets)]).toEqual([recorder.id]);
  });

  it('keeps a recorder that ran long after the camera stopped', () => {
    const long = { ...recorder, duration_ms: 600_000 };
    const companions = audioCompanions([sync()], [camera, long]);
    expect(recordersCovered(companions, [camera, long]).size).toBe(0);
  });

  it('counts a stretch two cameras both covered once', () => {
    const second = { ...camera, id: 'asset_cam2' };
    const companions = audioCompanions(
      [sync(), sync({ reference_asset_id: second.id, offset_ms: -3_300 })],
      [...assets, second],
    );
    const long = { ...recorder, duration_ms: 130_000 };
    // Both cover the same 60 s of a 130 s recorder: under half, not 120 s.
    expect(recordersCovered(companions, [camera, second, long]).size).toBe(0);
  });
});

describe('withCompanionSpeech', () => {
  function utterance(overrides: Partial<Utterance> & { id: string; asset_id: string }): Utterance {
    return {
      start_ms: 0,
      end_ms: 1_000,
      text: '',
      confidence: 0.9,
      ...overrides,
    };
  }
  function timeline(utterances: Utterance[]): ObservationTimeline {
    return {
      ...EMPTY_OBSERVATIONS,
      project_id: 'prj_test',
      pipeline_version: 'test',
      generated_at: '2026-09-25T00:00:00.000Z',
      fingerprint: 'f',
      utterances,
    };
  }

  it('hears the video through its recorder, in the video’s time, words included', () => {
    const observations = timeline([
      // What the camera's own microphone made of it, a metre away.
      utterance({
        id: 'utt_cam',
        asset_id: camera.id,
        start_ms: 10_000,
        end_ms: 12_000,
        text: 'ah',
      }),
      utterance({
        id: 'utt_rec',
        asset_id: recorder.id,
        start_ms: 13_200,
        end_ms: 15_200,
        text: 'good morning',
        words: [
          { text: 'good', start_ms: 13_200, end_ms: 13_700, confidence: 0.9 },
          { text: 'morning', start_ms: 13_800, end_ms: 15_200, confidence: 0.9 },
        ],
      }),
    ]);
    const companions = audioCompanions([sync()], assets);
    const heard = withCompanionSpeech(observations, companions, assets);

    const onCamera = heard.utterances.filter((u) => u.asset_id === camera.id);
    expect(onCamera).toHaveLength(1);
    expect(onCamera[0]).toMatchObject({
      id: 'utt_rec-on-asset_cam',
      text: 'good morning',
      start_ms: 10_000,
      end_ms: 12_000,
    });
    expect(onCamera[0]!.words!.map((w) => [w.start_ms, w.end_ms])).toEqual([
      [10_000, 10_500],
      [10_600, 12_000],
    ]);
    // The recorder's own record is left as it was; the stored observations too.
    expect(heard.utterances.some((u) => u.id === 'utt_rec')).toBe(true);
    expect(observations.utterances.map((u) => u.id)).toEqual(['utt_cam', 'utt_rec']);
  });

  it('leaves what the recorder did not cover to the camera', () => {
    // The recorder starts 30 s into the camera and covers its second half.
    const late = sync({ offset_ms: 30_000 });
    const observations = timeline([
      utterance({ id: 'utt_early', asset_id: camera.id, start_ms: 5_000, end_ms: 6_000 }),
      utterance({ id: 'utt_late', asset_id: camera.id, start_ms: 40_000, end_ms: 41_000 }),
    ]);
    const companions = audioCompanions([late], [camera, { ...recorder, duration_ms: 30_000 }]);
    const heard = withCompanionSpeech(observations, companions, [
      camera,
      { ...recorder, duration_ms: 30_000 },
    ]);
    expect(heard.utterances.map((u) => u.id)).toEqual(['utt_early']);
  });

  it('returns the observations untouched when nothing was paired', () => {
    const observations = timeline([utterance({ id: 'u', asset_id: camera.id })]);
    expect(withCompanionSpeech(observations, [], assets)).toBe(observations);
  });
});

describe('declaredSyncs (background.recorders in context.yaml)', () => {
  it('pairs a camera that recorded no sound, at the offset given', () => {
    const { syncs, notes } = declaredSyncs(
      [],
      [{ recorder: 'ZOOM0001.WAV', video: 'C0001.MP4', offset_ms: -1_500, paired: true }],
      assets,
    );
    expect(notes).toEqual([]);
    expect(syncs).toEqual([sync({ offset_ms: -1_500, score: 0, confidence: 1, method: 'user' })]);
    expect(audioCompanions(syncs, assets)[0]!.provenance).toBe('user_provided');
  });

  it('keeps the measured offset for a pairing that gives none, and sets other recorders aside', () => {
    const other = { ...recorder, id: 'asset_arec', file_name: 'ROOM.WAV' };
    const measured = [sync({ score: 3 }), sync({ asset_id: other.id, score: 8 })];
    const { syncs } = declaredSyncs(
      measured,
      [{ recorder: recorder.id, video: camera.file_name, paired: true }],
      [...assets, other],
    );
    expect(syncs).toEqual([measured[0]]);
  });

  it('removes a pair the user says does not go together', () => {
    const { syncs } = declaredSyncs(
      [sync()],
      [{ recorder: 'ZOOM0001.WAV', video: 'C0001.MP4', paired: false }],
      assets,
    );
    expect(syncs).toEqual([]);
  });

  it('says what it could not apply', () => {
    const { notes } = declaredSyncs(
      [],
      [
        { recorder: 'MISSING.WAV', video: 'C0001.MP4', paired: true },
        { recorder: 'ZOOM0001.WAV', video: 'C0001.MP4', paired: true },
        { recorder: 'C0001.MP4', video: 'ZOOM0001.WAV', offset_ms: 0, paired: true },
      ],
      assets,
    );
    expect(notes).toEqual([
      'background.recorders: no file called "MISSING.WAV"',
      'background.recorders: ZOOM0001.WAV and C0001.MP4 could not be lined up by their sound; ' +
        'give offset_ms to pair them anyway',
      'background.recorders: C0001.MP4 is not a sound-only file',
    ]);
  });
});

describe('two cameras of one moment', () => {
  const second = { id: 'asset_cam2', file_name: 'C0002.MP4', kind: 'video', duration_ms: 20_000 };
  const three = [...assets, second];

  it('lines two cameras up through the recorder both were lined up with', () => {
    // The recorder's zero is 3.2 s before the first camera and 10 s before the
    // second, so the second started 6.8 s into the first.
    const companions = audioCompanions(
      [sync(), sync({ reference_asset_id: second.id, offset_ms: -10_000 })],
      three,
    );
    expect(videoOffsets([], companions, three)).toEqual([
      { asset_id: second.id, reference_asset_id: camera.id, offset_ms: 6_800 },
    ]);
  });

  it('takes a direct measurement between the two, and ignores recorders in it', () => {
    const direct = sync({ asset_id: camera.id, reference_asset_id: second.id, offset_ms: -6_800 });
    // Stored one way round whichever way it was measured.
    expect(videoOffsets([direct, sync()], [], three)).toEqual([
      { asset_id: second.id, reference_asset_id: camera.id, offset_ms: 6_800 },
    ]);
  });

  it('links events that show the same moment, and not the ones beside it', () => {
    const offsets = [{ asset_id: second.id, reference_asset_id: camera.id, offset_ms: 6_800 }];
    const events = [
      // First camera: 10-18 s and 30-38 s of its own time.
      makeEvent({ id: 'evt_a1', asset_id: camera.id, start_ms: 10_000, duration_ms: 8_000 }, 0),
      makeEvent({ id: 'evt_a2', asset_id: camera.id, start_ms: 30_000, duration_ms: 8_000 }, 1),
      // Second camera: 4-12 s of its own, which is 10.8-18.8 s of the first's.
      makeEvent({ id: 'evt_b1', asset_id: second.id, start_ms: 4_000, duration_ms: 8_000 }, 2),
      // 14-20 s of its own: 20.8-26.8 s of the first's, when the first shows nothing kept.
      makeEvent({ id: 'evt_b2', asset_id: second.id, start_ms: 14_000, duration_ms: 6_000 }, 3),
    ];
    expect(sameMoments(events, offsets)).toEqual([
      {
        source_event_id: 'evt_a1',
        target_event_id: 'evt_b1',
        relation_type: 'duplicate_of',
        strength: 0.9,
        provenance: 'inferred',
        note: 'the same moment on another camera, lined up by sound',
      },
    ]);
  });

  it('links nothing when no two videos were lined up', () => {
    const events = [makeEvent({ asset_id: camera.id }, 0), makeEvent({ asset_id: second.id }, 1)];
    expect(sameMoments(events, [])).toEqual([]);
  });
});
