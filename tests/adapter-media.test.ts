import { describe, expect, it } from 'vitest';
import {
  AviUtl2Adapter,
  OtioAdapter,
  PremiereAdapter,
  buildAviUtlJob,
  buildExo,
  buildFcpXml,
  buildOtioTimeline,
  layOnGrid,
  negotiate,
  xmemlRate,
} from '@editorial-ir/adapters';
import {
  AdapterCapabilities,
  operationTimelineDuration,
  type EditPlan,
} from '@editorial-ir/contracts';
import { childText, findAll, parseXml, type XmlNode } from './support/xml.js';
import { makePlan, mixedIr, mixedPlan, requestFor } from './support/plan.js';

/**
 * Every existing adapter, on material that is not a camera file with stereo
 * sound.
 *
 * Each wrote every operation as a moving-picture clip with two channels of
 * sound, whatever the file was. Measured on the probe footage before this: a
 * voice memo went onto V1 as a video clip pointing at an .m4a; a photograph was
 * a video clip reading sixty frames into a file declared zero frames long, and
 * every dissolve that touched it was refused; a drone clip with no audio stream
 * got two audio clipitems that import as offline media; and the AviUtl .exo
 * carried no sound at all.
 */

type OtioNode = Record<string, unknown> & { OTIO_SCHEMA: string };
type OtioTrack = OtioNode & {
  kind: string;
  children: OtioNode[];
  metadata: Record<string, Record<string, unknown>>;
};

function otioTracks(plan: EditPlan): OtioTrack[] {
  const timeline = buildOtioTimeline(plan, requestFor(plan)) as unknown as {
    tracks: { children: OtioTrack[] };
  };
  return timeline.tracks.children;
}

function operationOf(node: OtioNode): string | undefined {
  const meta = (node.metadata as Record<string, Record<string, unknown>> | undefined)?.[
    'editorial-ir'
  ];
  return typeof meta?.operation_id === 'string' ? meta.operation_id : undefined;
}

function premiere(plan: EditPlan, warnings: string[] = []) {
  const root = parseXml(buildFcpXml(plan, requestFor(plan), warnings));
  const media = findAll(root, 'media').find((m) =>
    m.children.some((c) => c.tag === 'video' && findAll(c, 'track').length > 0),
  )!;
  const video = media.children.find((child) => child.tag === 'video')!;
  const audio = media.children.find((child) => child.tag === 'audio')!;
  const files = new Map<string, XmlNode>();
  for (const file of findAll(root, 'file')) {
    if (file.children.length > 0) files.set(file.attributes.id!, file);
  }
  const fileOf = (clip: XmlNode): XmlNode | undefined =>
    files.get(clip.children.find((child) => child.tag === 'file')!.attributes.id!);
  return { root, video, audio, files, fileOf };
}

