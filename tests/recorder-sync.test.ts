import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '@editorial-ir/cli';
import type { EditPlan, EditorialIR, ObservationTimeline } from '@editorial-ir/contracts';

/**
 * A camera and a separate recorder, through the commands a user types.
 *
 * Made with ffmpeg rather than stored: one minute-long scene of sounds that
 * start at irregular moments, heard by a recorder started first and by a camera
 * started 3.2 seconds later, quieter and noisier, plus a second recorder of a
 * different scene. The analysis has to find the 3.2 seconds, take the recorder
 * for the camera's sound, and leave the unrelated recording alone.
 */

function ffmpegInstalled(): boolean {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Noise bursts gated by four incommensurate sines: onsets at irregular moments.
 * Another `pace` is another scene.
 */
function scene(pace: number): string {
  const sines = [0.37, 1.13, 2.71, 0.071].map((hz, i) => `sin(2*PI*${hz * pace}*t+${i})`).join('+');
  return `aevalsrc=exprs=0.4*(random(0)*2-1)*gt(${sines}\\,1.1):s=48000:d=40`;
}

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'ignore' });
}

/** The camera starts this long after the recorder. */
const CAMERA_LATE_MS = 3_200;
/** A second camera, on the same scene, starts this long after the recorder. */
const SECOND_LATE_MS = 10_000;

