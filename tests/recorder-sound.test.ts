import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AviUtl2Adapter,
  EdlAdapter,
  FcpxmlAdapter,
  OtioAdapter,
  PremiereAdapter,
  PreviewAdapter,
  buildAviUtlJob,
  buildEdl,
  buildExo,
  buildFcpXml,
  buildFcpxml,
  buildOtioTimeline,
  clipAudio,
  layOnGrid,
  negotiate,
  previewSegments,
  segmentArgs,
  type ApplyRequest,
  type CommandResult,
  type CommandRunner,
  type EditorAdapter,
} from '@editorial-ir/adapters';
import type { EditPlan, MediaAsset } from '@editorial-ir/contracts';
import { makeAsset, makeIR } from './support/ir.js';
import { childText, findAll, parseXml, type XmlNode } from './support/xml.js';
import {
  makePlan,
  mixedIr,
  mixedPlan,
  recorderAssets,
  recorderIr,
  recorderPlan,
  requestFor,
} from './support/plan.js';

/**
 * A clip whose sound is a separate recorder's, in every adapter.
 *
 * The plan has said so since the analysis learned to line a lavalier or a field
 * recorder up with a camera (`VideoOperation.audio_source`), and no adapter read
 * it: every export put the camera's own sound under the cut — the room, a metre
 * from the speaker — and a camera recording with its microphone off exported
 * with no sound at all, under a cut made by listening to the recorder.
 *
 * The fixture is two cameras and one recorder (`recorderPlan`): 4 s of a camera
 * with no audio stream from its 12 s, which the recorder heard at its own 8.8 s,
 * then 3 s of a camera with its own stereo sound from its 20 s, heard at 16.8 s.
 * At 30 fps the recorder's in points are frames 264 and 504; the pictures' are
 * 360 and 600. A number that is the picture's in an audio element is the bug.
 */

const RECORDER = '/media/ZOOM0007.WAV';
const RECORDER_URL = 'file:///media/ZOOM0007.WAV';
const CAMERAS = ['/media/A001C003.MP4', '/media/B001C004.MP4'];

/** The plan as a target would receive it, and a request that resolves its media. */
function prepared(
  adapter: EditorAdapter,
  plan: EditPlan = recorderPlan(),
  assets: MediaAsset[] = recorderAssets(),
): { plan: EditPlan; request: ApplyRequest } {
  const request = requestFor(plan, recorderIr(assets));
  return { plan: negotiate(plan, adapter.capabilities, assets).plan, request };
}

const lookupIn =
  (assets: MediaAsset[]) =>
  (id: string): MediaAsset | undefined =>
    assets.find((asset) => asset.id === id);

