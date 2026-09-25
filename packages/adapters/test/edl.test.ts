import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { smpteToFrames, type CapabilityDowngrade } from '@editorial-ir/contracts';
import { EdlAdapter, buildEdl, layOnGrid, negotiate, reelNames } from '../src/index.js';
import { makeAsset } from '../../../tests/support/ir.js';
import {
  makePlan,
  mixedAssets,
  mixedIr,
  mixedPlan,
  requestFor,
  soundOnlyAssets,
  soundOnlyPlan,
} from '../../../tests/support/plan.js';

interface EdlLine {
  event: number;
  reel: string;
  channel: string;
  dissolve?: number;
  sourceIn: string;
  sourceOut: string;
  recordIn: string;
  recordOut: string;
}

/** The event lines of a list, read the way a conform reads them: by column. */
function eventLines(text: string): EdlLine[] {
  return text
    .split('\n')
    .filter((line) => /^\d{3,}\s/.test(line))
    .map((line) => {
      const m =
        /^(\d{3,}) {2}(\S+)\s+(\S+)\s+(C|D)\s+(\d{3})?\s*(\d\d:\d\d:\d\d[:;]\d\d) (\d\d:\d\d:\d\d[:;]\d\d) (\d\d:\d\d:\d\d[:;]\d\d) (\d\d:\d\d:\d\d[:;]\d\d)$/.exec(
          line,
        );
      if (!m) throw new Error(`not a CMX 3600 event line: ${JSON.stringify(line)}`);
      return {
        event: Number(m[1]),
        reel: m[2]!,
        channel: m[3]!,
        ...(m[4] === 'D' ? { dissolve: Number(m[5]) } : {}),
        sourceIn: m[6]!,
        sourceOut: m[7]!,
        recordIn: m[8]!,
        recordOut: m[9]!,
      };
    });
}

/** The tracks a channel field puts an event on, as OpenTimelineIO's reader names them. */
const TRACKS: Record<string, string[]> = {
  V: ['V'],
  A: ['A1'],
  A2: ['A2'],
  AA: ['A1', 'A2'],
  B: ['V', 'A1'],
  'A2/V': ['V', 'A2'],
  'AA/V': ['V', 'A1', 'A2'],
};

/**
 * Each track's events in list order, read the way a conform splits a list by
 * channel: the line an event records (the second of a dissolve's two), where.
 */
function tracksOf(lines: EdlLine[]): Map<string, EdlLine[]> {
  const tracks = new Map<string, EdlLine[]>();
  const events = new Map<number, EdlLine[]>();
  for (const line of lines) events.set(line.event, [...(events.get(line.event) ?? []), line]);
  for (const event of events.values()) {
    const recorded = event.at(-1)!;
    const names = TRACKS[recorded.channel];
    if (!names) throw new Error(`not a channel field: ${recorded.channel}`);
    for (const name of names) tracks.set(name, [...(tracks.get(name) ?? []), recorded]);
  }
  return tracks;
}

/**
 * What a reader needs of every track: events in record order that never
 * overlap, and no dissolve as a track's first event — there is nothing on that
 * track to dissolve from, and OpenTimelineIO refuses the whole list over it.
 */
function expectReadableByChannel(text: string): void {
  const frames = (tc: string) => smpteToFrames(tc, 30, 1)!;
  for (const [name, events] of tracksOf(eventLines(text))) {
    expect(events[0]!.dissolve, `${name} starts with a dissolve`).toBeUndefined();
    for (const [index, event] of events.entries()) {
      if (index === 0) continue;
      expect(frames(event.recordIn), `${name} event ${event.event}`).toBeGreaterThanOrEqual(
        frames(events[index - 1]!.recordOut),
      );
    }
  }
}

function edlOf(plan = mixedPlan(), assets = mixedAssets()) {
  const request = requestFor(plan, mixedIr(assets));
  const { plan: negotiated } = negotiate(plan, new EdlAdapter().capabilities, assets);
  const warnings: string[] = [];
  return { text: buildEdl(negotiated, request, warnings), warnings, plan: negotiated };
}

