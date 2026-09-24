import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditorialError, type EditPlan } from '@editorial-ir/contracts';
import {
  PreviewAdapter,
  layOnGrid,
  previewSegments,
  previewSize,
  segmentArgs,
  type CommandResult,
  type CommandRunner,
} from '../src/index.js';
import { makeAsset, makeIR } from '../../../tests/support/ir.js';
import { makePlan, mixedAssets, mixedPlan, requestFor } from '../../../tests/support/plan.js';

/**
 * The preview render.
 *
 * Most of it is deciding what ffmpeg should be asked for — which file, from
 * where, which of its sound streams, for exactly how many frames — and that is
 * tested with ffmpeg scripted. The last block renders for real where ffmpeg is
 * installed, because "the arguments look right" and "the file is the length of
 * the plan" are different claims and only the second one is the point.
 */

/** ffmpeg and ffprobe, answering from a script and recording every call. */
class ScriptedRunner implements CommandRunner {
  readonly calls: { command: string; args: string[] }[] = [];
  constructor(
    private readonly script: {
      ffmpeg?: boolean;
      subtitles?: boolean;
      unreadable?: string[];
      frames?: number;
    } = {},
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    if (command === 'ffmpeg' && this.script.ffmpeg === false) {
      return { stdout: '', stderr: 'not found', code: 127 };
    }
    if (command === 'ffmpeg' && args.includes('-filters')) {
      const filters = [' ... fade              V->V       Fade in/out input video.'];
      if (this.script.subtitles) {
        filters.push(
          ' ... subtitles         V->V       Render text subtitles onto input video using the libass library.',
        );
      }
      return { stdout: filters.join('\n'), stderr: '', code: 0 };
    }
    if (command === 'ffprobe' && args.includes('format=format_name')) {
      const path = args.at(-1)!;
      return (this.script.unreadable ?? []).includes(path)
        ? { stdout: '', stderr: `${path}: Invalid data found when processing input`, code: 1 }
        : { stdout: 'mov,mp4,m4a,3gp,3g2,mj2', stderr: '', code: 0 };
    }
    if (command === 'ffprobe' && args.includes('-count_packets')) {
      return { stdout: `${this.script.frames ?? 0}\n`, stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  }

  /** The render of each piece, in order. */
  pieces(): string[][] {
    return this.calls
      .filter(
        (call) => call.command === 'ffmpeg' && call.args.some((a) => /^piece-\d+\.mov$/.test(a)),
      )
      .map((call) => call.args)
      .filter((args) => !args.includes('concat'));
  }

  join(): string[] {
    return this.calls.find((call) => call.args.includes('concat'))!.args;
  }
}

function segmentsOf(plan: EditPlan) {
  return previewSegments(plan, mixedAssets(), (id) => mixedAssets().find((a) => a.id === id)?.path);
}

describe('what the preview renders', () => {
  it('gives every clip its own kind of picture and the sound it carries', () => {
    const { segments, frames } = segmentsOf(mixedPlan());
    expect(frames).toBe(600);
    expect(segments.map((s) => [s.start, s.frames])).toEqual([
      [0, 120],
      [120, 120],
      [240, 120],
      [360, 120],
      [480, 120],
    ]);
    const [camera, still, memo, drone, lavalier] = segments;
    // A camera clip, from its in point, with its own sound from the same file.
    expect(camera!.picture).toMatchObject({ kind: 'video', path: '/media/C0001.MP4', seconds: 10 });
    expect(camera!.sound).toMatchObject({ kind: 'file', sameInput: true, stream: 0 });
    // A photograph holds; it has no sound to give.
    expect(still!.picture).toMatchObject({ kind: 'still', path: '/media/IMG_2001.jpg' });
    expect(still!.sound).toEqual({ kind: 'silence' });
    // A voice memo is heard over black.
    expect(memo!.picture).toEqual({ kind: 'black' });
    expect(memo!.sound).toMatchObject({
      kind: 'file',
      path: '/media/memo.m4a',
      seconds: 2,
      sameInput: false,
    });
    // A drone clip with no audio stream is silent rather than a failed input.
    expect(drone!.sound).toEqual({ kind: 'silence' });
    // The lavalier on the second stream, not the room tone on the first.
    expect(lavalier!.sound).toMatchObject({ kind: 'file', stream: 1, sameInput: true });
    expect(lavalier!.fadeOut).toBe(30);
  });

  it('places every piece’s sound from its absolute position, so a long cut cannot drift', () => {
    const plan = makePlan(
      Array.from({ length: 40 }, (_, i) => ({
        source_asset_id: 'asset_001',
        source_in_ms: 1000,
        source_out_ms: 2033,
        timeline_start_ms: i * 1033,
      })),
      { rate: [30000, 1001] },
    );
    const { segments } = segmentsOf(plan);
    let samples = 0;
    for (const segment of segments) {
      expect(segment.sampleStart).toBe(samples);
      samples += segment.samples;
    }
    const grid = layOnGrid(plan);
    expect(samples).toBe(Math.round((grid.length * 48_000 * 1001) / 30000));
  });

  it('shows the upper track and plays the sound that is heard', () => {
    // A cutaway on V2, its own sound off, over a clip whose sound goes on.
    const plan = makePlan([
      { source_asset_id: 'asset_001', source_in_ms: 0, source_out_ms: 6000, timeline_start_ms: 0 },
      {
        source_asset_id: 'asset_004',
        source_in_ms: 0,
        source_out_ms: 2000,
        timeline_start_ms: 2000,
        track: 1,
        use_source_audio: false,
      },
    ]);
    const { segments } = segmentsOf(plan);
    expect(segments).toHaveLength(3);
    expect(segments[1]!.picture).toMatchObject({ kind: 'video', path: '/media/DJI_0042.MP4' });
    expect(segments[1]!.sound).toMatchObject({
      kind: 'file',
      path: '/media/C0001.MP4',
      seconds: 2,
      sameInput: false,
    });
    // The V1 clip resumes where it would be had the cutaway not been there.
    expect(segments[2]!.picture).toMatchObject({ kind: 'video', seconds: 4 });
  });

  it('leaves a gap in the plan as black and silence, not a jump', () => {
    const plan = makePlan([
      { source_asset_id: 'asset_001', source_in_ms: 0, source_out_ms: 2000, timeline_start_ms: 0 },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 5000,
        source_out_ms: 7000,
        timeline_start_ms: 3000,
      },
    ]);
    const { segments } = segmentsOf(plan);
    expect(segments.map((s) => s.picture.kind)).toEqual(['video', 'black', 'video']);
    expect(segments[1]).toMatchObject({ start: 60, frames: 30, sound: { kind: 'silence' } });
  });
});

describe('the ffmpeg arguments for one piece', () => {
  const settings = { width: 640, height: 360, rate: { num: 30, den: 1 }, sampleRate: 48_000 };

  it('seeks on the input, maps the chosen stream, and cuts at exactly the piece’s frames', () => {
    const { segments } = segmentsOf(mixedPlan());
    const args = segmentArgs(segments[4]!, settings, 'piece-0005.mov');
    // -ss before -i: a seek, not a decode from the start of the file.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('20.000000');
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:a:1]');
    expect(graph).toContain('trim=end_frame=120');
    expect(graph).toContain('atrim=end_sample=192000');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('120');
    expect(graph).toContain('fade=t=out:st=3.000000:d=1.000000');
  });

  it('reads a still once and repeats it, instead of decoding it for every frame', () => {
    const { segments } = segmentsOf(mixedPlan());
    const args = segmentArgs(segments[1]!, settings, 'piece-0002.mov');
    expect(args).not.toContain('-loop');
    expect(args[args.indexOf('-i') + 1]).toBe('/media/IMG_2001.jpg');
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph.indexOf('scale=')).toBeLessThan(graph.indexOf('loop=loop=-1:size=1'));
    // Its silence is generated, since a photograph has no sound to map.
    expect(args).toContain('anullsrc=r=48000:cl=stereo');
  });

