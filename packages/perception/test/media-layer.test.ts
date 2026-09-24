import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FfmpegMediaPreparer,
  FfprobeMediaProbe,
  ScriptedCommandRunner,
  audioArgs,
  chooseAudioStream,
  createLocalSuite,
  frameTimestampsIn,
  framesDirName,
  measureSpeech,
  proxyArgs,
  proxyFileName,
  proxyFrameRate,
  speechOf,
  toProbeResult,
  type CommandResult,
  type FfprobeOutput,
} from '../src/index.js';

/**
 * The media layer's decisions, with ffmpeg scripted.
 *
 * Every case here is a file that broke the pipeline when it was first put
 * through the real CLI: a drone clip with no audio track, a podcast with album
 * art, a camera with a lavalier on its second track, a phone clip that dropped
 * frames. The real-ffmpeg half of the same claims is `scripts/check-media.mjs`.
 */

const scratch = mkdtempSync(join(tmpdir(), 'oea-media-layer-'));

/* --- probe ------------------------------------------------------------------ */

describe('reading a container', () => {
  it('does not mistake album art for the picture', () => {
    // Measured on an MP3 with a cover: the art is a one-frame mjpeg stream at
    // 90000/1 marked attached_pic. Taken as the picture, a podcast had a frame
    // size the sequence could be built to.
    const result = toProbeResult({
      format: { duration: '61.0', format_name: 'mp3' },
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'mp3', channels: 1, sample_rate: '44100' },
        {
          index: 1,
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 600,
          height: 600,
          r_frame_rate: '90000/1',
          avg_frame_rate: '0/0',
          disposition: { attached_pic: 1 },
        },
      ],
    }) as Record<string, unknown>;
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
    expect(result.video_codec).toBeUndefined();
    expect(result.fps_num).toBeUndefined();
    expect(result.audio_codec).toBe('mp3');
  });

  it('gives a still its size and no frame rate', () => {
    // image2 reports 25/1 for every JPEG, and that 25 became a 30 fps project's
    // sequence rate.
    const result = toProbeResult({
      format: { format_name: 'image2', duration: '0.040000' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 4032,
          height: 3024,
          r_frame_rate: '25/1',
          avg_frame_rate: '25/1',
        },
      ],
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ width: 4032, height: 3024, video_codec: 'mjpeg' });
    expect(result.fps_num).toBeUndefined();
    expect(result.variable_frame_rate).toBeUndefined();
    expect(result.audio_streams).toEqual([]);
  });

  it('lists every audio stream by its place among the audio streams', () => {
    const result = toProbeResult({
      format: { duration: '30.0' },
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
        {
          index: 1,
          codec_type: 'audio',
          codec_name: 'aac',
          channels: 2,
          sample_rate: '48000',
          // What ffmpeg writes when nobody named the track. Reported as a
          // title, both tracks read as "SoundHandler".
          tags: { language: 'und', handler_name: 'SoundHandler' },
        },
        { index: 2, codec_type: 'data', codec_name: 'bin_data' },
        {
          index: 3,
          codec_type: 'audio',
          codec_name: 'aac',
          channels: 1,
          sample_rate: '48000',
          tags: { language: 'eng', handler_name: 'Lav' },
        },
      ],
    }) as { audio_streams: unknown[]; audio_channels: number };
    expect(result.audio_streams).toEqual([
      { index: 0, codec: 'aac', channels: 2, sample_rate: 48000 },
      { index: 1, codec: 'aac', channels: 1, sample_rate: 48000, language: 'eng', title: 'Lav' },
    ]);
    // The first-stream fields stay what they were, for everything that reads them.
    expect(result.audio_channels).toBe(2);
  });

  it('says a file with no sound has none, rather than leaving it unsaid', () => {
    const result = toProbeResult({
      format: { duration: '30.0' },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }],
    }) as Record<string, unknown>;
    expect(result.audio_streams).toEqual([]);
    expect(result.audio_codec).toBeUndefined();
  });

  it("takes a phone clip's rate from what it was set to, not from the frames it dropped", () => {
    // The measured case: 455 frames in 20 s of a 30 fps recording. The average,
    // 91/4, was the asset's rate and so the sequence's.
    const result = toProbeResult({
      format: { duration: '20.000000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1280,
          height: 720,
          r_frame_rate: '30/1',
          avg_frame_rate: '91/4',
          nb_frames: '455',
          duration: '20.000000',
        },
      ],
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      fps_num: 30,
      fps_den: 1,
      avg_fps_num: 91,
      avg_fps_den: 4,
      variable_frame_rate: true,
    });
  });

  it('keeps an ordinary NTSC clip constant-rate', () => {
    const result = toProbeResult({
      format: { duration: '3.003000' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 640,
          height: 360,
          r_frame_rate: '30000/1001',
          avg_frame_rate: '30000/1001',
          nb_frames: '90',
          duration: '3.003000',
        },
      ],
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ fps_num: 30000, fps_den: 1001, variable_frame_rate: false });
  });

  it('counts the frames of a WebM, whose declared rates agree even when the frames do not', () => {
    // Measured: a variable-rate WebM declares 30/1 twice and holds 132 frames
    // in 8 s. Only a count tells.
    const webm: FfprobeOutput = {
      format: { duration: '8.000000', format_name: 'matroska,webm' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'vp8',
          width: 320,
          height: 240,
          r_frame_rate: '30/1',
          avg_frame_rate: '30/1',
        },
      ],
    };
    expect((toProbeResult(webm) as Record<string, unknown>).variable_frame_rate).toBe(false);
    expect(
      (toProbeResult(webm, { packetCount: 132 }) as Record<string, unknown>).variable_frame_rate,
    ).toBe(true);
    expect(
      (toProbeResult(webm, { packetCount: 240 }) as Record<string, unknown>).variable_frame_rate,
    ).toBe(false);
  });

  it("does not take a container's millisecond clock for a frame rate", () => {
    // Measured on a Matroska file with irregular timestamps: r and avg both
    // 1000/1, 153 frames in 2.971 s.
    const result = toProbeResult(
      {
        format: { duration: '2.971000', format_name: 'matroska,webm' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 320,
            height: 240,
            r_frame_rate: '1000/1',
            avg_frame_rate: '1000/1',
          },
        ],
      },
      { packetCount: 153 },
    ) as Record<string, unknown>;
    expect(result.fps_num).toBeUndefined();
    expect(result.variable_frame_rate).toBe(true);
  });

  it('counts packets only where the container keeps no count, and only for the picture', async () => {
    const calls: string[][] = [];
    const runner = new ScriptedCommandRunner((_command, args) => {
      calls.push(args);
      if (args.includes('-count_packets')) {
        return json({ streams: [{ nb_read_packets: '132' }] });
      }
      return json({
        format: { duration: '8.0', format_name: 'matroska,webm' },
        streams: [
          { index: 0, codec_type: 'audio', codec_name: 'opus', channels: 2 },
          {
            index: 1,
            codec_type: 'video',
            codec_name: 'vp8',
            width: 320,
            height: 240,
            r_frame_rate: '30/1',
            avg_frame_rate: '30/1',
          },
        ],
      });
    });
    const probed = await new FfprobeMediaProbe({ runner }).probe('/media/screen.webm');
    expect(probed.variable_frame_rate).toBe(true);
    expect(calls).toHaveLength(2);
    // By the picture's own stream number, not "the first video stream".
    expect(calls[1]).toEqual(expect.arrayContaining(['-select_streams', '1']));

    const mp4Calls: string[][] = [];
    const mp4 = new ScriptedCommandRunner((_command, args) => {
      mp4Calls.push(args);
      return json({
        format: { duration: '20.0' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1280,
            height: 720,
            r_frame_rate: '30/1',
            avg_frame_rate: '30/1',
            nb_frames: '600',
            duration: '20.0',
          },
        ],
      });
    });
    await new FfprobeMediaProbe({ runner: mp4 }).probe('/media/clip.mp4');
    // An MP4 says how many frames it holds, and reading the whole file to count
    // them again is paid for nothing.
    expect(mp4Calls).toHaveLength(1);
  });

  it('is versioned, so a probe cached before any of this is not served again', () => {
    expect(new FfprobeMediaProbe().identity.modelVersion).toBeDefined();
  });
});

