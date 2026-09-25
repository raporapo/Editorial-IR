import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { smpteToFrames } from '@editorial-ir/contracts';
import { EdlAdapter, buildEdl, layOnGrid, negotiate, reelNames } from '../src/index.js';
import { makeAsset } from '../../../tests/support/ir.js';
import {
  makePlan,
  mixedAssets,
  mixedIr,
  mixedPlan,
  requestFor,
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
