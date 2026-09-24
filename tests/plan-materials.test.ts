import { describe, expect, it } from 'vitest';
import {
  EMPTY_OBSERVATIONS,
  SkillManifest,
  operationTimelineDuration,
  operationTimelineEnd,
  planDurationMs,
  type EditorialIR,
  type MaterialKind,
  type MediaAsset,
  type ObservationTimeline,
  type SkillManifest as Skill,
  type VideoOperation,
} from '@editorial-ir/contracts';
import { SkillRegistry } from '@editorial-ir/skills';
import { planEdit, reviewPlan, validatePlan } from '@editorial-ir/agent';
import { makeAsset, makeIR, type EventSpec } from './support/ir.js';

/**
 * How a plan treats material that is not raw camera footage.
 *
 * Each case is the shape of a probe file that came out wrong: an edited
 * programme cut a few frames off its own edits and exported silent, a phone clip
 * the user trimmed re-trimmed through its first syllable, photographs held as
 * if they had sound, a drone clip with no audio track exported with two audio
 * clips, a take whose pauses a talking-head cut could not take out.
 */

const registry = SkillRegistry.withBuiltIns();

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

/** A skill that ranks by importance alone, so each test decides what matters. */
function skill(fields: Record<string, unknown> = {}): Skill {
  return SkillManifest.parse({
    name: 'probe',
    scoring: { weights: { story_importance: 1 } },
    ...fields,
  });
}

/** An IR whose assets are classified, as `compileProject` leaves them. */
function classified(
  spec: { events: EventSpec[]; assets: MediaAsset[] },
  kinds: Record<string, MaterialKind>,
): EditorialIR {
  const ir = makeIR(spec);
  ir.materials = Object.entries(kinds).map(([asset_id, kind]) => ({
    asset_id,
    kind,
    confidence: 0.9,
    provenance: 'inferred' as const,
    evidence: [],
    signals: {},
  }));
  return ir;
}

const withSound = { audio_codec: 'aac', audio_channels: 2 } as const;

function main(plan: { tracks: { video: VideoOperation[] } }): VideoOperation[] {
  return plan.tracks.video;
}

/* -------------------------------------------------------------------------- */

describe('one definition of silence', () => {
  // A wordless raw shot: the trim opens 1.2 s in (the camera settling) and runs
  // four seconds, to 5.2 s. The only "silence" near that is 200 ms away.
  const ir = () =>
    makeIR({
      assets: [makeAsset({ duration_ms: 60_000, ...withSound })],
      events: [{ start_ms: 0, duration_ms: 20_000 }],
    });
  const quiet = { id: 'aev_1', asset_id: 'asset_001', start_ms: 5400, end_ms: 6000 };
  const plan = (profile?: number) =>
    planEdit({
      ir: ir(),
      skill: skill({ defaults: { min_clip_duration_ms: 2000, max_clip_duration_ms: 6000 } }),
      targetDurationMs: 4000,
      observations: observations({
        audio_events: [{ ...quiet, event_type: 'silence', confidence: 0.9 }],
        ...(profile === undefined
          ? {}
          : {
              audio_profiles: [
                { asset_id: 'asset_001', hop_ms: 100, rms_db: Array(600).fill(profile) },
              ],
            }),
      }),
    });

  it('does not land on a "silence" that a music bed plays straight through', () => {
    // The silence events are relative to the recording; under a bed at -25 dBFS
    // they fire between the words while the music plays on.
    expect(main(plan(-25))[0]).toMatchObject({ source_in_ms: 1200, source_out_ms: 5200 });
  });

  it('lands on real room tone as it always did', () => {
    expect(main(plan(-55))[0]!.source_out_ms).toBe(5400);
  });

  it('leaves an analysis with no level envelope exactly as it was', () => {
    // The worked example records none, and its cuts must not move.
    expect(main(plan())[0]!.source_out_ms).toBe(5400);
  });
});

/* -------------------------------------------------------------------------- */