  it('draws sound-only clips over generated black', () => {
    const { segments } = segmentsOf(mixedPlan());
    const args = segmentArgs(segments[2]!, settings, 'piece-0003.mov');
    expect(args).toContain('color=c=black:s=640x360:r=30/1');
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[1:a:0]');
  });

  it('keeps the sequence’s shape at the preview width, in even numbers', () => {
    expect(previewSize(mixedPlan(), 640)).toEqual({ width: 640, height: 360 });
    expect(previewSize(mixedPlan({ width: 1080, height: 1920 }), 640)).toEqual({
      width: 640,
      height: 1138,
    });
    // Never larger than the sequence itself.
    expect(previewSize(mixedPlan({ width: 480, height: 270 }), 640)).toEqual({
      width: 480,
      height: 270,
    });
  });
});

describe('the preview adapter, with ffmpeg scripted', () => {
  const captioned = () =>
    mixedPlan({
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

  it('refuses before writing anything when ffmpeg is not there', async () => {
    const runner = new ScriptedRunner({ ffmpeg: false });
    const adapter = new PreviewAdapter({ runner });
    expect(await adapter.available()).toBe(false);
    const request = requestFor(mixedPlan());
    await expect(adapter.apply(request)).rejects.toThrow(EditorialError);
    expect(runner.calls.every((call) => call.args.includes('-version'))).toBe(true);
  });

  it('burns captions in when this ffmpeg can draw them', async () => {
    const runner = new ScriptedRunner({ subtitles: true, frames: 600 });
    const result = await new PreviewAdapter({ runner }).apply(requestFor(captioned()));
    expect(
      runner.pieces().every((args) => args.join(' ').includes('subtitles=filename=captions.srt')),
    ).toBe(true);
    expect(result.artifacts.map((a) => a.kind)).toEqual(['preview']);
    expect(result.artifacts[0]!.description).toContain('600 frames; the plan is 600');
  });

  it('writes captions beside the preview when this ffmpeg cannot draw them', async () => {
    const runner = new ScriptedRunner({ subtitles: false, frames: 600 });
    const result = await new PreviewAdapter({ runner }).apply(requestFor(captioned()));
    expect(runner.pieces().some((args) => args.join(' ').includes('subtitles='))).toBe(false);
    expect(result.artifacts.map((a) => a.kind)).toEqual(['preview', 'subtitles']);
    expect(existsSync(result.artifacts[1]!.path)).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/no subtitles filter/);
  });

  it('reads its settings from the request', async () => {
    const runner = new ScriptedRunner({ subtitles: true, frames: 600 });
    const request = { ...requestFor(captioned()), options: { width: 320, burn_captions: false } };
    const result = await new PreviewAdapter({ runner }).apply(request);
    expect(runner.pieces()[0]!.join(' ')).toContain('scale=320:180');
    // Asked not to burn them in: beside the file, and no complaint about it.
    expect(result.artifacts.map((a) => a.kind)).toEqual(['preview', 'subtitles']);
    expect(result.warnings.join(' ')).not.toMatch(/no subtitles filter/);
  });

  it('reports a dissolve it cannot render as a cut', async () => {
    const runner = new ScriptedRunner({ frames: 600 });
    const result = await new PreviewAdapter({ runner }).apply(requestFor(mixedPlan()));
    expect(result.downgrades).toContainEqual(
      expect.objectContaining({ operation_id: 'op_0002', action: 'cross_dissolve became a cut' }),
    );
  });

  it('renders a file ffmpeg cannot read as black, and names it', async () => {
    const runner = new ScriptedRunner({ unreadable: ['/media/DJI_0042.MP4'], frames: 600 });
    const result = await new PreviewAdapter({ runner }).apply(requestFor(mixedPlan()));
    expect(result.warnings.join(' ')).toMatch(/cannot read \/media\/DJI_0042\.MP4/);
    const inputs = runner.pieces().flatMap((args) => args.filter((_, i) => args[i - 1] === '-i'));
    expect(inputs).not.toContain('/media/DJI_0042.MP4');
  });

  it('refuses when nothing in the cut can be read, rather than rendering black', async () => {
    // The worked example ships stand-ins for its footage.
    const unreadable = mixedAssets().map((asset) => asset.path);
    const runner = new ScriptedRunner({ unreadable });
    await expect(new PreviewAdapter({ runner }).apply(requestFor(mixedPlan()))).rejects.toThrow(
      /cannot read any of the media/,
    );
    expect(runner.pieces()).toHaveLength(0);
  });

  it('says so when the rendered file is not the length of the plan', async () => {
    const runner = new ScriptedRunner({ frames: 590 });
    const result = await new PreviewAdapter({ runner }).apply(requestFor(mixedPlan()));
    expect(result.warnings.join(' ')).toMatch(/590 frames and the plan 600/);
  });

  it('turns the plan’s chapters into mp4 chapters', async () => {
    const runner = new ScriptedRunner({ frames: 600 });
    await new PreviewAdapter({ runner }).apply(
      requestFor(mixedPlan({ markers: [{ timeline_ms: 8000, name: 'Memo', kind: 'chapter' }] })),
    );
    expect(runner.join()).toContain('-map_chapters');
  });
});

/* -------------------------------------------------------------------------- */
/* For real                                                                    */
/* -------------------------------------------------------------------------- */

function ffmpegInstalled(): boolean {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ffmpegInstalled())('the preview, rendered by ffmpeg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oea-preview-'));
  const media = {
    // Stream 0 is silence (room tone), stream 1 a tone (the lavalier).
    camera: join(dir, 'camera.mp4'),
    still: join(dir, 'still.png'),
    memo: join(dir, 'memo.m4a'),
    drone: join(dir, 'drone.mp4'),
  };
  const ff = (args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=320x240:r=30000/1001:d=6',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:r=48000:d=6',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-t',
    '6',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    media.camera,
  ]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=400x300:d=1', '-frames:v', '1', media.still]);
  ff(['-f', 'lavfi', '-i', 'sine=f=220:r=44100:d=4', '-ac', '1', '-c:a', 'aac', media.memo]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x240:r=25:d=4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    media.drone,
  ]);

  const assets = [
    makeAsset({
      id: 'asset_001',
      path: media.camera,
      file_name: 'camera.mp4',
      duration_ms: 6000,
      fps: 29.97,
      fps_num: 30000,
      fps_den: 1001,
      audio_streams: [
        { index: 0, codec: 'aac', channels: 2, sample_rate: 48_000 },
        { index: 1, codec: 'aac', channels: 1, sample_rate: 48_000 },
      ],
    }),
    makeAsset({
      id: 'asset_002',
      path: media.still,
      file_name: 'still.png',
      kind: 'image',
      duration_ms: 0,
      audio_streams: [],
    }),
    makeAsset({
      id: 'asset_003',
      path: media.memo,
      file_name: 'memo.m4a',
      kind: 'audio',
      duration_ms: 4000,
      audio_streams: [{ index: 0, codec: 'aac', channels: 1, sample_rate: 44_100 }],
    }),
    makeAsset({
      id: 'asset_004',
      path: media.drone,
      file_name: 'drone.mp4',
      duration_ms: 4000,
      fps: 25,
      fps_num: 25,
      fps_den: 1,
      audio_streams: [],
    }),
  ];

  function planWith(stream: number): EditPlan {
    return makePlan(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 1000,
          source_out_ms: 2500,
          timeline_start_ms: 0,
          audio_stream_index: stream,
        },
        {
          source_asset_id: 'asset_002',
          source_in_ms: 0,
          source_out_ms: 1000,
          timeline_start_ms: 1500,
        },
        {
          source_asset_id: 'asset_003',
          source_in_ms: 500,
          source_out_ms: 1700,
          timeline_start_ms: 2500,
        },
        {
          source_asset_id: 'asset_004',
          source_in_ms: 1000,
          source_out_ms: 2000,
          timeline_start_ms: 3700,
        },
      ],
      {
        rate: [30000, 1001],
        width: 1280,
        height: 720,
        text: [
          {
            operation_id: 'op_cap_0001',
            timeline_start_ms: 200,
            timeline_end_ms: 1200,
            text: 'hello',
            kind: 'caption',
            provenance: 'agent_derived',
          },
        ],
      },
    );
  }

  function probe(path: string) {
    const out = execFileSync('ffprobe', [
      '-v',
      'error',
      '-count_packets',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_packets',
      '-of',
      'json',
      path,
    ]).toString();
    return JSON.parse(out) as { streams: Record<string, string | number>[] };
  }

  /** The loudest the first `seconds` of a file get, in dB. */
  function peakDb(path: string, seconds: number): number {
    const run = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-i', path, '-t', String(seconds), '-af', 'volumedetect', '-f', 'null', '-'],
      { encoding: 'utf8' },
    );
    const peak = /max_volume: (-?[\d.]+|-inf) dB/.exec(run.stderr)?.[1];
    return peak === undefined || peak === '-inf' ? -Infinity : Number(peak);
  }

  it('renders every kind of media to the plan’s length, to the frame', async () => {
    const plan = planWith(1);
    const request = {
      ...requestFor(plan, makeIR({ events: [], assets })),
      options: { width: 320 },
    };
    const result = await new PreviewAdapter().apply(request);
    const output = result.artifacts[0]!.path;
    const info = probe(output);
    const video = info.streams.find((s) => s.codec_type === 'video')!;
    const audio = info.streams.find((s) => s.codec_type === 'audio')!;
    expect(video).toMatchObject({
      codec_name: 'h264',
      width: 320,
      height: 180,
      r_frame_rate: '30000/1001',
    });
    expect(audio.codec_name).toBe('aac');
    expect(Number(video.nb_read_packets)).toBe(layOnGrid(plan).length);
    expect(result.warnings).toEqual([]);
  }, 60_000);

  it('plays the sound stream the plan chose', async () => {
    // Stream 0 of the camera is silence; stream 1 carries the tone.
    const levels: number[] = [];
    for (const stream of [0, 1]) {
      const request = requestFor(planWith(stream), makeIR({ events: [], assets }));
      const result = await new PreviewAdapter().apply({ ...request, options: { width: 160 } });
      levels.push(peakDb(result.artifacts[0]!.path, 1.4));
    }
    expect(levels[0]).toBeLessThan(-60);
    // The tone is generated at -18 dBFS and measured at -20.5 dB after AAC and
    // the mono-to-stereo mix; the silent stream stays below -60.
    expect(levels[1]).toBeGreaterThan(-30);
  }, 60_000);

  it('can be run again over its own output', async () => {
    const request = {
      ...requestFor(planWith(1), makeIR({ events: [], assets })),
      options: { width: 160 },
    };
    const first = await new PreviewAdapter().apply(request);
    const second = await new PreviewAdapter().apply(request);
    expect(second.artifacts[0]!.path).toBe(first.artifacts[0]!.path);
    expect(existsSync(join(request.outputDir, '.cut.preview-work'))).toBe(false);
  }, 60_000);
});