describe('Premiere, on every kind of media', () => {
  it('holds a still as a still clip, with room either side for a dissolve into it', () => {
    const warnings: string[] = [];
    const { video, fileOf } = premiere(mixedPlan(), warnings);
    const clips = findAll(video, 'clipitem');
    const still = clips.find((clip) => childText(clip, 'name') === 'IMG_2001.jpg')!;
    expect(childText(still, 'stillframe')).toBe('TRUE');
    const duration = Number(childText(fileOf(still)!, 'duration'));
    const [inPoint, outPoint] = [Number(childText(still, 'in')), Number(childText(still, 'out'))];
    // Handles both sides, inside a file that is long enough to hold them.
    expect(inPoint).toBeGreaterThan(0);
    expect(duration).toBeGreaterThan(outPoint);
    // The dissolve from the camera clip into the photograph is written, not
    // refused as "not enough footage".
    expect(
      findAll(video, 'transitionitem').some((t) => childText(t, 'alignment') === 'center'),
    ).toBe(true);
    expect(warnings.join(' ')).not.toMatch(/not enough footage/);
  });

  it('writes a sound-only file as sound, with no picture and no video media', () => {
    const { video, audio, files } = premiere(mixedPlan());
    expect(findAll(video, 'clipitem').map((clip) => childText(clip, 'name'))).not.toContain(
      'memo.m4a',
    );
    const memo = [...files.values()].find((file) => childText(file, 'name') === 'memo.m4a')!;
    expect(findAll(memo, 'video')).toHaveLength(0);
    // Mono: one clipitem, not a pair whose second channel points at nothing.
    const sound = findAll(audio, 'clipitem').filter(
      (clip) => childText(clip, 'name') === 'memo.m4a',
    );
    expect(sound).toHaveLength(1);
    expect(childText(findAll(memo, 'audio')[0]!, 'channelcount')).toBe('1');
  });

  it('gives a clip whose file has no sound no audio clips', () => {
    const { audio } = premiere(mixedPlan());
    const names = findAll(audio, 'clipitem').map((clip) => childText(clip, 'name'));
    expect(names).not.toContain('DJI_0042.MP4');
    expect(names).not.toContain('IMG_2001.jpg');
  });

  it('links the stream the plan chose, counting channels across the streams before it', () => {
    // Stream 0 is stereo room tone, stream 1 the mono lavalier: its one channel
    // is the file's third.
    const { audio } = premiere(mixedPlan());
    const lavalier = findAll(audio, 'clipitem').filter(
      (clip) => childText(clip, 'name') === 'C0007.MP4',
    );
    expect(lavalier).toHaveLength(1);
    expect(childText(findAll(lavalier[0]!, 'sourcetrack')[0]!, 'trackindex')).toBe('3');
  });

  it('counts a stream with no channel count the same in the file and in the clip', () => {
    // A first stream that came through ingest with no channel count, beside the
    // probe's first-stream field saying mono. The file definition counted it as
    // two channels and the clip reading the next stream counted it as one, so
    // the lavalier's clip pointed at channel 2 — the first stream's second
    // channel, in a file that declared the lavalier as channel 3.
    const assets = mixedIr().assets.map((asset) =>
      asset.id === 'asset_005'
        ? {
            ...asset,
            audio_channels: 1,
            audio_streams: [
              { index: 0, codec: 'aac' },
              { index: 1, codec: 'aac', channels: 1, sample_rate: 48_000 },
            ],
          }
        : asset,
    );
    const plan = mixedPlan();
    const root = parseXml(buildFcpXml(plan, requestFor(plan, mixedIr(assets))));
    const file = findAll(root, 'file').find(
      (node) => node.children.length > 0 && childText(node, 'name') === 'C0007.MP4',
    )!;
    const declared = findAll(file, 'audio').map((audio) =>
      Number(childText(audio, 'channelcount')),
    );
    const lavalier = findAll(root, 'clipitem').find(
      (clip) => childText(clip, 'name') === 'C0007.MP4' && findAll(clip, 'sourcetrack').length > 0,
    )!;
    const trackIndex = Number(childText(findAll(lavalier, 'sourcetrack')[0]!, 'trackindex'));
    expect(trackIndex).toBe(declared[0]! + 1);
  });

  it('fades the last clip out instead of losing the fade', () => {
    const { video } = premiere(mixedPlan());
    const fades = findAll(video, 'transitionitem').filter(
      (t) => childText(t, 'alignment') === 'end-black',
    );
    expect(fades).toHaveLength(1);
    const plan = mixedPlan();
    const end = layOnGrid(plan).length;
    expect(Number(childText(fades[0]!, 'end'))).toBe(end);
    expect(Number(childText(fades[0]!, 'start'))).toBe(end - 30);
  });

  it('fades the first clip in from black', () => {
    const base = mixedPlan();
    const plan: EditPlan = {
      ...base,
      tracks: {
        ...base.tracks,
        video: base.tracks.video.map((o, i) =>
          i === 0 ? { ...o, transition_in: { type: 'fade_in' as const, duration_ms: 500 } } : o,
        ),
      },
    };
    const { video } = premiere(plan);
    const track = findAll(video, 'track')[0]!;
    expect(track.children[0]!.tag).toBe('transitionitem');
    expect(childText(track.children[0]!, 'alignment')).toBe('start-black');
    expect(childText(track.children[0]!, 'start')).toBe('0');
  });

  it('calls a rate NTSC only when it is a whole rate slowed by 1000/1001', () => {
    // A VFR phone clip's 2500/101 average was written as NTSC 25: 24.975 fps.
    const warnings: string[] = [];
    expect(xmemlRate(2500, 101, warnings)).toMatchObject({ timebase: 25, ntsc: false });
    expect(warnings.join(' ')).toMatch(/2500\/101/);
    expect(xmemlRate(24_000, 1001)).toMatchObject({ timebase: 24, ntsc: true });
    expect(xmemlRate(30_000, 1001)).toMatchObject({ timebase: 30, ntsc: true });
    expect(xmemlRate(25, 1)).toMatchObject({ timebase: 25, ntsc: false });
  });

  it('links sound to picture on its own track, so a V2 clip’s sound names a clip that exists', () => {
    // Measured: the worked example's 38-clip cut with one cutaway added on V2
    // linked its sound to "clipitem-1-39", which did not exist.
    const plan = makePlan([
      { source_asset_id: 'asset_001', source_in_ms: 0, source_out_ms: 8000, timeline_start_ms: 0 },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 20_000,
        source_out_ms: 23_000,
        timeline_start_ms: 2000,
        track: 1,
      },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 30_000,
        source_out_ms: 34_000,
        timeline_start_ms: 8000,
      },
    ]);
    const { root } = premiere(plan);
    const ids = new Set(findAll(root, 'clipitem').map((clip) => clip.attributes.id!));
    const refs = findAll(root, 'linkclipref').map((ref) => ref.text);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ids.has(ref), ref).toBe(true);
  });

  it('puts chapters on the sequence as markers', () => {
    const plan = mixedPlan({
      markers: [
        { timeline_ms: 0, name: 'Morning', kind: 'chapter' },
        { timeline_ms: 12_000, name: 'Harbour & sea', kind: 'chapter' },
      ],
    });
    const { root } = premiere(plan);
    const markers = findAll(root, 'marker');
    // The checker keeps entities as written, which is the escaping this proves.
    expect(markers.map((m) => childText(m, 'name'))).toEqual(['Morning', 'Harbour &amp; sea']);
    expect(markers.map((m) => childText(m, 'in'))).toEqual(['0', '360']);
  });
});