/** A camera that heard `scene` from `lateMs` on, quieter and noisier than the recorder. */
function camera(scene: string, lateMs: number, lengthMs: number, picture: string, out: string) {
  const seconds = String(lengthMs / 1000);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `${picture}=s=320x240:r=25:d=${seconds}`,
    '-ss',
    String(lateMs / 1000),
    '-t',
    seconds,
    '-i',
    scene,
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=a=0.03:d=${seconds}:r=48000:seed=${lateMs}`,
    '-filter_complex',
    '[1]volume=0.3[a];[a][2]amix=inputs=2:normalize=0[m]',
    '-map',
    '0:v',
    '-map',
    '[m]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    out,
  ]);
}

let root = '';
let project = '';

describe.skipIf(!ffmpegInstalled())('a camera and a separate recorder', () => {
  let output: string[] = [];
  beforeEach(() => {
    output = [];
    const collect = (chunk: unknown) => {
      output.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(collect);
    vi.spyOn(process.stderr, 'write').mockImplementation(collect);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'oea-recorder-'));
    const footage = join(root, 'footage');
    mkdirSync(footage);
    const sceneWav = join(root, 'scene.wav');
    ffmpeg(['-f', 'lavfi', '-i', scene(1), '-ac', '1', sceneWav]);
    // The recorder: the whole scene, at the speaker's collar.
    ffmpeg([
      '-i',
      sceneWav,
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=a=0.01:d=40:r=48000',
      '-filter_complex',
      '[0]volume=0.8[a];[a][1]amix=inputs=2:normalize=0[m]',
      '-map',
      '[m]',
      '-c:a',
      'pcm_s16le',
      join(footage, 'ZOOM0001.WAV'),
    ]);
    // The cameras: started later, their microphones a metre away. The second
    // films the middle of the same scene from somewhere else.
    camera(sceneWav, CAMERA_LATE_MS, 30_000, 'testsrc2', join(footage, 'C0001.MP4'));
    camera(sceneWav, SECOND_LATE_MS, 20_000, 'smptebars', join(footage, 'C0002.MP4'));
    // Another recording of another scene.
    const other = join(root, 'other.wav');
    ffmpeg(['-f', 'lavfi', '-i', scene(1.17), '-ac', '1', other]);
    copyFileSync(other, join(footage, 'ROOM_TONE.WAV'));

    project = join(root, 'proj');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['init', project])).toBe(0);
    expect(await main(['ingest', '--project', project, footage])).toBe(0);
    vi.restoreAllMocks();
  }, 120_000);

  const read = <T>(name: string): T =>
    JSON.parse(readFileSync(join(project, '.oea', name), 'utf8')) as T;
  const latestPlan = (): EditPlan => {
    const dir = join(project, '.oea', 'plans');
    const newest = readdirSync(dir)
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
    return JSON.parse(readFileSync(newest, 'utf8')) as EditPlan;
  };
  const idOf = (ir: EditorialIR, name: string): string =>
    ir.assets.find((asset) => asset.file_name === name)!.id;

  it('finds where the recorder lines up with the camera, and nothing for the other recording', async () => {
    expect(
      await main(['analyze', '--project', project, '--perception', 'local', '--offline-minimal']),
    ).toBe(0);
    const ir = read<EditorialIR>('ir.json');
    const observations = read<ObservationTimeline>('observations.json');
    const camera = idOf(ir, 'C0001.MP4');
    const recorder = idOf(ir, 'ZOOM0001.WAV');
    const other = idOf(ir, 'ROOM_TONE.WAV');

    // Measured to the hop: the recorder's first moment is 3.2 s before the camera's.
    const sync = observations.syncs.find(
      (s) => s.asset_id === recorder && s.reference_asset_id === camera,
    )!;
    expect(Math.abs(sync.offset_ms + CAMERA_LATE_MS)).toBeLessThanOrEqual(20);
    expect(observations.syncs.some((s) => s.asset_id === other)).toBe(false);

    const second = idOf(ir, 'C0002.MP4');
    expect(
      ir.audio_companions.map((c) => `${c.audio_asset_id} under ${c.asset_id}`).sort(),
    ).toEqual([`${recorder} under ${camera}`, `${recorder} under ${second}`].sort());
    const onSecond = ir.audio_companions.find((c) => c.asset_id === second)!;
    expect(Math.abs(onSecond.offset_ms + SECOND_LATE_MS)).toBeLessThanOrEqual(20);
    // Mostly the camera's sound, so no events of its own; the other recording keeps its own.
    expect(ir.events.some((e) => e.source_ranges.some((r) => r.asset_id === recorder))).toBe(false);
    expect(ir.events.some((e) => e.source_ranges.some((r) => r.asset_id === other))).toBe(true);

    expect(output.join('')).toMatch(
      /ZOOM0001\.WAV is the sound of C0001\.MP4: started 3\.\d\ds before it/,
    );
  }, 120_000);

  it('links what the two cameras filmed of the same moment, so a cut says it once', () => {
    const ir = read<EditorialIR>('ir.json');
    const camera = idOf(ir, 'C0001.MP4');
    const second = idOf(ir, 'C0002.MP4');
    const assetOf = (eventId: string): string =>
      ir.events.find((e) => e.id === eventId)!.source_ranges[0]!.asset_id;
    const moments = ir.relations.filter(
      (r) => r.relation_type === 'duplicate_of' && r.note?.includes('another camera'),
    );
    expect(moments.length).toBeGreaterThan(0);
    for (const relation of moments) {
      expect([assetOf(relation.source_event_id), assetOf(relation.target_event_id)].sort()).toEqual(
        [camera, second].sort(),
      );
      expect(relation.strength).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('plays the recorder under the camera’s picture, at the moment the picture shows', async () => {
    expect(
      await main([
        'plan',
        '--project',
        project,
        '--skill',
        'travel-vlog',
        '--duration',
        '40',
        '--offline-minimal',
      ]),
    ).toBe(0);
    const ir = read<EditorialIR>('ir.json');
    const camera = idOf(ir, 'C0001.MP4');
    const recorder = idOf(ir, 'ZOOM0001.WAV');
    const offset = ir.audio_companions.find((c) => c.asset_id === camera)!.offset_ms;
    const fromCamera = latestPlan().tracks.video.filter((op) => op.source_asset_id === camera);
    expect(fromCamera.length).toBeGreaterThan(0);
    for (const op of fromCamera) {
      expect(op.use_source_audio).toBe(true);
      expect(op.audio_source).toEqual({
        asset_id: recorder,
        source_in_ms: op.source_in_ms - offset,
      });
    }
  }, 120_000);

  it('unpairs them when context.yaml says they do not go together, without analysing again', async () => {
    const path = join(project, '.oea', 'context.yaml');
    const context = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      context.replace(
        'background:\n',
        'background:\n  recorders:\n' +
          '    - { recorder: ZOOM0001.WAV, video: C0001.MP4, paired: false }\n',
      ),
    );
    expect(
      await main(['analyze', '--project', project, '--perception', 'local', '--offline-minimal']),
    ).toBe(0);
    let ir = read<EditorialIR>('ir.json');
    // Still the second camera's sound, which nobody unpaired.
    expect(ir.audio_companions.map((c) => c.asset_id)).toEqual([idOf(ir, 'C0002.MP4')]);
    expect(output.join('')).toMatch(/perception was reused/);

    writeFileSync(
      path,
      context.replace(
        'background:\n',
        'background:\n  recorders:\n' +
          '    - { recorder: ZOOM0001.WAV, video: C0001.MP4, paired: false }\n' +
          '    - { recorder: ZOOM0001.WAV, video: C0002.MP4, paired: false }\n',
      ),
    );
    expect(
      await main(['analyze', '--project', project, '--perception', 'local', '--offline-minimal']),
    ).toBe(0);
    ir = read<EditorialIR>('ir.json');
    expect(ir.audio_companions).toEqual([]);
    // The recorder is its own material again.
    const recorder = idOf(ir, 'ZOOM0001.WAV');
    expect(ir.events.some((e) => e.source_ranges.some((r) => r.asset_id === recorder))).toBe(true);
    writeFileSync(path, context);
  }, 120_000);
});
