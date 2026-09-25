import { describe, expect, it } from 'vitest';
import {
  FcpxmlAdapter,
  buildFcpxml,
  fcpxmlRate,
  negotiate,
  type ApplyRequest,
} from '../src/index.js';
import type { EditPlan } from '@editorial-ir/contracts';
import { makeAsset } from '../../../tests/support/ir.js';
import { findAll, parseXml, type XmlNode } from '../../../tests/support/xml.js';
import { makePlan, mixedIr, mixedPlan, requestFor } from '../../../tests/support/plan.js';

/**
 * FCPXML, checked the way Final Cut checks it.
 *
 * Final Cut refuses an entire file over one time that is off the frame grid, a
 * reference with nothing behind it, or a storyline with a hole in it — and says
 * little more than "invalid". These are the invariants its importer and
 * Resolve's are known to enforce, asserted on the document rather than on
 * substrings.
 */

/** `1001/30000s` or `3600s` as an exact fraction. */
function seconds(value: string): [number, number] {
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(value);
  if (!m) throw new Error(`not an FCPXML time: ${value}`);
  return [Number(m[1]), Number(m[2] ?? 1)];
}

/** Whether a time is a whole number of frames at `num/den`. */
function onGrid(value: string, num: number, den: number): boolean {
  const [n, d] = seconds(value);
  return (n * num) % (d * den) === 0;
}

function frames(value: string, num: number, den: number): number {
  const [n, d] = seconds(value);
  return (n * num) / (d * den);
}

function document(
  plan: EditPlan,
  request: ApplyRequest = requestFor(plan),
  warnings: string[] = [],
) {
  const { plan: negotiated } = negotiate(plan, new FcpxmlAdapter().capabilities, request.ir.assets);
  const root = parseXml(buildFcpxml(negotiated, request, warnings));
  const spine = findAll(root, 'spine')[0]!;
  const resources = new Map(
    findAll(root, 'resources')[0]!.children.map((node) => [node.attributes.id!, node]),
  );
  return { root, spine, resources, warnings };
}

const storyline = (spine: XmlNode) => spine.children.filter((child) => child.tag !== 'transition');