describe('OpenTimelineIO, on every kind of media', () => {
  it('gives a still a media range that covers the clip reading it', () => {
    const [video] = otioTracks(mixedPlan());
    const still = video!.children.find((child) => operationOf(child) === 'op_0002')!;
    const source = still.source_range as {
      start_time: { value: number };
      duration: { value: number };
    };
    const available = (still.media_reference as { available_range: typeof source }).available_range;
    expect(available.duration.value).toBeGreaterThan(0);
    expect(source.start_time.value).toBeGreaterThanOrEqual(available.start_time.value);
    expect(source.start_time.value + source.duration.value).toBeLessThanOrEqual(
      available.start_time.value + available.duration.value,
    );
  });

  it('leaves the picture empty under a sound-only file and puts it on an audio track', () => {
    const tracks = otioTracks(mixedPlan());
    const video = tracks.find((track) => track.kind === 'Video')!;
    const audio = tracks.find((track) => track.kind === 'Audio')!;
    expect(video.children.map(operationOf)).not.toContain('op_0003');
    expect(audio.children.map(operationOf)).toContain('op_0003');
  });

  it('writes sound only for clips that have it and use it', () => {
    const audio = otioTracks(mixedPlan()).find((track) => track.kind === 'Audio')!;
    // The camera clip, the memo and the lavalier; not the still, not the drone.
    expect(audio.children.map(operationOf).filter(Boolean)).toEqual([
      'op_0001',
      'op_0003',
      'op_0005',
    ]);
    const lavalier = audio.children.find((child) => operationOf(child) === 'op_0005')!;
    const meta = (lavalier.metadata as Record<string, Record<string, unknown>>)['editorial-ir']!;
    expect(meta.audio_stream_index).toBe(1);
    expect(meta.channels).toBe(1);
  });

  it('fades out of the last clip with a transition that has nothing after it', () => {
    const video = otioTracks(mixedPlan()).find((track) => track.kind === 'Video')!;
    const last = video.children.at(-1)!;
    expect(last.OTIO_SCHEMA).toBe('Transition.1');
    expect((last.in_offset as { value: number }).value).toBe(30);
    expect((last.out_offset as { value: number }).value).toBe(0);
  });

  it('puts chapters on the timeline as markers in the schema version every OTIO reads', () => {
    // Marker.1 calls its range `range`; `marked_range` under that label made
    // OpenTimelineIO 0.18 refuse the whole file.
    const plan = mixedPlan({ markers: [{ timeline_ms: 4000, name: 'Photos', kind: 'chapter' }] });
    const timeline = buildOtioTimeline(plan, requestFor(plan)) as unknown as {
      tracks: {
        markers: (Record<string, unknown> & {
          name: string;
          range: { start_time: { value: number } };
        })[];
      };
    };
    expect(timeline.tracks.markers).toHaveLength(1);
    const [marker] = timeline.tracks.markers;
    expect(marker!.OTIO_SCHEMA).toBe('Marker.1');
    expect(marker!.name).toBe('Photos');
    expect(marker!.range.start_time.value).toBe(120);
    expect(marker).not.toHaveProperty('marked_range');
  });
});

