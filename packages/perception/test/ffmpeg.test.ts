import { describe, expect, it } from 'vitest';
import {
  FfprobeMediaProbe,
  ScriptedCommandRunner,
  audioArgs,
  buildShots,
  frameArgs,
  frameFileName,
  frameTimestampMs,
  parseRational,
  parseShowinfoTimes,
  proxyArgs,
  toProbeResult,
} from '../src/index.js';

describe('parseRational', () => {
  it('keeps NTSC rates exact', () => {
    expect(parseRational('30000/1001')).toEqual({ num: 30000, den: 1001 });
    expect(parseRational('25/1')).toEqual({ num: 25, den: 1 });
    expect(parseRational('24')).toEqual({ num: 24, den: 1 });
  });

  it('rejects the forms ffprobe uses for "no video"', () => {
    expect(parseRational('0/0')).toBeUndefined();
    expect(parseRational('0/1')).toBeUndefined();
    expect(parseRational(undefined)).toBeUndefined();
  });
});

describe('toProbeResult', () => {
  const sample = {
    format: {
      duration: '381.420000',
      format_name: 'mov,mp4,m4a',
      bit_rate: '82000000',
      tags: { creation_time: '2026-08-14T09:12:33.000000Z' },
    },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'hevc',
        width: 3840,
        height: 2160,
        avg_frame_rate: '30000/1001',
        r_frame_rate: '30000/1001',
        side_data_list: [{ rotation: -90 }],
      },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
    ],
  };

  it('maps the fields the pipeline relies on', () => {
    const result = toProbeResult(sample) as Record<string, unknown>;
    expect(result.duration_ms).toBe(381_420);
    expect(result.width).toBe(3840);
    expect(result.fps_num).toBe(30000);
    expect(result.fps_den).toBe(1001);
    expect(result.video_codec).toBe('hevc');
    expect(result.audio_channels).toBe(2);
    expect(result.creation_time).toBe('2026-08-14T09:12:33.000000Z');
  });

  it('normalises rotation into [0,360)', () => {
    expect((toProbeResult(sample) as { rotation: number }).rotation).toBe(270);
    const tagged = { streams: [{ codec_type: 'video', tags: { rotate: '90' } }] };
    expect((toProbeResult(tagged) as { rotation: number }).rotation).toBe(90);
  });

  it('survives an audio-only file', () => {
    const audioOnly = {
      format: { duration: '61.0' },
      streams: [{ codec_type: 'audio', codec_name: 'mp3', channels: 1, sample_rate: '44100' }],
    };
    const result = toProbeResult(audioOnly) as Record<string, unknown>;
    expect(result.duration_ms).toBe(61_000);
    expect(result.width).toBeUndefined();
    expect(result.fps_num).toBeUndefined();
  });

  it('survives a file with no metadata at all', () => {
    expect((toProbeResult({}) as { duration_ms: number }).duration_ms).toBe(0);
  });
});

describe('FfprobeMediaProbe', () => {
  it('calls ffprobe and validates its output', async () => {
    const runner = new ScriptedCommandRunner(() => ({
      stdout: JSON.stringify({ format: { duration: '12.5' }, streams: [] }),
      stderr: '',
      code: 0,
    }));
    const probe = new FfprobeMediaProbe({ runner });
    const result = await probe.probe('/tmp/clip.mov');
    expect(result.duration_ms).toBe(12_500);
    expect(runner.calls[0]?.args).toContain('-show_streams');
  });

  it('reports a clear error when ffprobe returns something that is not JSON', async () => {
    const runner = new ScriptedCommandRunner(() => ({ stdout: 'not json', stderr: '', code: 0 }));
    await expect(new FfprobeMediaProbe({ runner }).probe('/tmp/clip.mov')).rejects.toThrow(
      /not JSON/,
    );
  });
});

describe('ffmpeg arguments', () => {
  it('scales the proxy to an even width, which h264 requires', () => {
    expect(proxyArgs('in.mov', 'out.mp4', 480, 28)).toContain('scale=-2:480');
  });

  it('prepares audio the way every transcriber wants it', () => {
    const args = audioArgs('in.mov', 'out.wav');
    expect(args).toContain('pcm_s16le');
    expect(args.join(' ')).toContain('-ac 1');
    expect(args.join(' ')).toContain('-ar 16000');
  });

  it('samples frames at the requested rate', () => {
    expect(frameArgs('in.mov', '/frames', 1).join(' ')).toContain('fps=1');
  });

  it('maps a frame index back to its timestamp', () => {
    expect(frameTimestampMs(1, 1)).toBe(0);
    expect(frameTimestampMs(2, 1)).toBe(1000);
    expect(frameTimestampMs(3, 2)).toBe(1000);
    expect(frameFileName(42)).toBe('00000042.jpg');
  });
});

describe('parseShowinfoTimes', () => {
  it('pulls presentation times out of the log', () => {
    const stderr = [
      '[Parsed_showinfo_1 @ 0x55] n:0 pts:12012 pts_time:0.4004 pos:48',
      '[Parsed_showinfo_1 @ 0x55] n:1 pts:120120 pts_time:4.004 pos:900',
      'frame= 2 fps=0.0 q=-0.0 Lsize=N/A',
    ].join('\n');
    expect(parseShowinfoTimes(stderr)).toEqual([400, 4004]);
  });

  it('returns nothing when there were no scene changes', () => {
    expect(parseShowinfoTimes('frame= 0 fps=0.0')).toEqual([]);
  });
});

describe('buildShots', () => {
  it('turns boundaries into contiguous shots that cover the file', () => {
    const shots = buildShots([4000, 9000], 15_000, 800);
    expect(shots).toHaveLength(3);
    expect(shots[0]).toMatchObject({ start_ms: 0, end_ms: 4000 });
    expect(shots[2]).toMatchObject({ start_ms: 9000, end_ms: 15_000 });
    // No gaps and no overlaps.
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i]!.start_ms).toBe(shots[i - 1]!.end_ms);
    }
  });

  it('places the representative frame past the transition', () => {
    const [shot] = buildShots([], 3000, 800);
    expect(shot!.representative_frame_ms).toBeGreaterThan(shot!.start_ms);
    expect(shot!.representative_frame_ms).toBeLessThan(shot!.end_ms);
  });

  it('drops flash-frame boundaries instead of emitting slivers', () => {
    // Three boundaries 100 ms apart: a compression artefact, not three shots.
    const shots = buildShots([1000, 1100, 1200, 5000], 8000, 800);
    expect(shots.map((s) => s.start_ms)).toEqual([0, 1000, 5000]);
  });

  it('ignores boundaries past the end of the file', () => {
    const shots = buildShots([2000, 99_000], 5000, 800);
    expect(shots.map((s) => s.start_ms)).toEqual([0, 2000]);
  });

  it('produces one shot when nothing changed', () => {
    expect(buildShots([], 10_000, 800)).toEqual([
      { start_ms: 0, end_ms: 10_000, representative_frame_ms: 3333 },
    ]);
  });
});