describe('the FCPXML document', () => {
  it('is FCPXML 1.10 with resources and one sequence', () => {
    const { root } = document(mixedPlan());
    expect(root.tag).toBe('fcpxml');
    expect(root.attributes.version).toBe('1.10');
    expect(findAll(root, 'sequence')).toHaveLength(1);
  });

  it('points every reference at a resource that exists', () => {
    const { root, resources } = document(mixedPlan());
    const refs = [
      ...findAll(root, 'asset-clip'),
      ...findAll(root, 'video'),
      ...findAll(root, 'filter-video'),
      ...findAll(root, 'filter-audio'),
    ].map((node) => node.attributes.ref!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(resources.has(ref), ref).toBe(true);
    for (const asset of findAll(root, 'asset')) {
      if (asset.attributes.format)
        expect(resources.get(asset.attributes.format)?.tag).toBe('format');
      expect(findAll(asset, 'media-rep')[0]!.attributes.src).toMatch(/^file:\/\//);
    }
  });

  it('declares each file once, however many clips read it', () => {
    const plan = makePlan([
      { source_asset_id: 'asset_001', source_in_ms: 0, source_out_ms: 2000, timeline_start_ms: 0 },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 5000,
        source_out_ms: 7000,
        timeline_start_ms: 2000,
      },
    ]);
    const { root } = document(plan);
    expect(findAll(root, 'asset')).toHaveLength(1);
    expect(findAll(root, 'asset-clip')).toHaveLength(2);
  });

  it('puts every time on the sequence’s frame grid, at NTSC rates too', () => {
    const plan = { ...mixedPlan({ rate: [30_000, 1001] }) };
    const { root, spine } = document(plan);
    const sequence = findAll(root, 'sequence')[0]!;
    expect(onGrid(sequence.attributes.duration!, 30_000, 1001)).toBe(true);
    for (const child of spine.children) {
      expect(onGrid(child.attributes.offset!, 30_000, 1001), child.attributes.offset).toBe(true);
      expect(onGrid(child.attributes.duration!, 30_000, 1001), child.attributes.duration).toBe(
        true,
      );
    }
    for (const clip of findAll(root, 'asset-clip')) {
      expect(onGrid(clip.attributes.start!, 30_000, 1001), clip.attributes.start).toBe(true);
    }
  });

  it('keeps the storyline contiguous from zero to the end of the cut', () => {
    // Everything else is anchored to the storyline; a hole in it is a place a
    // caption or a chapter has nothing to hang on.
    const { root, spine } = document(mixedPlan());
    const items = storyline(spine);
    let cursor = 0;
    for (const item of items) {
      expect(frames(item.attributes.offset!, 30, 1)).toBe(cursor);
      cursor += frames(item.attributes.duration!, 30, 1);
    }
    expect(cursor).toBe(frames(findAll(root, 'sequence')[0]!.attributes.duration!, 30, 1));
  });

  it('writes a still as video on an image asset with no length of its own', () => {
    const { spine, resources } = document(mixedPlan());
    const still = spine.children.find((child) => child.tag === 'video')!;
    const asset = resources.get(still.attributes.ref!)!;
    expect(asset.attributes.duration).toBe('0s');
    expect(asset.attributes.hasVideo).toBe('1');
    expect(resources.get(asset.attributes.format!)!.attributes.frameDuration).toBeUndefined();
    // Room before it for the dissolve that joins it to the camera clip.
    expect(seconds(still.attributes.start!)[0]).toBeGreaterThan(0);
  });

  it('writes a sound file as sound: an asset with no video, in the storyline', () => {
    const { spine, resources } = document(mixedPlan());
    const memo = storyline(spine).find((item) => item.attributes.name === 'memo')!;
    expect(memo.tag).toBe('asset-clip');
    const asset = resources.get(memo.attributes.ref!)!;
    expect(asset.attributes.hasVideo).toBeUndefined();
    expect(asset.attributes.hasAudio).toBe('1');
    expect(asset.attributes.audioChannels).toBe('1');
  });

  it('keeps a cutaway’s picture and leaves its sound out', () => {
    const plan = makePlan([
      {
        source_asset_id: 'asset_001',
        source_in_ms: 0,
        source_out_ms: 2000,
        timeline_start_ms: 0,
        use_source_audio: false,
      },
      {
        source_asset_id: 'asset_004',
        source_in_ms: 0,
        source_out_ms: 2000,
        timeline_start_ms: 2000,
      },
    ]);
    const { spine } = document(plan);
    const [cutaway, drone] = storyline(spine);
    expect(cutaway!.attributes.srcEnable).toBe('video');
    // A file with no sound has nothing to leave out.
    expect(drone!.attributes.srcEnable).toBeUndefined();
    expect(drone!.attributes.audioRole).toBeUndefined();
  });

  it('turns on only the audio stream the plan chose', () => {
    const { spine } = document(mixedPlan());
    const lavalier = storyline(spine).find((item) => item.attributes.name === 'C0007')!;
    const sources = findAll(lavalier, 'audio-channel-source').map((s) => [
      s.attributes.srcCh,
      s.attributes.active,
    ]);
    expect(sources).toEqual([
      ['1, 2', '0'],
      ['3', '1'],
    ]);
  });

  it('addresses a clip in its file’s own timecode', () => {
    const plan = makePlan([
      {
        source_asset_id: 'asset_001',
        source_in_ms: 10_000,
        source_out_ms: 12_000,
        timeline_start_ms: 0,
      },
    ]);
    const assets = [
      makeAsset({
        id: 'asset_001',
        path: '/m/A001.MOV',
        file_name: 'A001.MOV',
        metadata: { timecode: '01:00:00:00' },
      }),
    ];
    const { root, resources } = document(plan, requestFor(plan, mixedIr(assets)));
    const clip = findAll(root, 'asset-clip')[0]!;
    expect(resources.get(clip.attributes.ref!)!.attributes.start).toBe('3600s');
    expect(clip.attributes.start).toBe('3610s');
  });

  it('centres a dissolve on the cut it joins', () => {
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
    const { spine } = document(plan);
    expect(spine.children.map((child) => child.tag)).toEqual([
      'asset-clip',
      'transition',
      'asset-clip',
    ]);
    const transition = spine.children[1]!;
    expect(frames(transition.attributes.offset!, 30, 1)).toBe(105);
    expect(frames(transition.attributes.duration!, 30, 1)).toBe(30);
  });

  it('fades the last clip to black instead of losing it', () => {
    const { spine } = document(mixedPlan());
    const last = spine.children.at(-1)!;
    expect(last.tag).toBe('transition');
    expect(frames(last.attributes.offset!, 30, 1) + frames(last.attributes.duration!, 30, 1)).toBe(
      600,
    );
  });

  it('puts chapters on the storyline item they fall in, in its own time', () => {
    const plan = mixedPlan({
      markers: [
        { timeline_ms: 0, name: 'Morning', kind: 'chapter' },
        { timeline_ms: 13_000, name: 'Up in the air', kind: 'chapter' },
      ],
    });
    const { spine } = document(plan);
    const drone = storyline(spine).find((item) => item.attributes.name === 'DJI_0042')!;
    const marker = findAll(drone, 'chapter-marker')[0]!;
    expect(marker.attributes.value).toBe('Up in the air');
    // The drone clip starts 5 s into its file and 12 s into the cut, so 13 s is
    // 6 s in its own time.
    expect(marker.attributes.start).toBe('6s');
  });

  it('anchors captions to the storyline with an SRT role in their own language', () => {
    const plan = mixedPlan({
      text: [
        {
          operation_id: 'op_cap_0001',
          timeline_start_ms: 500,
          timeline_end_ms: 2500,
          text: 'やっと着いた',
          kind: 'caption',
          provenance: 'agent_derived',
        },
      ],
    });
    const { spine } = document(plan);
    const caption = findAll(spine, 'caption')[0]!;
    expect(caption.attributes.role).toBe('SRT?captionFormat=SRT.ja');
    expect(Number(caption.attributes.lane)).toBeGreaterThan(0);
    expect(findAll(caption, 'text-style')[0]!.text).toBe('やっと着いた');
  });

  it('writes a rate Final Cut cannot edit in as the nearest one it can, and says so', () => {
    const warnings: string[] = [];
    expect(fcpxmlRate(2500, 101, warnings)).toMatchObject({ num: 25, den: 1 });
    expect(warnings.join(' ')).toMatch(/2500\/101/);
    expect(fcpxmlRate(30_000, 1001)).toMatchObject({ num: 30_000, den: 1001, code: '2997' });
  });

  it('orders an asset-clip’s children as the DTD does: captions and markers before its channel sources', () => {
    // The DTD puts audio-channel-source last in an asset-clip. Written first, a
    // clip with two sound streams, a caption and a chapter failed validation
    // against FCPXMLv1_10.dtd, and Final Cut refuses the whole file for that.
    const plan = mixedPlan({
      markers: [{ timeline_ms: 17_000, name: 'Lavalier', kind: 'chapter' }],
      text: [
        {
          operation_id: 'op_cap_0001',
          timeline_start_ms: 16_500,
          timeline_end_ms: 18_000,
          text: 'on the second stream',
          kind: 'caption',
          provenance: 'agent_derived',
        },
      ],
    });
    const { spine } = document(plan);
    const lavalier = spine.children.find(
      (child) => child.tag === 'asset-clip' && findAll(child, 'audio-channel-source').length > 0,
    )!;
    const order = lavalier.children.map((child) => child.tag);
    expect(order).toEqual([
      'caption',
      'chapter-marker',
      'audio-channel-source',
      'audio-channel-source',
    ]);
  });

  it('starts the sequence clock where it is told to, in the sequence’s own counting', () => {
    // 01:00:00:00 typed for a 29.97 drop-frame sequence is the label
    // 01:00:00;00: 107892 frames, not 108000.
    const plan = mixedPlan({ rate: [30000, 1001] });
    const request = { ...requestFor(plan), options: { record_start: '01:00:00:00' } };
    const sequence = findAll(document(plan, request).root, 'sequence')[0]!;
    expect(sequence.attributes.tcFormat).toBe('DF');
    expect(frames(sequence.attributes.tcStart!, 30000, 1001)).toBe(107_892);
  });

  it('is not the FCP7 XML the Premiere adapter writes', () => {
    const plan = mixedPlan();
    const xml = buildFcpxml(plan, requestFor(plan));
    expect(xml).not.toContain('xmeml');
    expect(xml).toContain('<!DOCTYPE fcpxml>');
  });
});