describe('an edited programme', () => {
  // The probe programme's first five shots.
  const edits = [0, 1500, 4500, 7000, 10_500, 12_500, 16_500];
  const shots = edits.slice(0, -1).map((start, i) => ({
    id: `shot_${i + 1}`,
    asset_id: 'asset_001',
    start_ms: start,
    end_ms: edits[i + 1]!,
    representative_frame_ms: start,
  }));
  const programme = (kind: MaterialKind) =>
    classified(
      {
        assets: [makeAsset({ duration_ms: 16_500, ...withSound })],
        events: [{ start_ms: 0, duration_ms: 16_500 }],
      },
      { asset_001: kind },
    );
  const cut = (kind: MaterialKind, fields: Record<string, unknown> = {}) =>
    planEdit({
      ir: programme(kind),
      skill: skill({
        defaults: { min_clip_duration_ms: 1500, max_clip_duration_ms: 8000, ...fields },
      }),
      targetDurationMs: 5000,
      observations: observations({ shots }),
    });

  it('is cut where it was already cut, from where its event starts', () => {
    const [clip] = main(cut('edited'));
    // It opened 1.2 s into the title card and closed half a second into the
    // next shot.
    expect(clip).toMatchObject({ source_in_ms: 0, source_out_ms: 4500 });
  });

  it('says so in the rationale', () => {
    const plan = cut('edited');
    expect(plan.rationale[0]!.reason).toContain('the edit’s own cuts');
  });

  it('leaves raw footage exactly where it was: its shot changes are camera moves', () => {
    const [clip] = main(cut('raw'));
    expect(clip).toMatchObject({ source_in_ms: 1200, source_out_ms: 6200 });
  });

  it('can be told to snap raw footage too, or not to snap an edit', () => {
    // The settled in point, 1.2 s into the take, moves onto the cut at 1.5 s.
    expect(main(cut('raw', { snap_to_cuts: 'always' }))[0]!.source_in_ms).toBe(1500);
    expect(main(cut('edited', { snap_to_cuts: 'never' }))[0]!.source_out_ms).toBe(5000);
  });

  it('keeps its sound under a skill whose b-roll rule mutes wordless camera footage', () => {
    const travel = registry.resolve('travel-vlog');
    const ir = programme('edited');
    // The heuristic calls a wordless shot b-roll; for a programme it is its bed.
    ir.editorial[0]!.current.flags.b_roll_candidate = 0.9;
    const edited = planEdit({ ir, skill: travel, targetDurationMs: 5000 });
    expect(main(edited).every((o) => o.use_source_audio)).toBe(true);

    const raw = programme('raw');
    raw.editorial[0]!.current.flags.b_roll_candidate = 0.9;
    const camera = planEdit({ ir: raw, skill: travel, targetDurationMs: 5000 });
    expect(main(camera).every((o) => !o.use_source_audio)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('where a wordless clip starts', () => {
  // Twenty wordless seconds, cut to five: a camera settles for 1.2 s first.
  const opening = (kind: MaterialKind) =>
    main(
      planEdit({
        ir: classified(
          {
            assets: [makeAsset({ duration_ms: 20_000, ...withSound })],
            events: [{ start_ms: 0, duration_ms: 20_000 }],
          },
          { asset_001: kind },
        ),
        skill: skill({ defaults: { min_clip_duration_ms: 2000, max_clip_duration_ms: 5000 } }),
        targetDurationMs: 5000,
      }),
    )[0]!.source_in_ms;

  it('skips the first moments of camera footage, while the camera settles', () => {
    expect(opening('raw')).toBe(1200);
  });

  it.each(['edited', 'screen_recording', 'audio_only'] as const)(
    'starts %s material where its event starts: only a camera settles',
    (kind) => {
      // The screen-recording probe opened every slide 1.2 s in, past its first
      // click; the edited one 1.2 s into every shot.
      expect(opening(kind)).toBe(0);
    },
  );
});

/* -------------------------------------------------------------------------- */

describe('a clip the user already trimmed', () => {
  // Speech from 400 ms, as in the probe's phone clips.
  const clips = (kind: MaterialKind, annotated = false) => {
    const ir = classified(
      {
        assets: [
          makeAsset({ id: 'asset_001', duration_ms: 3000, ...withSound }),
          makeAsset({ id: 'asset_002', duration_ms: 4500, ...withSound }),
        ],
        events: [
          { asset_id: 'asset_001', start_ms: 0, duration_ms: 3000, speech: ['Look at this view'] },
          {
            asset_id: 'asset_002',
            start_ms: 0,
            duration_ms: 4500,
            speech: ['Goodbye from the beach'],
            metrics: { story_importance: 0.9 },
          },
        ],
      },
      { asset_001: kind, asset_002: kind },
    );
    // Clip-relative source ranges, and speech that starts 400 ms in.
    for (const event of ir.events) {
      const range = event.source_ranges[0]!;
      const length = range.source_out_ms - range.source_in_ms;
      event.source_ranges[0] = { ...range, source_in_ms: 0, source_out_ms: length };
      event.observed.speech = event.observed.speech.map((s) => ({
        ...s,
        start_ms: 400,
        end_ms: length - 200,
      }));
    }
    if (annotated) {
      ir.annotations.push({
        id: 'ann_0001',
        type: 'boundary',
        action: 'merge_with_next',
        target: { kind: 'asset', asset_id: 'asset_002' },
        anchor: [],
        priority: 0,
        created_at: '2026-09-24T00:00:00.000Z',
      });
    }
    return ir;
  };
  const whole = (operation: VideoOperation, ir: EditorialIR) =>
    operation.source_in_ms === 0 &&
    operation.source_out_ms ===
      ir.assets.find((a) => a.id === operation.source_asset_id)!.duration_ms;

  it('is used whole or not at all, rather than trimmed through its first word', () => {
    const ir = clips('clip');
    const plan = planEdit({ ir, skill: skill(), targetDurationMs: 6000, toleranceMs: 1500 });
    expect(main(plan).length).toBeGreaterThan(0);
    for (const operation of main(plan)) expect(whole(operation, ir)).toBe(true);
    expect(plan.rationale.find((r) => r.operation_id)!.reason).toContain('as it was trimmed');
  });

  it('is trimmed like anything else when the skill says never', () => {
    const ir = clips('clip');
    const plan = planEdit({
      ir,
      skill: skill({ defaults: { keep_whole: 'never' } }),
      targetDurationMs: 6000,
    });
    expect(main(plan).some((operation) => !whole(operation, ir))).toBe(true);
  });

  it('is trimmed when it is longer than the skill lets a clip be', () => {
    const ir = clips('clip');
    const plan = planEdit({
      ir,
      skill: skill({ defaults: { max_clip_duration_ms: 4000 } }),
      targetDurationMs: 6000,
    });
    const long = main(plan).find((o) => o.source_asset_id === 'asset_002');
    if (long) expect(whole(long, ir)).toBe(false);
  });

  it('is kept whole when the user asked for the recording whole, whatever it is', () => {
    const ir = clips('raw', true);
    const plan = planEdit({
      ir,
      skill: skill({ defaults: { keep_whole: 'never' } }),
      targetDurationMs: 4500,
    });
    const asked = main(plan).find((o) => o.source_asset_id === 'asset_002')!;
    expect(whole(asked, ir)).toBe(true);
    expect(plan.rationale.find((r) => r.operation_id === asked.operation_id)!.reason).toContain(
      'as you asked',
    );
  });

  it('is kept whole when a rule says so, even where the default says never', () => {
    const ir = clips('raw');
    const plan = planEdit({
      ir,
      skill: skill({
        defaults: { keep_whole: 'never' },
        rules: [{ id: 'whole', when: { has_speech: true }, action: { keep_whole: true } }],
      }),
      targetDurationMs: 4500,
    });
    for (const operation of main(plan)) expect(whole(operation, ir)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('photographs, sound files and silent video', () => {
  const photo = makeAsset({
    id: 'asset_001',
    kind: 'image',
    duration_ms: 0,
    width: 4032,
    height: 3024,
    file_name: 'IMG_2001.jpg',
  });
  const memo = makeAsset({ id: 'asset_002', kind: 'audio', duration_ms: 12_000, ...withSound });
  const drone = makeAsset({ id: 'asset_003', duration_ms: 30_000, audio_streams: [] });
  const ir = () =>
    classified(
      {
        assets: [photo, memo, drone],
        events: [
          { asset_id: 'asset_001', start_ms: 0, duration_ms: 3000 },
          { asset_id: 'asset_002', start_ms: 4000, duration_ms: 12_000 },
          { asset_id: 'asset_003', start_ms: 17_000, duration_ms: 30_000 },
        ],
      },
      { asset_001: 'still', asset_002: 'audio_only', asset_003: 'raw' },
    );
  // Every source range in asset time, as the compiler writes them.
  const fixed = () => {
    const built = ir();
    for (const event of built.events) {
      const range = event.source_ranges[0]!;
      event.source_ranges[0] = {
        ...range,
        source_in_ms: 0,
        source_out_ms: range.source_out_ms - range.source_in_ms,
      };
    }
    return built;
  };
  // A skill that would mute all three, which only the silent video should be.
  const muting = skill({
    defaults: { still_duration_ms: 2500, min_clip_duration_ms: 2000, max_clip_duration_ms: 8000 },
    rules: [{ id: 'mute', when: { has_speech: false }, action: { as_b_roll: true } }],
  });
  const byAsset = (plan: { tracks: { video: VideoOperation[] } }, id: string) =>
    main(plan).find((o) => o.source_asset_id === id)!;

  it('holds a photograph for the skill’s still duration, from its start, with no sound', () => {
    const plan = planEdit({ ir: fixed(), skill: muting, targetDurationMs: 18_000 });
    expect(byAsset(plan, 'asset_001')).toMatchObject({
      source_in_ms: 0,
      source_out_ms: 2500,
      use_source_audio: false,
    });
  });

  it('keeps a sound file’s sound, which is all it has', () => {
    const plan = planEdit({ ir: fixed(), skill: muting, targetDurationMs: 18_000 });
    const sound = byAsset(plan, 'asset_002');
    expect(sound.use_source_audio).toBe(true);
    // And nothing settles: it starts where its event does.
    expect(sound.source_in_ms).toBe(0);
  });

  it('never asks a video with no audio track for its sound', () => {
    // Measured on the probe's drone clip: two audio clips in Premiere, one in
    // OTIO, for a file with no audio stream.
    const alone = makeIR({ assets: [drone], events: [{ start_ms: 0, duration_ms: 30_000 }] });
    alone.events[0]!.source_ranges[0]!.asset_id = drone.id;
    const plan = planEdit({ ir: alone, skill: skill(), targetDurationMs: 9000 });
    expect(byAsset(plan, 'asset_003').use_source_audio).toBe(false);
    // The same clip with a sound track keeps it.
    const loud = makeIR({
      assets: [{ ...drone, audio_streams: [{ index: 0 }] }],
      events: [{ start_ms: 0, duration_ms: 30_000 }],
    });
    loud.events[0]!.source_ranges[0]!.asset_id = drone.id;
    const withTrack = planEdit({ ir: loud, skill: skill(), targetDurationMs: 9000 });
    expect(byAsset(withTrack, 'asset_003').use_source_audio).toBe(true);
  });

  it('validates, photograph and all', () => {
    const built = fixed();
    const plan = planEdit({ ir: built, skill: muting, targetDurationMs: 18_000 });
    const report = validatePlan(plan, { ir: built });
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.issues.some((i) => i.code === 'source_audio_missing')).toBe(false);
  });

  it('links the audio stream the analysis listened to, when there was a choice', () => {
    const camera = makeAsset({
      duration_ms: 30_000,
      audio_streams: [
        { index: 0, channels: 2 },
        { index: 1, channels: 1 },
      ],
    });
    const built = makeIR({ assets: [camera], events: [{ start_ms: 0, duration_ms: 8000 }] });
    const profile = { asset_id: 'asset_001', hop_ms: 100, rms_db: [], stream_index: 1 };
    const plan = planEdit({
      ir: built,
      skill: skill(),
      targetDurationMs: 8000,
      observations: observations({ audio_profiles: [profile] }),
    });
    expect(main(plan)[0]!.audio_stream_index).toBe(1);

    const single = makeIR({
      assets: [makeAsset({ duration_ms: 30_000, audio_streams: [{ index: 0 }] })],
      events: [{ start_ms: 0, duration_ms: 8000 }],
    });
    const plain = planEdit({
      ir: single,
      skill: skill(),
      targetDurationMs: 8000,
      observations: observations({ audio_profiles: [{ ...profile, stream_index: 0 }] }),
    });
    expect(main(plain)[0]!.audio_stream_index).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

describe('taking the pauses out of a take', () => {
  // Twenty seconds of speech in bursts: two seconds of words, then 1.5 s of
  // nothing, over and over.
  const words: { start_ms: number; end_ms: number; text: string }[] = [];
  for (let t = 500; t < 19_000; t += 3500) {
    for (let w = 0; w < 5; w++) {
      words.push({ start_ms: t + w * 400, end_ms: t + w * 400 + 350, text: `w${words.length}` });
    }
  }
  const utterances = [
    {
      id: 'utt_0001',
      asset_id: 'asset_001',
      start_ms: 500,
      end_ms: words.at(-1)!.end_ms,
      text: words.map((w) => w.text).join(' '),
      confidence: 0.9,
      words,
    },
  ];
  const ir = () =>
    makeIR({
      assets: [makeAsset({ duration_ms: 60_000, ...withSound })],
      events: [
        {
          start_ms: 0,
          duration_ms: 20_000,
          speech: ['talking'],
          metrics: { story_importance: 0.9 },
        },
        {
          start_ms: 30_000,
          duration_ms: 8000,
          description: 'another moment',
          metrics: { story_importance: 0.2 },
        },
      ],
    });
  const tightening = skill({
    defaults: {
      min_clip_duration_ms: 2000,
      max_clip_duration_ms: 10_000,
      remove_silences: true,
    },
  });
  const plan = (target = 12_000) =>
    planEdit({
      ir: ir(),
      skill: tightening,
      targetDurationMs: target,
      toleranceMs: 1000,
      observations: observations({ utterances }),
    });

  it('turns one take into several clips of it, joined by hard cuts', () => {
    const talking = main(plan()).filter((o) => o.event_id === 'evt_0001');
    expect(talking.length).toBeGreaterThan(2);
    expect(talking[0]!.continues_previous).toBeUndefined();
    for (const piece of talking.slice(1)) {
      expect(piece.continues_previous).toBe(true);
      expect(piece.transition_in).toBeUndefined();
    }
    // Always forward through the take, never back over what was kept.
    for (let i = 1; i < talking.length; i++) {
      expect(talking[i]!.source_in_ms).toBeGreaterThan(talking[i - 1]!.source_out_ms);
    }
  });

  it('never cuts through a word', () => {
    for (const operation of main(plan())) {
      for (const edge of [operation.source_in_ms, operation.source_out_ms]) {
        expect(words.some((w) => edge > w.start_ms && edge < w.end_ms)).toBe(false);
      }
    }
  });

  it('budgets the cut by what is left, so it still lands on its target', () => {
    const built = plan();
    expect(Math.abs(planDurationMs(built) - 12_000)).toBeLessThanOrEqual(1000);
    // Laid end to end, with no gap where a pause was.
    const operations = main(built);
    for (let i = 1; i < operations.length; i++) {
      expect(operations[i]!.timeline_start_ms).toBe(operationTimelineEnd(operations[i - 1]!));
    }
  });

  it('counts a take as one event however many clips it became', () => {
    const built = plan();
    expect(built.stats.events_selected).toBe(new Set(main(built).map((o) => o.event_id)).size);
    expect(built.stats.operation_count).toBeGreaterThan(built.stats.events_selected);
  });

  it('is a valid plan that the reviewer reads as one moment, not a string of short ones', () => {
    const built = plan();
    const report = validatePlan(built, { ir: ir(), skill: tightening });
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.issues.some((i) => i.code === 'invalid_continuation')).toBe(false);
    const continuations = new Set(
      main(built)
        .filter((o) => o.continues_previous)
        .map((o) => o.operation_id),
    );
    for (const observation of reviewPlan(built, ir())) {
      expect(continuations.has(observation.operation_id ?? '')).toBe(false);
    }
  });

  it('leaves the pauses alone when the skill does not ask', () => {
    const untouched = planEdit({
      ir: ir(),
      skill: skill({ defaults: { min_clip_duration_ms: 2000, max_clip_duration_ms: 10_000 } }),
      targetDurationMs: 12_000,
      observations: observations({ utterances }),
    });
    expect(main(untouched).some((o) => o.continues_previous)).toBe(false);
  });

  it('counts a take once against a cap on moments', () => {
    const capped = planEdit({
      ir: ir(),
      skill: skill({
        defaults: {
          min_clip_duration_ms: 2000,
          max_clip_duration_ms: 10_000,
          remove_silences: true,
        },
        constraints: { max_operations: 1 },
      }),
      targetDurationMs: 12_000,
      observations: observations({ utterances }),
    });
    expect(capped.stats.events_selected).toBe(1);
    expect(capped.stats.operation_count).toBeGreaterThan(1);
  });

  it('accounts for every millisecond on the timeline as a millisecond of source', () => {
    // Every millisecond on the timeline is a millisecond of source.
    const built = plan();
    const kept = main(built).reduce((sum, o) => sum + operationTimelineDuration(o), 0);
    expect(kept).toBe(built.stats.total_duration_ms);
  });
});