describe('AviUtl2, on every kind of media', () => {
  it('says what each job clip is made of, and whether its sound is used', () => {
    const plan = mixedPlan();
    const job = buildAviUtlJob(plan, requestFor(plan)) as {
      clips: {
        id: string;
        media: string;
        use_source_audio: boolean;
        audio_stream_index?: number;
      }[];
    };
    expect(job.clips.map((clip) => clip.media)).toEqual([
      'video',
      'image',
      'audio',
      'video',
      'video',
    ]);
    // The drone clip asked for sound it does not have.
    expect(job.clips.map((clip) => clip.use_source_audio)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(job.clips[4]!.audio_stream_index).toBe(1);
  });

  it('carries sound in the exo, and a still as an image object', () => {
    // The exo was silent: every clip was a 動画ファイル, which plays no audio.
    const plan = mixedPlan();
    const exo = buildExo(plan, requestFor(plan));
    expect(exo.match(/^_name=動画ファイル$/gm)).toHaveLength(3);
    expect(exo.match(/^_name=画像ファイル$/gm)).toHaveLength(1);
    // The camera clip, the memo and the lavalier.
    expect(exo.match(/^_name=音声ファイル$/gm)).toHaveLength(3);
    expect(exo).toContain('file=/media/memo.m4a');
    // The audio object counts its position in seconds; the camera clip starts
    // 10 s into its file.
    expect(exo).toMatch(/_name=音声ファイル\r\n再生位置=10\.00\r\n/);
    // Sound sits below every picture layer.
    const layers = [...exo.matchAll(/layer=(\d+)\r\n(?:group=\d+\r\n)?overlay=1\r\naudio=1/g)].map(
      (m) => Number(m[1]),
    );
    expect(Math.min(...layers)).toBeGreaterThan(1);
  });
});

/** What a CMX 3600 list can hold: one picture track, no stills, no captions. */
const SINGLE_TRACK_LIST = AdapterCapabilities.parse({
  id: 'list',
  name: 'a single-track list',
  mode: 'file',
  output_extensions: ['.list'],
  max_video_tracks: 1,
  still_images: false,
  audio_tracks: 1,
});

describe('negotiation', () => {
  it('keeps a clip’s length on the timeline when its speed cannot be changed', () => {
    // Speed was set to 1 and nothing else: a 2x clip doubled in length and was
    // then clamped to the next clip, playing only the first half of its range.
    const plan = makePlan([
      {
        source_asset_id: 'asset_001',
        source_in_ms: 10_000,
        source_out_ms: 14_000,
        timeline_start_ms: 0,
        speed: 2,
      },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 30_000,
        source_out_ms: 32_000,
        timeline_start_ms: 2000,
      },
    ]);
    const before = operationTimelineDuration(plan.tracks.video[0]!);
    const { plan: adjusted, downgrades } = negotiate(
      plan,
      new OtioAdapter().capabilities,
      mixedIr().assets,
    );
    const op = adjusted.tracks.video[0]!;
    expect(op.speed).toBe(1);
    expect(operationTimelineDuration(op)).toBe(before);
    expect(op.source_out_ms).toBe(12_000);
    expect(downgrades[0]!.action).toMatch(/same 2000 ms on the timeline/);
  });

  it('says so when slow motion played at normal speed runs out of source', () => {
    const plan = makePlan([
      {
        source_asset_id: 'asset_001',
        source_in_ms: 58_000,
        source_out_ms: 59_000,
        timeline_start_ms: 0,
        speed: 0.25,
      },
    ]);
    const { plan: adjusted, downgrades } = negotiate(
      plan,
      new OtioAdapter().capabilities,
      mixedIr().assets,
    );
    expect(adjusted.tracks.video[0]!.source_out_ms).toBe(60_000);
    expect(downgrades[0]!.action).toMatch(/runs out 2000 ms before/);
  });

  it('never moves a clip onto a track where it would cover another', () => {
    // An EDL has one picture track. A cutaway over a clip cannot join it.
    const plan = makePlan([
      { source_asset_id: 'asset_001', source_in_ms: 0, source_out_ms: 8000, timeline_start_ms: 0 },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 20_000,
        source_out_ms: 23_000,
        timeline_start_ms: 2000,
        track: 1,
      },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 40_000,
        source_out_ms: 42_000,
        timeline_start_ms: 9000,
        track: 1,
      },
    ]);
    const { plan: adjusted, downgrades } = negotiate(plan, SINGLE_TRACK_LIST);
    expect(adjusted.tracks.video.map((o) => [o.operation_id, o.track])).toEqual([
      ['op_0001', 0],
      ['op_0003', 0],
    ]);
    expect(downgrades.find((d) => d.operation_id === 'op_0002')!.action).toMatch(
      /would cover op_0001/,
    );
    expect(downgrades.find((d) => d.operation_id === 'op_0003')!.action).toBe('moved to track 0');
  });

  it('leaves a still out of a target that cannot hold one, and says so', () => {
    const { plan, downgrades } = negotiate(mixedPlan(), SINGLE_TRACK_LIST, mixedIr().assets);
    expect(plan.tracks.video.map((o) => o.source_asset_id)).not.toContain('asset_002');
    expect(
      downgrades.some((d) => d.capability === 'still_images' && d.operation_id === 'op_0002'),
    ).toBe(true);
  });

  it('asks about captions and titles separately', () => {
    const plan = mixedPlan({
      text: [
        {
          operation_id: 'op_cap_0001',
          timeline_start_ms: 0,
          timeline_end_ms: 1000,
          text: 'hello',
          kind: 'caption',
          provenance: 'agent_derived',
        },
        {
          operation_id: 'op_ttl_0001',
          timeline_start_ms: 0,
          timeline_end_ms: 1000,
          text: 'Day one',
          kind: 'title',
          provenance: 'agent_derived',
        },
      ],
    });
    const premiereResult = negotiate(plan, new PremiereAdapter().capabilities);
    expect(premiereResult.plan.tracks.text).toHaveLength(0);
    expect(premiereResult.downgrades.find((d) => d.capability === 'captions')!.action).toMatch(
      /--editor srt/,
    );
    // A target with a caption track and no titles, as FCPXML is.
    const captioning = negotiate(
      plan,
      AdapterCapabilities.parse({ ...SINGLE_TRACK_LIST, captions: true }),
    );
    expect(captioning.plan.tracks.text.map((t) => t.kind)).toEqual(['caption']);
    const aviutl = negotiate(plan, new AviUtl2Adapter().capabilities);
    expect(aviutl.plan.tracks.text).toHaveLength(2);
  });

  it('reports a bed it cannot duck rather than pretending it was', () => {
    const plan = makePlan(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 0,
          source_out_ms: 4000,
          timeline_start_ms: 0,
        },
      ],
      {
        audio: [
          { type: 'source_audio', track: 0, gain_db: 0 },
          {
            type: 'external',
            track: 1,
            asset_id: 'asset_003',
            source_in_ms: 0,
            timeline_start_ms: 0,
            gain_db: -18,
            duck_under_speech: true,
          },
        ],
      },
    );
    const { plan: adjusted, downgrades } = negotiate(plan, new PremiereAdapter().capabilities);
    const bed = adjusted.tracks.audio.find((spec) => spec.type === 'external')!;
    expect(bed.type === 'external' && bed.duck_under_speech).toBe(false);
    expect(downgrades.some((d) => d.capability === 'keyframes')).toBe(true);
  });
});

describe('the frame grid', () => {
  it('leaves no frame of black between clips the plan butts together', () => {
    // 2587 ms then 2587 ms at 29.97 rounded to frames 77.5 and 78: the first
    // clip ended on 77, the next began on 78, and every export had a frame of
    // black at 3 of the worked example's cuts.
    const plan = makePlan(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 1850,
          source_out_ms: 4437,
          timeline_start_ms: 0,
        },
        {
          source_asset_id: 'asset_001',
          source_in_ms: 22_080,
          source_out_ms: 24_000,
          timeline_start_ms: 2587,
        },
        {
          source_asset_id: 'asset_001',
          source_in_ms: 24_390,
          source_out_ms: 24_976,
          timeline_start_ms: 4507,
        },
        {
          source_asset_id: 'asset_001',
          source_in_ms: 30_000,
          source_out_ms: 31_000,
          timeline_start_ms: 5093,
        },
      ],
      { rate: [30_000, 1001] },
    );
    const spans = layOnGrid(plan).tracks.get(0)!;
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBe(spans[i - 1]!.end);
  });
});