/* --- prepare ---------------------------------------------------------------- */

interface FakeFile {
  probe: FfprobeOutput;
  /** Samples per audio stream, written when a stream is extracted. */
  audio?: number[][];
  /** How many frames `fps=1` produces. */
  frames?: number;
  /** Derivatives whose ffmpeg call fails. */
  fail?: ('proxy' | 'audio' | 'frames')[];
}

/**
 * ffmpeg and ffprobe, scripted: ffprobe answers from the fake file, and ffmpeg
 * writes what it was asked for — including a partial file before failing, the
 * way a killed run leaves one.
 */
function fakeMedia(file: FakeFile) {
  const ffmpegCalls: string[][] = [];
  const runner = new ScriptedCommandRunner((command, args): CommandResult | undefined => {
    if (command === 'ffprobe') return json(file.probe);
    ffmpegCalls.push(args);
    const output = args[args.length - 1] ?? '';
    const kind = output.endsWith('.jpg') ? 'frames' : output.endsWith('.wav') ? 'audio' : 'proxy';
    if (kind === 'frames') {
      const dir = dirname(output);
      for (let i = 1; i <= (file.frames ?? 0); i++) {
        writeFileSync(join(dir, `${String(i).padStart(8, '0')}.jpg`), 'jpeg');
      }
    } else if (kind === 'audio') {
      const map = args[args.indexOf('-map') + 1] ?? '0:a:0';
      const stream = Number(map.split(':').at(-1));
      writeWav(output, file.audio?.[stream] ?? []);
    } else {
      writeFileSync(output, 'half a proxy');
    }
    if (file.fail?.includes(kind)) {
      throw new Error(`${kind} failed`);
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  return { runner, ffmpegCalls };
}

function preparerFor(file: FakeFile) {
  const media = fakeMedia(file);
  const preparer = new FfmpegMediaPreparer({ runner: media.runner });
  return { preparer, ...media };
}

function workDir(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const VIDEO_WITH_NO_AUDIO: FfprobeOutput = {
  format: { duration: '30.0', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1280,
      height: 720,
      r_frame_rate: '30/1',
      avg_frame_rate: '30/1',
      nb_frames: '900',
      duration: '30.0',
    },
  ],
};

function withAudio(channels: number[]): FfprobeOutput {
  return {
    ...VIDEO_WITH_NO_AUDIO,
    streams: [
      ...(VIDEO_WITH_NO_AUDIO.streams ?? []),
      ...channels.map((count, i) => ({
        index: i + 1,
        codec_type: 'audio',
        codec_name: 'aac',
        channels: count,
        sample_rate: '48000',
      })),
    ],
  };
}

describe('preparing a file', () => {
  it('keeps the frames of a video with no audio track, and asks for no audio', async () => {
    // A drone clip. Audio was extracted before frames in one sequence, ffmpeg
    // refused ("Output file does not contain any stream"), and the frames were
    // never made.
    const { preparer, ffmpegCalls } = preparerFor({ probe: VIDEO_WITH_NO_AUDIO, frames: 30 });
    const result = await preparer.prepare({
      path: '/media/DJI_0042.mp4',
      work_dir: workDir('no-audio'),
      proxy_height: 480,
      extract_audio: true,
      frame_fps: 1,
    });
    expect(result.audio_stream_count).toBe(0);
    expect(result.audio_path).toBeUndefined();
    expect(result.failed).toBeUndefined();
    expect(result.frames_dir).toBeDefined();
    expect(result.frame_timestamps_ms).toHaveLength(30);
    expect(ffmpegCalls.some((args) => args.some((a) => a.endsWith('.wav')))).toBe(false);
  });

  it('makes every derivative it can when one of them fails', async () => {
    const { preparer } = preparerFor({
      probe: withAudio([2]),
      audio: [tone(1, 0.3)],
      frames: 30,
      fail: ['audio'],
    });
    const result = await preparer.prepare({
      path: '/media/clip.mp4',
      work_dir: workDir('one-fails'),
      proxy_height: 480,
      extract_audio: true,
      frame_fps: 1,
    });
    expect(result.proxy_path).toBeDefined();
    expect(result.frames_dir).toBeDefined();
    expect(result.audio_path).toBeUndefined();
    expect(result.failed).toEqual([{ derivative: 'audio', reason: 'audio failed' }]);
  });

  it('never keeps a half-written derivative for the next run to trust', async () => {
    // A run killed mid-encode left proxy.mp4 on disk; every run after it found
    // the file, skipped the encode and read a truncated proxy.
    const dir = workDir('interrupted');
    const broken = preparerFor({ probe: VIDEO_WITH_NO_AUDIO, fail: ['proxy'] });
    const first = await broken.preparer.prepare({
      path: '/media/clip.mp4',
      work_dir: dir,
      proxy_height: 480,
      extract_audio: false,
      frame_fps: 0,
    });
    expect(first.proxy_path).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);

    const fixed = preparerFor({ probe: VIDEO_WITH_NO_AUDIO });
    const second = await fixed.preparer.prepare({
      path: '/media/clip.mp4',
      work_dir: dir,
      proxy_height: 480,
      extract_audio: false,
      frame_fps: 0,
    });
    expect(second.proxy_path).toBe(join(dir, 'proxy-480p-cfr30.mp4'));
    expect(fixed.ffmpegCalls).toHaveLength(1);
  });

  it('reuses what an earlier run finished, without encoding it again', async () => {
    const dir = workDir('reuse');
    const file: FakeFile = { probe: withAudio([2]), audio: [tone(1, 0.3)], frames: 12 };
    const first = preparerFor(file);
    const params = {
      path: '/media/clip.mp4',
      work_dir: dir,
      proxy_height: 480,
      extract_audio: true,
      frame_fps: 1,
    };
    const made = await first.preparer.prepare(params);
    expect(first.ffmpegCalls).toHaveLength(3);

    const second = preparerFor(file);
    const reused = await second.preparer.prepare(params);
    expect(second.ffmpegCalls).toHaveLength(0);
    expect(reused).toEqual(made);
  });

  it('names each derivative after everything that makes it different', async () => {
    const ntsc: FfprobeOutput = {
      ...withAudio([2, 1]),
      streams: (withAudio([2, 1]).streams ?? []).map((s) =>
        s.codec_type === 'video'
          ? { ...s, r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001', nb_frames: '899' }
          : s,
      ),
    };
    const { preparer } = preparerFor({
      probe: ntsc,
      audio: [noise(0.01), speechLike()],
      frames: 3,
    });
    const dir = workDir('names');
    const result = await preparer.prepare({
      path: '/media/C0007.MP4',
      work_dir: dir,
      proxy_height: 480,
      extract_audio: true,
      frame_fps: 1,
    });
    expect(result.proxy_path).toBe(join(dir, 'proxy-480p-cfr30000-1001.mp4'));
    expect(result.audio_path).toBe(join(dir, 'audio-a1.wav'));
    expect(result.frames_dir).toBe(join(dir, 'frames-1fps'));
    expect(existsSync(join(dir, 'audio-a0.wav'))).toBe(true);
  });

  it('fills in the frame timestamps, as the worker always did', async () => {
    const { preparer } = preparerFor({ probe: VIDEO_WITH_NO_AUDIO, frames: 4 });
    const result = await preparer.prepare({
      path: '/media/clip.mp4',
      work_dir: workDir('timestamps'),
      proxy_height: 0,
      extract_audio: false,
      frame_fps: 2,
    });
    // This was always [], so the visual stage's fallback for a file with no
    // shots had nothing to fall back to in the default suite.
    expect(result.frame_timestamps_ms).toEqual([0, 500, 1000, 1500]);
  });

  it('makes neither proxy nor frames of a still or of album art', async () => {
    const still = preparerFor({
      probe: {
        format: { format_name: 'image2', duration: '0.04' },
        streams: [{ codec_type: 'video', codec_name: 'mjpeg', width: 4032, height: 3024 }],
      },
    });
    const result = await still.preparer.prepare({
      path: '/media/IMG_2001.jpg',
      work_dir: workDir('still'),
      proxy_height: 480,
      extract_audio: true,
      frame_fps: 1,
    });
    expect(still.ffmpegCalls).toHaveLength(0);
    expect(result).toEqual({ frame_timestamps_ms: [], audio_stream_count: 0 });
  });
});

describe('choosing an audio stream', () => {
  it('hears the lavalier on the second track, not the room tone on the first', async () => {
    // The measured case: stereo room tone on a:0, the mono lav on a:1. ffmpeg's
    // default picks the stream with more channels, and five sentences were
    // transcribed as none.
    const { preparer } = preparerFor({
      probe: withAudio([2, 1]),
      audio: [noise(0.01), speechLike()],
    });
    const result = await preparer.prepare({
      path: '/media/C0007.mp4',
      work_dir: workDir('lav'),
      proxy_height: 0,
      extract_audio: true,
      frame_fps: 0,
    });
    expect(result.audio_stream_index).toBe(1);
    expect(result.audio_stream_count).toBe(2);
    expect(result.audio_stream_reason).toMatch(/^most speech of 2 \(0\.\d\d vs 0\.00\)$/);
  });

  it('takes the stream it is asked for', async () => {
    const { preparer, ffmpegCalls } = preparerFor({
      probe: withAudio([2, 1]),
      audio: [noise(0.01), speechLike()],
    });
    const result = await preparer.prepare({
      path: '/media/C0007.mp4',
      work_dir: workDir('asked'),
      proxy_height: 0,
      extract_audio: true,
      frame_fps: 0,
      audio_stream_index: 0,
    });
    expect(result).toMatchObject({ audio_stream_index: 0, audio_stream_reason: 'asked for' });
    // Only the one asked for is extracted: nothing to measure, nothing to pay.
    expect(ffmpegCalls).toHaveLength(1);
  });

  it('says so when the only stream is the only one', async () => {
    const { preparer } = preparerFor({ probe: withAudio([2]), audio: [speechLike()] });
    const result = await preparer.prepare({
      path: '/media/clip.mp4',
      work_dir: workDir('only'),
      proxy_height: 0,
      extract_audio: true,
      frame_fps: 0,
    });
    expect(result).toMatchObject({ audio_stream_index: 0, audio_stream_reason: 'the only one' });
  });

  it('breaks a tie on speech by level, and a tie on both by order', () => {
    const quiet = { index: 0, speech_hops: 0, hops: 100, median_db: -60 };
    const loud = { index: 1, speech_hops: 0, hops: 100, median_db: -30 };
    expect(chooseAudioStream([quiet, loud], 2)).toEqual({
      index: 1,
      reason: 'as much speech as the others of 2 (0.00), and the loudest (-30.0 vs -60.0 dB)',
    });
    expect(
      chooseAudioStream(
        [
          { ...loud, index: 3 },
          { ...loud, index: 2 },
        ],
        4,
      ).index,
    ).toBe(2);
  });

  it('compares shares exactly, whatever the lengths', () => {
    // 1 of 3 against 33 of 100: a float comparison of 0.333… and 0.33 is right
    // here, and a rounded one is not. Integers settle it the same way in both
    // runtimes.
    const a = { index: 0, speech_hops: 1, hops: 3, median_db: -40 };
    const b = { index: 1, speech_hops: 33, hops: 100, median_db: -20 };
    expect(chooseAudioStream([b, a], 2).index).toBe(0);
  });

  it('measures on the lower median, which cannot round differently in Python', () => {
    expect(speechOf([0.6, 0.1, 0.5, 0.49], [-10, -20, -30, -40], 0)).toEqual({
      index: 0,
      speech_hops: 2,
      hops: 4,
      median_db: -30,
    });
  });
});

describe('the default suite', () => {
  it('gives the preparer the same probe as ingest', () => {
    const suite = createLocalSuite();
    expect(suite.preparer).toBeInstanceOf(FfmpegMediaPreparer);
  });

  it('builds the arguments each derivative is named for', () => {
    expect(audioArgs('in.mov', 'out.wav', 1).join(' ')).toContain('-map 0:a:1');
    expect(proxyArgs('in.mov', 'out.mp4', 480, 28, { num: 30, den: 1 }).join(' ')).toContain(
      'fps=30/1,scale=-2:480',
    );
    expect(proxyFileName(480, undefined)).toBe('proxy-480p.mp4');
    expect(framesDirName(0.5)).toBe('frames-0.5fps');
    // A screen recorder that declares its millisecond clock is not proxied at a
    // thousand frames a second.
    expect(proxyFrameRate({ fps_num: 1000, fps_den: 1 })).toEqual({ num: 60, den: 1 });
    expect(proxyFrameRate({ fps_num: 60000, fps_den: 1001 })).toEqual({ num: 60000, den: 1001 });
    expect(proxyFrameRate({})).toEqual({ num: 60, den: 1 });
  });

  it('counts only the frames prepare named, never a file some other stage left there', () => {
    const dir = workDir('frames-count');
    for (const name of ['00000001.jpg', '00000002.jpg', 'at-00001000ms.jpg', 'notes.txt']) {
      writeFileSync(join(dir, name), '');
    }
    expect(frameTimestampsIn(dir, 1)).toEqual([0, 1000]);
  });
});

/* --- the two runtimes -------------------------------------------------------- */

const WORKER_SRC = fileURLToPath(new URL('../../../services/perception/src', import.meta.url));

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!pythonAvailable())('the worker, on the same audio', () => {
  it('measures every stream the same and chooses the same one', () => {
    // Which runtime prepares a file is a deployment detail. If the two chose
    // differently, the same footage would be transcribed from a different track
    // depending on what was installed.
    const paths = [
      writeWav(join(scratch, 'parity-a0.wav'), noise(0.01)),
      writeWav(join(scratch, 'parity-a1.wav'), speechLike()),
      writeWav(join(scratch, 'parity-a2.wav'), tone(3, 0.2)),
    ];
    const measured = paths.map((path, index) => measureSpeech(path, index));
    const typescript = chooseAudioStream(measured, paths.length);

    const script = [
      'import json, sys',
      'from editorial_perception import media',
      'paths = json.loads(sys.argv[1])',
      'measured = [media.measure_speech(p, i) for i, p in enumerate(paths)]',
      'print(json.dumps({"measured": measured, "choice": media.choose_audio_stream(measured, len(paths))}))',
    ].join('\n');
    const python = JSON.parse(
      execFileSync('python3', ['-c', script, JSON.stringify(paths)], {
        env: { ...process.env, PYTHONPATH: WORKER_SRC },
        encoding: 'utf8',
      }),
    ) as { measured: unknown; choice: unknown };

    expect(python.measured).toEqual(measured);
    expect(python.choice).toEqual(typescript);
    expect(typescript.index).toBe(1);
  });
});

/* --- helpers ----------------------------------------------------------------- */

function json(value: unknown): CommandResult {
  return { stdout: JSON.stringify(value), stderr: '', code: 0 };
}

const RATE = 16_000;

/** Speech-shaped: bursts of a voiced tone between silences, so it has dynamic range. */
function speechLike(): number[] {
  const samples: number[] = [];
  for (let second = 0; second < 6; second++) {
    for (let i = 0; i < RATE; i++) {
      const voiced = i < RATE * 0.6;
      samples.push(voiced ? 0.4 * Math.sin((2 * Math.PI * 220 * i) / RATE) : 0);
    }
  }
  return samples;
}

/** Room tone: steady, quiet, no structure — no dynamic range, so no speech by construction. */
function noise(amplitude: number): number[] {
  let seed = 7;
  return Array.from({ length: RATE * 6 }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return amplitude * ((seed / 2147483648) * 2 - 1);
  });
}

function tone(seconds: number, amplitude: number): number[] {
  return Array.from(
    { length: RATE * seconds },
    (_, i) => amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE),
  );
}

function writeWav(path: string, samples: number[]): string {
  const data = Buffer.alloc(samples.length * 2);
  for (const [index, sample] of samples.entries()) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}