describe('the CMX 3600 edit list', () => {
  it('writes a header and events every conform can read by column', () => {
    const { text } = edlOf();
    const [title, fcm] = text.split('\n');
    expect(title).toMatch(/^TITLE: HARBOUR DAYS$/);
    expect(fcm).toBe('FCM: NON-DROP FRAME');
    expect(eventLines(text).length).toBeGreaterThan(0);
    for (const line of eventLines(text)) expect(line.reel.length).toBeLessThanOrEqual(8);
  });

  it('covers the record timeline without a gap or an overlap the plan did not have', () => {
    // The still is left out (an EDL has none), so its four seconds are the one
    // gap; every other event starts where the last one ended.
    const { text, plan } = edlOf();
    const frames = (tc: string) => smpteToFrames(tc, 30, 1)!;
    const lines = eventLines(text).filter((line) => line.recordOut !== line.recordIn);
    let cursor = 0;
    let gaps = 0;
    for (const line of lines) {
      expect(frames(line.recordIn)).toBeGreaterThanOrEqual(cursor);
      if (frames(line.recordIn) > cursor) gaps++;
      // A clip's two lengths agree, frame for frame.
      if (line.reel !== 'BL') {
        expect(frames(line.sourceOut) - frames(line.sourceIn)).toBe(
          frames(line.recordOut) - frames(line.recordIn),
        );
      }
      cursor = frames(line.recordOut);
    }
    expect(gaps).toBe(1);
    expect(cursor).toBe(layOnGrid(plan).length);
  });

  it('says what each event carries: picture, stereo, mono, or sound alone', () => {
    const { text } = edlOf();
    const byReel = new Map(eventLines(text).map((line) => [line.reel, line.channel]));
    expect(byReel.get('C0001')).toBe('AA/V'); // stereo camera
    expect(byReel.get('MEMO')).toBe('A'); // a mono memo, sound only
    expect(byReel.get('DJI0042')).toBe('V'); // no audio stream to claim
    expect(byReel.get('C0007')).toBe('B'); // the mono lavalier on stream 1
    expect(text).toContain('* AUDIO STREAM: 2 OF 2');
  });

  it('counts 29.97 in drop-frame, and says so in the header', () => {
    const plan = makePlan(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 0,
          source_out_ms: 70_000,
          timeline_start_ms: 0,
        },
      ],
      { rate: [30_000, 1001] },
    );
    const assets = [
      makeAsset({
        id: 'asset_001',
        file_name: 'A001.MOV',
        path: '/m/A001.MOV',
        fps_num: 30_000,
        fps_den: 1001,
        duration_ms: 120_000,
      }),
    ];
    const { text } = edlOf(plan, assets);
    expect(text).toContain('FCM: DROP FRAME');
    // 70 s is 2098 frames; in drop-frame labels that is 00:01:10;00.
    expect(eventLines(text)[0]!.recordOut).toBe('00:01:10;00');
  });

  it('starts source timecode at the file’s own clock', () => {
    // A camera file that begins at 01:00:00;00: a list counting from zero asks
    // the conform for an hour of frames before the file starts.
    const plan = makePlan(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 10_010,
          source_out_ms: 12_012,
          timeline_start_ms: 0,
        },
      ],
      { rate: [30_000, 1001] },
    );
    const withTag = [
      makeAsset({
        id: 'asset_001',
        file_name: 'A001.MOV',
        path: '/m/A001.MOV',
        fps_num: 30_000,
        fps_den: 1001,
        metadata: { timecode: '01:00:00;00' },
      }),
    ];
    const tagged = eventLines(edlOf(plan, withTag).text)[0]!;
    expect(tagged.sourceIn).toBe('01:00:10;00');

    // The typed field, where the ingest provides one, is read before the tag.
    const typed = [
      { ...withTag[0]!, start_timecode: '10:00:00;00' } as unknown as (typeof withTag)[number],
    ];
    expect(eventLines(edlOf(plan, typed).text)[0]!.sourceIn).toBe('10:00:10;00');
  });

  it('says in the artifact which clocks it used', async () => {
    const plan = makePlan([
      { source_asset_id: 'asset_001', source_in_ms: 0, source_out_ms: 1000, timeline_start_ms: 0 },
    ]);
    const assets = [
      makeAsset({ id: 'asset_001', path: '/m/a.mov', metadata: { timecode: '01:00:00:00' } }),
    ];
    const result = await new EdlAdapter().apply(requestFor(plan, mixedIr(assets)));
    expect(result.artifacts[0]!.description).toMatch(/embedded start timecode/);
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toContain('01:00:00:00');
  });

  it('writes a dissolve as the outgoing clip’s last frame and a D event of its length', () => {
    const plan = makePlan([
      {
        source_asset_id: 'asset_001',
        source_in_ms: 10_000,
        source_out_ms: 14_000,
        timeline_start_ms: 0,
      },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 30_000,
        source_out_ms: 34_000,
        timeline_start_ms: 4000,
        transition_in: { type: 'cross_dissolve', duration_ms: 1000 },
      },
    ]);
    const lines = eventLines(edlOf(plan).text);
    expect(lines).toHaveLength(3);
    const [first, from, to] = lines;
    // Centred on the cut at 4 s: half a second either side.
    expect(first!.recordOut).toBe('00:00:03:15');
    expect([from!.event, to!.event]).toEqual([2, 2]);
    expect(from!.sourceIn).toBe(from!.sourceOut);
    expect(from!.sourceIn).toBe('00:00:13:15');
    expect(to!.dissolve).toBe(30);
    expect(to!.sourceIn).toBe('00:00:29:15');
    expect(to!.recordIn).toBe('00:00:03:15');
  });

  it('cross-fades two sound-only clips on their sound channels, where there is sound to overlap', () => {
    // The dissolve from one sound file into the next used to be left out of
    // the list, and nothing said so.
    const plan = soundOnlyPlan();
    const downgrades: CapabilityDowngrade[] = [];
    const lines = eventLines(
      buildEdl(plan, requestFor(plan, mixedIr(soundOnlyAssets())), [], downgrades),
    );
    expect(lines.map((line) => [line.event, line.reel, line.channel, line.dissolve])).toEqual([
      [1, 'MEMO', 'A', undefined],
      [2, 'MEMO', 'A', undefined],
      [2, 'PODCAST', 'A', 12],
      [3, 'FIELD', 'AA', undefined],
      [4, 'FIELD', 'AA', undefined],
      [4, 'BL', 'AA', 30],
    ]);
    // Centred on the cut at 4 s: the podcast comes in six frames before its
    // 5 s in point, six frames before the cut.
    expect(lines[2]).toMatchObject({ sourceIn: '00:00:04:24', recordIn: '00:00:03:24' });
    expect(lines[1]).toMatchObject({ sourceIn: '00:00:13:24', recordIn: '00:00:03:24' });
    // The field recording starts at its first frame: no sound before it to
    // overlap, so that join is a cut, and is reported as one.
    expect(downgrades).toEqual([
      expect.objectContaining({ operation_id: 'op_0003', capability: 'transition_in' }),
    ]);
  });

  it('dissolves only the channels both clips carry, and cuts the new clip’s sound in on its own', () => {
    // Measured on the worked example's memory-film cut: a clip whose sound is
    // not used, dissolving into one with stereo sound, was written
    // `004 IMG1001 AA/V C` / `004 IMG1001 AA/V D 024` — asking the conform for
    // the first clip's sound through the dissolve, and read by OpenTimelineIO
    // as a transition at the very start of the sound tracks, which it refuses.
    const plan = makePlan([
      {
        source_asset_id: 'asset_004',
        source_in_ms: 5000,
        source_out_ms: 9000,
        timeline_start_ms: 0,
      },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 30_000,
        source_out_ms: 34_000,
        timeline_start_ms: 4000,
        transition_in: { type: 'cross_dissolve', duration_ms: 1000 },
      },
    ]);
    const { text } = edlOf(plan);
    const lines = eventLines(text);
    expect(lines.map((line) => [line.event, line.reel, line.channel, line.dissolve])).toEqual([
      [1, 'DJI0042', 'V', undefined],
      [2, 'DJI0042', 'V', undefined],
      [2, 'C0001', 'V', 30],
      [3, 'C0001', 'AA', undefined],
    ]);
    // The picture dissolves from half a second before the cut; the sound comes
    // in on the cut, where the plan puts the clip, from the plan's in point.
    expect(lines[2]).toMatchObject({ recordIn: '00:00:03:15', sourceIn: '00:00:29:15' });
    expect(lines[3]).toMatchObject({
      recordIn: '00:00:04:00',
      recordOut: '00:00:08:00',
      sourceIn: '00:00:30:00',
      sourceOut: '00:00:34:00',
    });
    expectReadableByChannel(text);
  });

  it('keeps the outgoing clip’s sound to the cut when the clip after it has none', () => {
    // The other way round, the camera's sound ended with its picture, half a
    // dissolve before the cut, and the half second before the cut was silent.
    const plan = makePlan([
      {
        source_asset_id: 'asset_001',
        source_in_ms: 10_000,
        source_out_ms: 14_000,
        timeline_start_ms: 0,
      },
      {
        source_asset_id: 'asset_004',
        source_in_ms: 5000,
        source_out_ms: 9000,
        timeline_start_ms: 4000,
        transition_in: { type: 'cross_dissolve', duration_ms: 1000 },
      },
    ]);
    const { text } = edlOf(plan);
    const lines = eventLines(text);
    expect(lines.map((line) => [line.event, line.reel, line.channel, line.recordOut])).toEqual([
      [1, 'C0001', 'V', '00:00:03:15'],
      [2, 'C0001', 'AA', '00:00:04:00'],
      [3, 'C0001', 'V', '00:00:03:15'],
      [3, 'DJI0042', 'V', '00:00:08:00'],
    ]);
    expect(lines[1]).toMatchObject({ sourceIn: '00:00:10:00', sourceOut: '00:00:14:00' });
    expectReadableByChannel(text);
  });

  it('dissolves a mono sound into a stereo one on the channel they share', () => {
    const plan = makePlan([
      {
        source_asset_id: 'asset_301',
        source_in_ms: 10_000,
        source_out_ms: 14_000,
        timeline_start_ms: 0,
      },
      {
        source_asset_id: 'asset_303',
        source_in_ms: 5000,
        source_out_ms: 9000,
        timeline_start_ms: 4000,
        transition_in: { type: 'cross_dissolve', duration_ms: 400 },
      },
    ]);
    const text = buildEdl(plan, requestFor(plan, mixedIr(soundOnlyAssets())));
    expect(eventLines(text).map((line) => [line.event, line.reel, line.channel])).toEqual([
      [1, 'MEMO', 'A'],
      [2, 'MEMO', 'A'],
      [2, 'FIELD', 'A'],
      [3, 'FIELD', 'A2'],
    ]);
    expectReadableByChannel(text);
  });

  it('keeps a clip one event where the clips either side of a dissolve carry the same channels', () => {
    const plan = makePlan([
      {
        source_asset_id: 'asset_001',
        source_in_ms: 10_000,
        source_out_ms: 14_000,
        timeline_start_ms: 0,
      },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 30_000,
        source_out_ms: 34_000,
        timeline_start_ms: 4000,
        transition_in: { type: 'cross_dissolve', duration_ms: 1000 },
      },
    ]);
    const { text } = edlOf(plan);
    expect(eventLines(text).map((line) => [line.event, line.channel])).toEqual([
      [1, 'AA/V'],
      [2, 'AA/V'],
      [2, 'AA/V'],
    ]);
    // And a cut with a still left out, a sound-only clip and a picture-only one
    // is read a channel at a time as it always was.
    expectReadableByChannel(edlOf(mixedPlan()).text);
  });

  it('fades from and to black through the BL reel', () => {
    const plan = makePlan([
      {
        source_asset_id: 'asset_001',
        source_in_ms: 10_000,
        source_out_ms: 14_000,
        timeline_start_ms: 0,
        transition_in: { type: 'fade_in', duration_ms: 500 },
        transition_out: { type: 'fade_out', duration_ms: 1000 },
      },
    ]);
    const lines = eventLines(edlOf(plan).text);
    expect(lines.map((line) => [line.reel, line.dissolve])).toEqual([
      ['BL', undefined],
      ['C0001', 15],
      ['C0001', undefined],
      ['BL', 30],
    ]);
    expect(lines.at(-1)!.recordOut).toBe('00:00:04:00');
  });

  it('writes chapters as LOC comments under the event they fall in', () => {
    const plan = mixedPlan({
      markers: [
        { timeline_ms: 0, name: 'Morning', kind: 'chapter' },
        { timeline_ms: 13_000, name: 'Up in the air', kind: 'chapter' },
      ],
    });
    const text = edlOf(plan).text;
    expect(text).toContain('* LOC: 00:00:00:00 GREEN  Morning');
    // 13 s is inside the drone clip's event, which starts at 12 s.
    const drone = text.slice(text.indexOf('DJI0042'));
    expect(drone.slice(0, drone.indexOf('\n\n'))).toContain(
      '* LOC: 00:00:13:00 GREEN  Up in the air',
    );
  });

  it('starts the record clock where it is told to', () => {
    const plan = mixedPlan();
    const request = { ...requestFor(plan), options: { record_start: '01:00:00:00' } };
    const { plan: negotiated } = negotiate(plan, new EdlAdapter().capabilities, request.ir.assets);
    expect(eventLines(buildEdl(negotiated, request))[0]!.recordIn).toBe('01:00:00:00');
  });

  it('reads the record start in the list’s own counting at 29.97', () => {
    // Typed with colons, as a person types it; the list counts drop-frame, and
    // reading the start as non-drop put the first event at 01:00:03;18.
    const plan = mixedPlan({ rate: [30000, 1001] });
    const request = { ...requestFor(plan), options: { record_start: '01:00:00:00' } };
    const { plan: negotiated } = negotiate(plan, new EdlAdapter().capabilities, request.ir.assets);
    expect(eventLines(buildEdl(negotiated, request))[0]!.recordIn).toBe('01:00:00;00');
  });
});

describe('reel names', () => {
  it('fit in eight characters and never collide', () => {
    // Two cards both holding DJI_0001.MP4 is the ordinary case, not a corner.
    const names = reelNames([
      makeAsset({ id: 'asset_001', file_name: 'DJI_0001.MP4' }),
      makeAsset({ id: 'asset_002', file_name: 'DJI_0001.MP4' }),
      makeAsset({ id: 'asset_003', file_name: 'PXL_20260901_vfr.mp4' }),
      makeAsset({ id: 'asset_004', file_name: 'harbour_days_final.mp4' }),
      makeAsset({ id: 'asset_005', file_name: '夏の思い出.mov' }),
    ]);
    expect([...names.values()]).toEqual(['DJI0001', 'DJI00012', 'PXL01VFR', 'HARFINAL', 'REEL']);
    for (const reel of names.values()) expect(reel).toMatch(/^[A-Z0-9]{1,8}$/);
  });

  it('are the same every time for the same files', () => {
    const assets = mixedAssets();
    expect([...reelNames(assets).entries()]).toEqual([...reelNames(assets).entries()]);
  });
});