describe('the sound a clip plays', () => {
  it('is read from the recorder at the recorder’s own frame, for the clip’s length', () => {
    const plan = recorderPlan();
    const grid = layOnGrid(plan);
    const [silent, loud] = grid.tracks.get(0)!;
    const lookup = lookupIn(recorderAssets());

    const first = clipAudio(silent!, lookup, grid.rate)!;
    expect(first.asset.id).toBe('asset_103');
    expect(first.separate).toBe(true);
    expect([first.in, first.out]).toEqual([264, 384]);
    expect(first.sourceInMs).toBe(8800);
    expect(first.sound).toMatchObject({ stream: 0, channels: 1 });
    // The picture is still read from the camera, at the camera's frame.
    expect([silent!.in, silent!.out]).toEqual([360, 480]);

    const second = clipAudio(loud!, lookup, grid.rate)!;
    expect(second.asset.id).toBe('asset_103');
    expect([second.in, second.out]).toEqual([504, 594]);
  });

  it('moves the recorder with the picture where the clip’s start rounds to the grid', () => {
    // 2587 ms is 77.53 frames at 29.97 and the clip starts on frame 78. The
    // recorder's 8.82 s is 264.34 frames on its own, which rounds to 264; what
    // the plan plays at frame 78 is 264.80 frames in, which is 265. Rounded on
    // its own, the sound would start most of a frame before its picture.
    const rate = { num: 30_000, den: 1001 };
    const plan = makePlan(
      [
        {
          source_asset_id: 'asset_101',
          source_in_ms: 12_020,
          source_out_ms: 15_020,
          timeline_start_ms: 2587,
          audio_source: { asset_id: 'asset_103', source_in_ms: 8820 },
        },
      ],
      { rate: [rate.num, rate.den] },
    );
    const grid = layOnGrid(plan);
    const span = grid.tracks.get(0)![0]!;
    const audio = clipAudio(span, lookupIn(recorderAssets()), grid.rate)!;
    const frame = rate.den / rate.num;
    const late = span.start * frame - 2.587;
    expect(Math.abs(audio.in * frame - (8.82 + late))).toBeLessThanOrEqual(frame / 2);
    expect(Math.abs(span.in * frame - (12.02 + late))).toBeLessThanOrEqual(frame / 2);
    expect(audio.in).toBe(265);
    expect(audio.out - audio.in).toBe(span.length);
  });

  it('is the clip’s own, exactly as before, when the plan names no recorder', () => {
    // The lavalier on the camera's second stream: `soundOf` over the picture's
    // own range, which every adapter wrote before.
    const plan = mixedPlan();
    const grid = layOnGrid(plan);
    const span = grid.span('op_0005');
    const audio = clipAudio(span, lookupIn(mixedIr().assets), grid.rate)!;
    expect(audio.asset.id).toBe('asset_005');
    expect(audio.separate).toBe(false);
    expect([audio.in, audio.out]).toEqual([span.in, span.out]);
    expect(audio.sound).toMatchObject({ stream: 1, channels: 1, channelOffset: 2 });
  });

  it('falls back to the camera’s own sound, and says so, when the recorder is not there', () => {
    const plan = makePlan(
      recorderPlan().tracks.video.map((operation) => ({
        ...operation,
        audio_source: { asset_id: 'asset_999', source_in_ms: 1000 },
      })),
    );
    const grid = layOnGrid(plan);
    const [silent, loud] = grid.tracks.get(0)!;
    const warnings: string[] = [];
    const lookup = lookupIn(recorderAssets());
    // The camera with its microphone off has nothing to fall back to.
    expect(clipAudio(silent!, lookup, grid.rate, warnings)).toBeUndefined();
    const own = clipAudio(loud!, lookup, grid.rate, warnings)!;
    expect(own).toMatchObject({ separate: false, in: loud!.in, out: loud!.out });
    expect(own.asset.id).toBe('asset_102');
    expect(warnings).toEqual([
      'op_0001 takes its sound from asset_999, which is not available; the clip is silent',
      'op_0002 takes its sound from asset_999, which is not available; the clip’s own sound is used instead',
    ]);
  });

  it('falls back when the recorder has no sound to give', () => {
    const assets = recorderAssets().map((asset) =>
      asset.id === 'asset_103' ? { ...asset, audio_streams: [] } : asset,
    );
    const grid = layOnGrid(recorderPlan());
    const warnings: string[] = [];
    const own = clipAudio(grid.span('op_0002'), lookupIn(assets), grid.rate, warnings)!;
    expect(own.asset.id).toBe('asset_102');
    expect(warnings.join(' ')).toMatch(/ZOOM0007\.WAV, which has no audio stream/);
  });

  it('is nothing when the clip’s sound is not used, recorder or not', () => {
    const plan = makePlan(
      recorderPlan().tracks.video.map((operation) => ({ ...operation, use_source_audio: false })),
    );
    const grid = layOnGrid(plan);
    expect(clipAudio(grid.span('op_0001'), lookupIn(recorderAssets()), grid.rate)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* OpenTimelineIO                                                              */
/* -------------------------------------------------------------------------- */

type OtioNode = Record<string, any>;

function otioTracks(plan: EditPlan, request: ApplyRequest): OtioNode[] {
  return (buildOtioTimeline(plan, request) as { tracks: { children: OtioNode[] } }).tracks.children;
}

describe('OpenTimelineIO, with a separate recorder', () => {
  it('points each clip’s audio at the recorder, from the recorder’s frame', () => {
    const { plan, request } = prepared(new OtioAdapter());
    const tracks = otioTracks(plan, request);
    const clips = (kind: string) =>
      tracks
        .filter((track) => track.kind === kind)
        .flatMap((track) => track.children)
        .filter((child: OtioNode) => child.OTIO_SCHEMA === 'Clip.1');

    const sound = clips('Audio');
    expect(sound.map((clip) => clip.media_reference.target_url)).toEqual([
      RECORDER_URL,
      RECORDER_URL,
    ]);
    expect(
      sound.map((clip) => [clip.source_range.start_time.value, clip.source_range.duration.value]),
    ).toEqual([
      [264, 120],
      [504, 90],
    ]);
    // The recorder's whole length is its available range, not a camera's.
    expect(sound[0].media_reference.available_range.duration.value).toBe(3600);
    expect(sound[0].metadata['editorial-ir'].audio_source).toEqual({
      asset_id: 'asset_103',
      source_in_ms: 8800,
    });
    // Back to back under their pictures, which still read the cameras.
    const audioTrack = tracks.find((track) => track.kind === 'Audio')!;
    expect(audioTrack.children.map((child: OtioNode) => child.OTIO_SCHEMA)).toEqual([
      'Clip.1',
      'Clip.1',
    ]);
    expect(clips('Video').map((clip) => clip.media_reference.target_url)).toEqual(
      CAMERAS.map((path) => `file://${path}`),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Premiere                                                                    */
/* -------------------------------------------------------------------------- */

describe('Premiere, with a separate recorder', () => {
  function xmeml() {
    const { plan, request } = prepared(new PremiereAdapter());
    const root = parseXml(buildFcpXml(plan, request));
    const media = findAll(root, 'media').find((m) =>
      m.children.some((c) => c.tag === 'video' && findAll(c, 'track').length > 0),
    )!;
    const files = new Map<string, XmlNode>();
    for (const file of findAll(root, 'file')) {
      if (file.children.length > 0) files.set(file.attributes.id!, file);
    }
    const fileOf = (clip: XmlNode): XmlNode =>
      files.get(clip.children.find((child) => child.tag === 'file')!.attributes.id!)!;
    return {
      root,
      video: media.children.find((child) => child.tag === 'video')!,
      audio: media.children.find((child) => child.tag === 'audio')!,
      fileOf,
    };
  }

  it('reads the recorder’s file in the audio clipitems, from its frame', () => {
    const { audio, fileOf } = xmeml();
    const clips = findAll(audio, 'clipitem');
    expect(clips.map((clip) => childText(fileOf(clip), 'pathurl'))).toEqual([
      RECORDER_URL,
      RECORDER_URL,
    ]);
    expect(
      clips.map((clip) => ['start', 'end', 'in', 'out'].map((tag) => Number(childText(clip, tag)))),
    ).toEqual([
      [0, 120, 264, 384],
      [120, 210, 504, 594],
    ]);
    // Mono: one clipitem each, on the recorder's one channel.
    expect(clips.map((clip) => childText(findAll(clip, 'sourcetrack')[0]!, 'trackindex'))).toEqual([
      '1',
      '1',
    ]);
  });

  it('defines the recorder as a file of its own, though no picture names it', () => {
    const { audio, fileOf } = xmeml();
    const recorder = fileOf(findAll(audio, 'clipitem')[0]!);
    expect(childText(recorder, 'name')).toBe('ZOOM0007.WAV');
    expect(childText(recorder, 'duration')).toBe('3600');
    expect(findAll(recorder, 'video')).toHaveLength(0);
    expect(childText(findAll(recorder, 'audio')[0]!, 'channelcount')).toBe('1');
  });

  it('links each picture to the recorder’s sound under it, and never to the camera’s', () => {
    const { root, video, audio, fileOf } = xmeml();
    const ids = new Set(findAll(root, 'clipitem').map((clip) => clip.attributes.id!));
    for (const ref of findAll(root, 'linkclipref')) expect(ids.has(ref.text), ref.text).toBe(true);
    const sound = findAll(audio, 'clipitem');
    for (const [index, picture] of findAll(video, 'clipitem').entries()) {
      const links = findAll(picture, 'linkclipref').map((ref) => ref.text);
      expect(links).toEqual([picture.attributes.id, sound[index]!.attributes.id]);
    }
    // The camera with sound of its own is declared with it, and nothing reads it.
    expect(sound.every((clip) => childText(fileOf(clip), 'name') === 'ZOOM0007.WAV')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* FCPXML                                                                      */
/* -------------------------------------------------------------------------- */

describe('FCPXML, with a separate recorder', () => {
  function fcpxml(plan: EditPlan = recorderPlan()) {
    const prepared_ = prepared(new FcpxmlAdapter(), plan);
    const root = parseXml(buildFcpxml(prepared_.plan, prepared_.request));
    const resources = new Map(
      findAll(root, 'resources')[0]!.children.map((node) => [node.attributes.id!, node]),
    );
    const spine = findAll(root, 'spine')[0]!;
    return { root, resources, spine };
  }

  it('declares the recorder as a sound-only asset', () => {
    const { resources } = fcpxml();
    const recorder = [...resources.values()].find((node) => node.attributes.name === 'ZOOM0007')!;
    expect(recorder.tag).toBe('asset');
    expect(recorder.attributes).toMatchObject({ hasAudio: '1', audioChannels: '1' });
    expect(recorder.attributes.hasVideo).toBeUndefined();
    expect(findAll(recorder, 'media-rep')[0]!.attributes.src).toBe(RECORDER_URL);
  });

  it('keeps each picture’s camera sound off and connects the recorder below it', () => {
    const { resources, spine } = fcpxml();
    const [silent, loud] = spine.children;
    // The camera with no microphone has no sound to turn off; the other has
    // its own, and plays none of it.
    expect(silent!.attributes.audioRole).toBeUndefined();
    expect(silent!.attributes.srcEnable).toBeUndefined();
    expect(loud!.attributes.audioRole).toBeUndefined();
    expect(loud!.attributes.srcEnable).toBe('video');

    const connected = [silent!, loud!].map((clip) =>
      clip.children.find((child) => child.tag === 'asset-clip')!,
    );
    for (const [index, sound] of connected.entries()) {
      expect(resources.get(sound.attributes.ref!)!.attributes.name).toBe('ZOOM0007');
      expect(sound.attributes.lane).toBe('-1');
      expect(sound.attributes.audioRole).toBe('dialogue');
      // Anchored at the picture's first frame, in the picture's own time.
      expect(sound.attributes.offset).toBe([silent!, loud!][index]!.attributes.start);
    }
    // 8.8 s and 16.8 s into the recorder, for 4 s and 3 s.
    expect(connected.map((sound) => [sound.attributes.start, sound.attributes.duration])).toEqual([
      ['44/5s', '4s'],
      ['84/5s', '3s'],
    ]);
  });

  it('connects an upper track’s recorder beside it on the storyline, on a lane of its own', () => {
    // A connected clip cannot hold connections of its own, and two clips of
    // sound on one lane would overwrite each other where Resolve makes the lane
    // a track. The bed goes below both.
    const plan = makePlan(
      [
        {
          source_asset_id: 'asset_102',
          source_in_ms: 0,
          source_out_ms: 8000,
          timeline_start_ms: 0,
          audio_source: { asset_id: 'asset_103', source_in_ms: 0 },
        },
        {
          source_asset_id: 'asset_101',
          source_in_ms: 12_000,
          source_out_ms: 14_000,
          timeline_start_ms: 2000,
          track: 1,
          audio_source: { asset_id: 'asset_103', source_in_ms: 8800 },
        },
      ],
      {
        audio: [
          { type: 'source_audio', track: 0, gain_db: 0 },
          {
            type: 'external',
            track: 1,
            asset_id: 'asset_103',
            source_in_ms: 0,
            timeline_start_ms: 0,
            gain_db: -18,
            duck_under_speech: false,
          },
        ],
      },
    );
    const { spine } = fcpxml(plan);
    const parent = spine.children[0]!;
    const anchored = parent.children.filter((child) => child.tag === 'asset-clip');
    expect(anchored.map((clip) => [clip.attributes.name, clip.attributes.lane])).toEqual([
      ['ZOOM0007', '-1'],
      ['A001C003', '1'],
      ['ZOOM0007', '-2'],
      ['ZOOM0007', '-3'],
    ]);
    const upper = anchored[1]!;
    expect(upper.children.filter((child) => child.tag === 'asset-clip')).toHaveLength(0);
    // The upper clip's sound starts where its picture does, in the parent's time.
    expect(anchored[2]!.attributes.offset).toBe(upper.attributes.offset);
    expect(anchored[2]!.attributes.start).toBe('44/5s');
    expect(anchored[3]!.attributes.audioRole).toBe('music');
  });
});

/* -------------------------------------------------------------------------- */
/* CMX 3600                                                                    */
/* -------------------------------------------------------------------------- */

/** Event lines by column: number, reel, channel, then the four timecodes. */
function edlEvents(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => /^\d{3}\s/.test(line))
    .map((line) => line.split(/\s+/).filter((field) => field !== 'C'));
}

describe('CMX 3600, with a separate recorder', () => {
  it('writes the picture and the recorder’s sound as two events at the same record time', () => {
    const { plan, request } = prepared(new EdlAdapter());
    const text = buildEdl(plan, request);
    expect(edlEvents(text)).toEqual([
      ['001', 'A001C003', 'V', '00:00:12:00', '00:00:16:00', '00:00:00:00', '00:00:04:00'],
      ['002', 'ZOOM0007', 'A', '00:00:08:24', '00:00:12:24', '00:00:00:00', '00:00:04:00'],
      // The camera with sound of its own is picture only: not AA/V.
      ['003', 'B001C004', 'V', '00:00:20:00', '00:00:23:00', '00:00:04:00', '00:00:07:00'],
      ['004', 'ZOOM0007', 'A', '00:00:16:24', '00:00:19:24', '00:00:04:00', '00:00:07:00'],
    ]);
    const names = text.match(/^\* FROM CLIP NAME: .*$/gm);
    expect(names).toEqual([
      '* FROM CLIP NAME: A001C003.MP4',
      '* FROM CLIP NAME: ZOOM0007.WAV',
      '* FROM CLIP NAME: B001C004.MP4',
      '* FROM CLIP NAME: ZOOM0007.WAV',
    ]);
    expect(text).toContain(`* SOURCE FILE: ${RECORDER}`);
  });

  it('addresses the recorder by its own clock', () => {
    // A field recorder jammed to time of day: its file starts at 10:00:00:00.
    const assets = recorderAssets().map((asset) =>
      asset.id === 'asset_103' ? { ...asset, metadata: { timecode: '10:00:00:00' } } : asset,
    );
    const { plan, request } = prepared(new EdlAdapter(), recorderPlan(), assets);
    const [, sound] = edlEvents(buildEdl(plan, request));
    expect(sound!.slice(1, 5)).toEqual(['ZOOM0007', 'A', '10:00:08:24', '10:00:12:24']);
  });

  it('puts a chapter under the picture, never under the recorder’s sound', () => {
    // The last clip fades out, so its picture ends at 6 s and the fade to black
    // runs to 7 s — under the recorder's event, which runs the whole clip.
    const base = recorderPlan({ markers: [{ timeline_ms: 6500, name: 'Last', kind: 'chapter' }] });
    const plan: EditPlan = {
      ...base,
      tracks: {
        ...base.tracks,
        video: base.tracks.video.map((operation, index) =>
          index === 1
            ? { ...operation, transition_out: { type: 'fade_out' as const, duration_ms: 1000 } }
            : operation,
        ),
      },
    };
    const prepared_ = prepared(new EdlAdapter(), plan);
    const blocks = buildEdl(prepared_.plan, prepared_.request).split('\n\n');
    const located = blocks.find((block) => block.includes('* LOC:'))!;
    expect(located).toMatch(/^005 {2}B001C004/);
    expect(located).not.toContain('ZOOM0007');
  });
});

/* -------------------------------------------------------------------------- */
/* AviUtl2                                                                     */
/* -------------------------------------------------------------------------- */

describe('AviUtl2, with a separate recorder', () => {
  it('names the recorder as each clip’s sound in the job, and says the version that can', () => {
    const { plan, request } = prepared(new AviUtl2Adapter());
    const job = buildAviUtlJob(plan, request) as {
      job_version: string;
      clips: Record<string, unknown>[];
    };
    expect(job.job_version).toBe('0.3.0');
    expect(job.clips.map((clip) => clip.file)).toEqual(CAMERAS);
    expect(job.clips.map((clip) => clip.use_source_audio)).toEqual([true, true]);
    // The clip-level stream fields describe the clip's own file; there is none.
    expect(job.clips.every((clip) => !('audio_stream_index' in clip))).toBe(true);
    expect(job.clips.map((clip) => clip.audio_source)).toEqual([
      { file: RECORDER, source_offset_frame: 264, audio_stream_index: 0, audio_channels: 1 },
      { file: RECORDER, source_offset_frame: 504, audio_stream_index: 0, audio_channels: 1 },
    ]);
  });

  it('keeps a job with no recorder at the version a 0.2.0 bridge reads', () => {
    const plan = mixedPlan();
    const job = buildAviUtlJob(plan, requestFor(plan)) as { job_version: string };
    expect(job.job_version).toBe('0.2.0');
  });

  it('plays the recorder in the exo, from its position, grouped with the picture', () => {
    const { plan, request } = prepared(new AviUtl2Adapter());
    const exo = buildExo(plan, request).replace(/\r\n/g, '\n');
    const objects = exo.split(/^\[\d+\]\n/m).slice(1);
    const sounds = objects.filter((object) => object.includes('_name=音声ファイル'));
    expect(sounds.map((object) => /^file=(.*)$/m.exec(object)![1])).toEqual([RECORDER, RECORDER]);
    // Seconds into the recorder: 264 and 504 frames at 30 fps.
    expect(sounds.map((object) => /^再生位置=(.*)$/m.exec(object)![1])).toEqual(['8.80', '16.80']);
    const pictures = objects.filter((object) => object.includes('_name=動画ファイル'));
    expect(pictures.map((object) => /^group=(\d+)$/m.exec(object)![1])).toEqual(
      sounds.map((object) => /^group=(\d+)$/m.exec(object)![1]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

/** ffmpeg and ffprobe, answering from a script and recording every call. */
class ScriptedRunner implements CommandRunner {
  readonly calls: { command: string; args: string[] }[] = [];
  constructor(private readonly unreadable: string[] = []) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    if (command === 'ffprobe' && args.includes('format=format_name')) {
      const path = args.at(-1)!;
      return this.unreadable.includes(path)
        ? { stdout: '', stderr: `${path}: Invalid data found when processing input`, code: 1 }
        : { stdout: 'wav', stderr: '', code: 0 };
    }
    if (command === 'ffprobe' && args.includes('-count_packets')) {
      return { stdout: '210\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  }

  pieces(): string[][] {
    return this.calls
      .filter((call) => call.args.some((a) => /^piece-\d+\.mov$/.test(a)))
      .map((call) => call.args)
      .filter((args) => !args.includes('concat'));
  }
}

describe('the preview, with a separate recorder', () => {
  const settings = { width: 640, height: 360, rate: { num: 30, den: 1 }, sampleRate: 48_000 };
  const segments = () =>
    previewSegments(recorderPlan(), recorderAssets(), (id) => lookupIn(recorderAssets())(id)?.path)
      .segments;

  it('hears each piece from the recorder, at the recorder’s own time', () => {
    const [silent, loud] = segments();
    expect(silent!.picture).toMatchObject({ kind: 'video', path: CAMERAS[0], seconds: 12 });
    expect(silent!.sound).toMatchObject({
      kind: 'file',
      path: RECORDER,
      seconds: 8.8,
      stream: 0,
      sameInput: false,
    });
    // The camera with sound of its own: its picture, and the recorder's sound.
    expect(loud!.sound).toMatchObject({ path: RECORDER, seconds: 16.8, sameInput: false });
  });

  it('asks ffmpeg for the recorder as the second input and maps its sound', () => {
    const args = segmentArgs(segments()[1]!, settings, 'piece-0002.mov');
    const inputs = args.filter((_, i) => args[i - 1] === '-i');
    expect(inputs).toEqual([CAMERAS[1], RECORDER]);
    // Each input seeks to its own in point, the recorder to its own time.
    const seeks = args.filter((_, i) => args[i - 1] === '-ss');
    expect(seeks).toEqual(['20.000000', '16.800000']);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[1:a:0]aresample');
    expect(graph).not.toContain('[0:a');
    expect(graph).toContain('atrim=end_sample=144000');
  });

  it('checks the recorder can be read, and falls back to the camera when it cannot', async () => {
    const runner = new ScriptedRunner([RECORDER]);
    const result = await new PreviewAdapter({ runner }).apply(
      requestFor(recorderPlan(), recorderIr()),
    );
    const probed = runner.calls
      .filter((call) => call.command === 'ffprobe' && call.args.includes('format=format_name'))
      .map((call) => call.args.at(-1));
    expect(probed).toContain(RECORDER);
    expect(result.warnings.join(' ')).toMatch(/cannot read \/media\/ZOOM0007\.WAV/);
    expect(result.warnings.join(' ')).toMatch(/op_0002 takes its sound from asset_103.*own sound/);
    const [silent, loud] = runner.pieces();
    // The silent camera is silent; the other plays its own sound.
    expect(silent!.join(' ')).toContain('anullsrc');
    expect(loud!.join(' ')).toContain('[0:a:0]');
    expect(runner.pieces().flat()).not.toContain(RECORDER);
  });
});

function ffmpegInstalled(): boolean {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ffmpegInstalled())('the preview, rendered with a separate recorder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oea-recorder-'));
  // A camera with no microphone at all, and a recorder that is silent for five
  // seconds and then hears a tone: reading it at the right place is the tone,
  // reading it at the camera's time is silence.
  const camera = join(dir, 'camera.mp4');
  const recorder = join(dir, 'recorder.wav');
  const ff = (args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=320x240:r=30:d=4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    camera,
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=mono:d=5',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:r=48000:d=5',
    '-filter_complex',
    '[0:a][1:a]concat=n=2:v=0:a=1',
    '-c:a',
    'pcm_s16le',
    recorder,
  ]);
  const assets = [
    makeAsset({
      id: 'asset_101',
      path: camera,
      file_name: 'camera.mp4',
      duration_ms: 4000,
      audio_streams: [],
    }),
    makeAsset({
      id: 'asset_103',
      path: recorder,
      file_name: 'recorder.wav',
      kind: 'audio',
      duration_ms: 10_000,
      audio_streams: [{ index: 0, codec: 'pcm_s16le', channels: 1, sample_rate: 48_000 }],
    }),
  ];
  const planHearing = (recorderIn: number): EditPlan =>
    makePlan([
      {
        source_asset_id: 'asset_101',
        source_in_ms: 1000,
        source_out_ms: 2500,
        timeline_start_ms: 0,
        audio_source: { asset_id: 'asset_103', source_in_ms: recorderIn },
      },
    ]);

  async function render(plan: EditPlan): Promise<string> {
    const request = {
      ...requestFor(plan, makeIR({ events: [], assets })),
      options: { width: 160 },
    };
    const result = await new PreviewAdapter().apply(request);
    expect(result.warnings).toEqual([]);
    return result.artifacts[0]!.path;
  }

  function peakDb(path: string): number {
    const run = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'],
      { encoding: 'utf8' },
    );
    const peak = /max_volume: (-?[\d.]+|-inf) dB/.exec(run.stderr)?.[1];
    return peak === undefined || peak === '-inf' ? -Infinity : Number(peak);
  }

  it('gives a camera with no microphone the recorder’s sound, from the recorder’s time', async () => {
    const output = await render(planHearing(5500));
    const streams = JSON.parse(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-count_packets',
        '-show_entries',
        'stream=codec_type,nb_read_packets',
        '-of',
        'json',
        output,
      ]).toString(),
    ) as { streams: { codec_type: string; nb_read_packets: string }[] };
    expect(streams.streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
    const video = streams.streams.find((s) => s.codec_type === 'video')!;
    expect(Number(video.nb_read_packets)).toBe(layOnGrid(planHearing(5500)).length);
    // The tone, generated at -18 dBFS; the silent stretch stays below -60.
    expect(peakDb(output)).toBeGreaterThan(-30);
    // The same recorder read at the camera's own time is the silent stretch.
    expect(peakDb(await render(planHearing(1000)))).toBeLessThan(-60);
  }, 60_000);
});

describe('a plan with no recorder', () => {
  it('names none, in any adapter, even with one among the media', () => {
    // The recorder is in the project; the plan plays the cameras' own sound.
    const plan = makePlan(
      recorderPlan().tracks.video.map(({ audio_source: _unused, ...operation }) => operation),
    );
    const request = requestFor(plan, recorderIr());
    const outputs = [
      JSON.stringify(buildOtioTimeline(plan, request)),
      buildFcpXml(plan, request),
      buildFcpxml(plan, request),
      buildEdl(plan, request),
      JSON.stringify(buildAviUtlJob(plan, request)),
      buildExo(plan, request),
      JSON.stringify(
        previewSegments(plan, recorderAssets(), (id) => lookupIn(recorderAssets())(id)?.path),
      ),
    ];
    for (const output of outputs) expect(output).not.toContain('ZOOM0007');
    // And the camera with sound of its own is heard.
    expect(buildEdl(plan, request)).toMatch(/B001C004 AA\/V/);
  });
});
