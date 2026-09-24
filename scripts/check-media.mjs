#!/usr/bin/env node
/**
 * The media layer, on media.
 *
 * `probe`, `prepare`, `detect_shots` and `analyze_audio` are the floor every
 * later stage stands on, and none of them had ever run in CI against a video.
 * The worked example cannot cover them and was never meant to: the files under
 * `examples/anniversary-trip/footage/` are ASCII placeholders that
 * `scripts/make-example.mjs` writes, which is what makes the compiler testable
 * with no ffmpeg — and is why it cannot see an ffmpeg invocation break. The
 * Python unit tests reach the pure functions on either side of the subprocess
 * (`build_shots`, `_parse_showinfo`, `silence_threshold`, `percentile`) and
 * never the subprocess itself, so `_hop_statistics` had never opened a WAV and
 * the `scale=-2:480` in `prepare` had never been run.
 *
 * So: synthesise footage whose answers are known by construction, drive the
 * real worker over the real JSON Lines protocol, and check that the cuts and
 * the quiet come back where they actually are.
 *
 *   node scripts/check-media.mjs          # synthesise, run, assert, clean up
 *   node scripts/check-media.mjs --keep   # leave the clips and derivatives
 *
 * Needs ffmpeg and python3 and nothing else: no models, no network, no
 * `pnpm install`. It speaks to the worker directly rather than through
 * `PythonWorkerClient`, so that a failure here points at the worker and not at
 * a transport that has its own tests.
 *
 * ## Everything expected below was measured by running it
 *
 * ffmpeg 6.1.1, Python 3.11.15, no PySceneDetect installed, so the
 * `ffmpeg-scene` path. Nothing here is a prediction:
 *
 *   probe          6000ms, 640x360, 30/1, h264 + aac 48000 mono
 *                  and 3003ms at 30000/1001 for the second clip
 *   detect_shots   0-2000, 2000-4000, 4000-6000 — the splice times exactly
 *   prepare        proxy 854x480, audio 16000Hz mono 16-bit, 6 frames at 1fps
 *   analyze_audio  silence 0-2000, speech 2000-4000, silence 4000-6100
 *   two tracks     a:0 stereo room tone 0 of 61 hops speech, median -44.19dB;
 *                  a:1 mono bursts 30 of 61, median -70.16dB — so the median
 *                  alone would have picked the room; "most speech of 2
 *                  (0.49 vs 0.00)"
 *   vfr            30/1 nominal, 70/3 average, 140 frames; proxy 180 at 30/1
 *   album art      mjpeg 300x300 at 90000/1, attached_pic: no picture
 *   matroska       30/1, 90 packets; the picture's DURATION tag 3.000s, the
 *                  file 4.021s
 *
 * Two of those need explaining.
 *
 * The proxy is 854 wide, not 853. 640x360 scaled to 480 high is 853.33, and
 * libx264 refuses an odd dimension — which is what the `-2` in the scale filter
 * is for, and why the source is 640x360 rather than a ratio that divides evenly.
 *
 * And the last silence ends at 6100 in a 6000ms video. The extracted WAV is
 * 6016ms long, because AAC is encoded in overlapping blocks and the encoder pads
 * the tail to fill the last one. Anything downstream that clamps event times to
 * the probed duration is right to.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const WORKER_SRC = fileURLToPath(new URL('../services/perception/src', import.meta.url));
const KEEP = process.argv.includes('--keep');

/**
 * A run that hangs is worse than a run that fails: the worker's protocol loop
 * blocks on stdin, so a reply that never comes is a job that sits there for six
 * hours and then reports nothing.
 */
const REQUEST_TIMEOUT_MS = 60_000;

const DURATION_MS = 6000;
const STRONG_CUT_MS = 2000;
const WEAK_CUT_MS = 4000;
const TONE_MS = [2000, 4000];

/**
 * The two sensitivities that bracket the weak cut, which is the only way to see
 * the scaling from outside the worker.
 *
 * `threshold` in the request is a *sensitivity* in [0,1], and `FFMPEG_SCALE`
 * turns it into the raw cutoff ffmpeg's `scene` metric is measured against. The
 * two are not the same number and used not to be distinguished: the sensitivity
 * reached ffmpeg unscaled, so 0.3 meant a raw cutoff of 0.3 — above every real
 * cut — and twelve minutes of footage with thirteen hard cuts came back as one
 * shot per file. Scaling fixed it. Nothing has checked the scaling since.
 *
 * Measured scores of the two splices in `cuts.mp4`: 0.6886 at 2.000s, 0.2100 at
 * 4.000s. Against the raw cutoffs these sensitivities produce — 0.3/3 = 0.100
 * and 0.9/3 = 0.300 — the weak cut falls on opposite sides:
 *
 *   sensitivity 0.3 -> cutoff 0.100 -> both splices    -> 3 shots
 *   sensitivity 0.9 -> cutoff 0.300 -> the strong only -> 2 shots
 *
 * A scale of 1 (the old bug) makes the first find 2; a scale well below 1/3
 * makes the second find 3. Both were run. Margins are 2.1x, 1.4x and 2.3x, wide
 * enough that an ffmpeg upgrade moving a score by a few percent does not move an
 * answer.
 */
const DEFAULT_SENSITIVITY = 0.3;
const COARSE_SENSITIVITY = 0.9;

let failures = 0;
function check(what, ok, detail) {
  if (ok) {
    console.log(`  ok    ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function near(actual, expected, tolerance) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const why = result.stderr || result.error?.message || '';
    throw new Error(`${command} failed (${result.status}): ${why.slice(-2000)}`);
  }
  return result.stdout;
}

/**
 * ffmpeg arguments read as a command or they do not read at all, and one array
 * element per token turns a filter graph into sixty lines. Nothing here goes
 * through a shell — `spawnSync` takes the array — and no argument in these two
 * commands contains a space, so the split is a formatting device and not a
 * parser. The file paths are appended as elements and never go through it.
 */
function words(template) {
  return template.trim().split(/\s+/);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- the footage

/**
 * Three static patterns spliced end to end, so the cuts are at 2.000s and
 * 4.000s by construction rather than by anyone's judgement of where a scene
 * changes. Static matters: a moving source scores against itself, and the
 * question stops being "did it find the cut" and becomes "did it find the cut
 * and nothing else".
 *
 * The third segment is the second one with a black band across the top eighty
 * pixels, and that is what makes the second cut weak. A cut that changes the
 * whole frame is found by any cutoff at all and so measures nothing; a partial
 * change is what a cut between two angles on one scene looks like. `media.py`
 * names recall on weak cuts as the side of the threshold nobody has measured.
 * This is a synthetic data point, so it bounds the scaling rather than the
 * default — the default was calibrated on real footage and stays that way.
 *
 * The audio is room tone, tone, room tone, and the room tone is deliberately
 * loud: -32dB, well above the -40dB the request defaults to calling silence.
 * Digital silence would have been easier and would have tested nothing, because
 * a fixed threshold and an adaptive one agree on a signal that is exactly zero.
 * They disagree here, which is the case `silence_threshold` exists for: a quiet
 * indoor recording never reaches a fixed threshold and reads as silent
 * throughout, and a windy street never drops below it and reads as continuous
 * sound. Real recordings never contain digital silence anyway.
 *
 * The bitexact flags drop the encoder version out of the container, so the file
 * is the same bytes on every run of the same ffmpeg. The digest is printed
 * rather than asserted: pinning it would turn an ffmpeg upgrade on the runner
 * into a failure of the media layer, which is not what this job is for.
 */
function synthesise(dir) {
  const cuts = join(dir, 'cuts.mp4');
  const still = join(dir, 'still.mp4');

  run('ffmpeg', [
    ...words(`
      -hide_banner -loglevel error -y
      -fflags +bitexact -flags:v +bitexact -flags:a +bitexact
      -f lavfi -i rgbtestsrc=size=640x360:rate=30:duration=2,format=yuv420p
      -f lavfi -i smptebars=size=640x360:rate=30:duration=2,format=yuv420p
      -f lavfi -i smptebars=size=640x360:rate=30:duration=2,drawbox=x=0:y=0:w=640:h=80:color=black@1:t=fill,format=yuv420p
      -f lavfi -i anoisesrc=color=pink:seed=7:amplitude=0.13:sample_rate=48000:duration=2
      -f lavfi -i sine=frequency=440:sample_rate=48000:duration=2,volume=2.5
      -f lavfi -i anoisesrc=color=pink:seed=11:amplitude=0.13:sample_rate=48000:duration=2
      -filter_complex [0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]
      -map [v] -map [a]
      -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -g 30
      -c:a aac -b:a 96k -ar 48000 -ac 1
      -movflags +faststart
    `),
    cuts,
  ]);

  // The other half of the shot question, and two things the first clip cannot
  // say. It carries no audio track, which is a phone clip with the mic muted
  // and has to survive probe; and it runs at 30000/1001, which is what every
  // North American camera produces and what makes the frame rate two integers
  // instead of a float.
  //
  // A take with no cuts in it must come back as one shot — not zero, which is
  // what PySceneDetect returns for a continuous file, and which cost a
  // continuous take its shots entirely depending on which backend happened to
  // be installed.
  //
  // It does not measure the false-positive side, and nothing synthetic can:
  // `media.py` records that colour fields are adversarial for a content metric
  // in ways real footage is not, which is why the threshold was calibrated with
  // `scripts/scene-report.mjs` over 62 minutes of real camera footage instead.
  run('ffmpeg', [
    ...words(`
      -hide_banner -loglevel error -y
      -fflags +bitexact -flags:v +bitexact
      -f lavfi -i smptebars=size=640x360:rate=30000/1001:duration=3,format=yuv420p
      -map 0:v
      -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -g 30
      -movflags +faststart
    `),
    still,
  ]);

  // A camera with a lavalier on its second track. The first is stereo room
  // tone — steady pink noise, no dynamic range, so the energy analysis finds no
  // speech in it by construction — and the second is mono tone bursts, a second
  // on and a second off. ffmpeg's own default is the stream with the most
  // channels, which is the room: that is what was transcribed before streams
  // were chosen, and five spoken sentences came back as none.
  const tracks = join(dir, 'tracks.mp4');
  run('ffmpeg', [
    ...words(`
      -hide_banner -loglevel error -y
      -fflags +bitexact -flags:v +bitexact -flags:a +bitexact
      -f lavfi -i smptebars=size=640x360:rate=30:duration=6,format=yuv420p
      -f lavfi -i anoisesrc=color=pink:seed=3:amplitude=0.05:sample_rate=48000:duration=6
      -f lavfi -i aevalsrc='0.4*sin(2*PI*440*t)*lt(mod(t,2),1)':s=48000:d=6
      -filter_complex [1:a]aformat=channel_layouts=stereo[room];[2:a]aformat=channel_layouts=mono[lav]
      -map 0:v -map [room] -map [lav]
      -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -g 30
      -c:a aac -b:a 96k -ar 48000
      -movflags +faststart
    `),
    tracks,
  ]);

  // A phone clip that dropped frames: 30 fps nominal, every third frame kept
  // between 2 s and 4 s, written variable-rate. Measured: 140 frames in 6 s,
  // `avg_frame_rate` 70/3. The average was the asset's rate and so the
  // sequence's, and nothing said the file was variable at all.
  const vfr = join(dir, 'vfr.mp4');
  run('ffmpeg', [
    ...words(`
      -hide_banner -loglevel error -y
      -fflags +bitexact -flags:v +bitexact
      -f lavfi -i testsrc2=size=640x360:rate=30:duration=6
      -vf select='if(between(t,2,4),not(mod(n,3)),1)',format=yuv420p
      -fps_mode vfr
      -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -g 30
      -movflags +faststart
    `),
    vfr,
  ]);

  // Sound with album art: the art is a one-frame video stream marked
  // `attached_pic`, declaring 90000/1, and it was read as the picture.
  const cover = join(dir, 'cover.m4a');
  run('ffmpeg', [
    ...words(`
      -hide_banner -loglevel error -y
      -fflags +bitexact -flags:v +bitexact -flags:a +bitexact
      -f lavfi -i sine=frequency=330:sample_rate=48000:duration=2
      -f lavfi -i smptebars=size=300x300:rate=1:duration=1,format=yuvj420p
      -map 0:a -map 1:v
      -c:a aac -b:a 64k -c:v mjpeg -frames:v 1 -disposition:v:0 attached_pic
    `),
    cover,
  ]);

  // A constant 30 fps recording in Matroska whose sound runs a second past its
  // picture, as a screen recorder that stops the picture first writes it.
  // Matroska keeps no frame count, so the packets are counted — and they were
  // counted over the file's length rather than the picture's — measured, 90
  // packets over 4.021 s, 22.4 fps and "variable" for a file with not one
  // irregular frame in it.
  const screen = join(dir, 'screen.mkv');
  run('ffmpeg', [
    ...words(`
      -hide_banner -loglevel error -y
      -fflags +bitexact -flags:v +bitexact -flags:a +bitexact
      -f lavfi -i testsrc2=size=640x360:rate=30:duration=3,format=yuv420p
      -f lavfi -i sine=frequency=440:sample_rate=48000:duration=4
      -map 0:v -map 1:a
      -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -g 30
      -c:a aac -b:a 64k
    `),
    screen,
  ]);

  for (const path of [cuts, still, tracks, vfr, cover, screen]) {
    console.log(`  ${basename(path)}  sha256:${sha256(path)}`);
  }
  return { cuts, still, tracks, vfr, cover, screen };
}

// ----------------------------------------------------------------- the worker

/**
 * One request and one reply per line, correlated by id, logs on stderr.
 * Progress events share the reply stream and are told apart by having no `ok`.
 */
class Worker {
  constructor(python) {
    this.pending = new Map();
    this.counter = 0;
    this.child = spawn(python, ['-m', 'editorial_perception'], {
      env: { ...process.env, PYTHONPATH: WORKER_SRC },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`the worker exited (${code}) with ${pending.op} outstanding`));
      }
      this.pending.clear();
    });
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // stdout is the protocol. Anything else on it is a bug in the worker
      // rather than a log: a dependency printing a progress bar here would
      // leave every request pending until the timeout.
      check('writes only protocol on stdout', false, line.slice(0, 200));
      return;
    }
    if (message.event === 'progress') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok !== true) {
      pending.reject(
        new Error(`${pending.op}: ${message.error?.code} — ${message.error?.message}`),
      );
    } else if (message.op !== pending.op) {
      pending.reject(new Error(`asked about ${pending.op}, answered about ${message.op}`));
    } else {
      pending.resolve(message.result);
    }
  }

  request(op, params) {
    const id = String(++this.counter);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${op} did not answer within ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, { resolve, reject, op, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  async stop() {
    await this.request('shutdown', {}).catch(() => {});
    this.child.stdin.end();
  }
}

/**
 * JSON has no undefined, so the worker drops keys rather than sending nulls: a
 * field that means "there is no value here" must not arrive looking like one
 * that has a value. No optional field is absent in the results these five
 * requests produce, so this guards against the first null appearing rather than
 * against `_without_nulls` breaking — which is why it is one sweep at the end
 * and not a line per op.
 */
function nullsIn(value, path = '') {
  if (value === null) return [path || '(root)'];
  if (Array.isArray(value)) return value.flatMap((item, i) => nullsIn(item, `${path}[${i}]`));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => nullsIn(v, path ? `${path}.${k}` : k));
  }
  return [];
}

function wavFormat(path) {
  const bytes = readFileSync(path);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      return {
        channels: bytes.readUInt16LE(offset + 10),
        sampleRate: bytes.readUInt32LE(offset + 12),
        bitsPerSample: bytes.readUInt16LE(offset + 22),
      };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no fmt chunk`);
}

function streams(path) {
  const probed = JSON.parse(
    run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', path]),
  );
  return {
    video: probed.streams.find((stream) => stream.codec_type === 'video'),
    audioCount: probed.streams.filter((stream) => stream.codec_type === 'audio').length,
  };
}

// ----------------------------------------------------------------- the checks

async function main() {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    if (spawnSync(tool, ['-version'], { stdio: 'ignore' }).status !== 0) {
      // Deliberately not the skip `check-python.mjs` does. That one lets a
      // contributor work on TypeScript without a Python toolchain; this is the
      // only place ffmpeg runs at all, and a quiet skip would reopen the hole
      // the job was written to close.
      console.error(`${tool} is not installed, and this check is about ffmpeg`);
      process.exit(1);
    }
  }
  const python = ['python3', 'python'].find(
    (name) => spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0,
  );
  if (!python) {
    console.error('no python3, and this check drives the Python worker');
    process.exit(1);
  }

  const dir = join(tmpdir(), `oea-media-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  let worker;

  try {
    console.log('synthesising');
    const { cuts, still, tracks, vfr, cover, screen } = synthesise(dir);
    worker = new Worker(python);

    console.log('probe');
    const probed = await worker.request('probe', { path: cuts });
    check(
      'reads the duration off the container',
      probed.duration_ms === DURATION_MS,
      probed.duration_ms,
    );
    check(
      'reads the frame size',
      probed.width === 640 && probed.height === 360,
      `${probed.width}x${probed.height}`,
    );
    check(
      'reads the frame rate',
      probed.fps_num === 30 && probed.fps_den === 1,
      `${probed.fps_num}/${probed.fps_den}`,
    );
    check(
      'names both codecs',
      probed.video_codec === 'h264' && probed.audio_codec === 'aac',
      `${probed.video_codec}/${probed.audio_codec}`,
    );
    check(
      'reads the audio layout',
      probed.audio_channels === 1 && probed.audio_sample_rate === 48_000,
      `${probed.audio_channels}ch ${probed.audio_sample_rate}Hz`,
    );
    check(
      'names the container',
      typeof probed.container === 'string' && probed.container.includes('mp4'),
      probed.container,
    );

    // A muted phone clip. The audio fields must be missing rather than zero: a
    // recording with no sound and a recording whose sound was not read are
    // different things, and only one of them is worth going back for.
    const silentFile = await worker.request('probe', { path: still });
    check(
      'leaves the audio fields out for a file with no audio',
      !('audio_codec' in silentFile) &&
        !('audio_channels' in silentFile) &&
        !('audio_sample_rate' in silentFile),
      JSON.stringify(silentFile),
    );
    check(
      'still reads the video side of it',
      silentFile.duration_ms === 3003 && silentFile.width === 640,
      JSON.stringify(silentFile),
    );
    // 30000/1001, not 30. Flattening it to a float loses a frame every
    // thousand and a half, which is a second and a half over an hour of
    // footage and every timecode in the cut wrong by the end of it.
    check(
      'keeps an NTSC frame rate rational',
      silentFile.fps_num === 30_000 && silentFile.fps_den === 1001,
      `${silentFile.fps_num}/${silentFile.fps_den}`,
    );

    console.log('detect_shots');
    const detected = await worker.request('detect_shots', {
      path: cuts,
      threshold: DEFAULT_SENSITIVITY,
    });
    const shots = detected.shots ?? [];
    check(
      'finds both splices and nothing else',
      shots.length === 3,
      `${shots.length}: ${JSON.stringify(shots)}`,
    );
    if (shots.length === 3) {
      check(
        'puts the strong cut at 2.000s',
        near(shots[1].start_ms, STRONG_CUT_MS, 100),
        shots[1].start_ms,
      );
      check(
        'puts the weak cut at 4.000s',
        near(shots[2].start_ms, WEAK_CUT_MS, 100),
        shots[2].start_ms,
      );
    }
    check('starts at the start', shots[0]?.start_ms === 0, shots[0]?.start_ms);
    check(
      'runs to the end of the file',
      near(shots.at(-1)?.end_ms, DURATION_MS, 100),
      shots.at(-1)?.end_ms,
    );
    check(
      'leaves no gap between one shot and the next',
      shots.length > 0 &&
        shots.every((shot, i) => i === 0 || shot.start_ms === shots[i - 1].end_ms),
      JSON.stringify(shots.map((shot) => [shot.start_ms, shot.end_ms])),
    );
    // A third of the way in: past the transition, before the camera moves on.
    // Frame extraction and every visual stage read this, so a representative
    // frame that drifted to the boundary would sample the cut itself.
    check(
      'samples each shot a third of the way in',
      shots.every(
        (shot) =>
          shot.representative_frame_ms ===
          shot.start_ms + Math.floor((shot.end_ms - shot.start_ms) / 3),
      ),
      JSON.stringify(shots.map((shot) => shot.representative_frame_ms)),
    );

    const coarse = await worker.request('detect_shots', {
      path: cuts,
      threshold: COARSE_SENSITIVITY,
    });
    check(
      'treats the threshold as a sensitivity rather than a raw score',
      coarse.shots?.length === 2,
      `${coarse.shots?.length} shots at sensitivity ${COARSE_SENSITIVITY}, where the weak cut should fall below the cutoff`,
    );

    const continuous = await worker.request('detect_shots', { path: still });
    check(
      'calls an uncut take one shot, not none',
      continuous.shots?.length === 1,
      JSON.stringify(continuous.shots),
    );
    check(
      'gives that one shot the whole file',
      near(continuous.shots?.[0]?.end_ms, 3003, 100),
      continuous.shots?.[0]?.end_ms,
    );

    console.log('prepare');
    const prepared = await worker.request('prepare', { path: cuts, work_dir: join(dir, 'work') });

    // Every audio stage reads this file and none of them resamples: the ASR
    // backend assumes 16kHz, and `_hop_statistics` raises on anything that is
    // not 16-bit.
    const wav = wavFormat(prepared.audio_path);
    check(
      'extracts 16kHz mono 16-bit audio',
      wav.sampleRate === 16_000 && wav.channels === 1 && wav.bitsPerSample === 16,
      `${wav.sampleRate}Hz ${wav.channels}ch ${wav.bitsPerSample}-bit`,
    );

    const proxy = streams(prepared.proxy_path);
    check(
      'scales the proxy to the height it was asked for',
      proxy.video?.height === 480,
      proxy.video?.height,
    );
    check(
      'rounds the proxy width to something h264 accepts',
      proxy.video?.width % 2 === 0,
      proxy.video?.width,
    );
    check('leaves the audio out of the proxy', proxy.audioCount === 0, proxy.audioCount);

    const frames = readdirSync(prepared.frames_dir)
      .filter((name) => name.endsWith('.jpg'))
      .sort();
    check('extracts one frame a second', frames.length === 6, frames.length);
    check(
      'timestamps the frames it actually wrote',
      JSON.stringify(prepared.frame_timestamps_ms) ===
        JSON.stringify([0, 1000, 2000, 3000, 4000, 5000]),
      JSON.stringify(prepared.frame_timestamps_ms),
    );
    // One frame from each spliced segment, at 0s, 2s and 4s. Equal digests
    // would mean the fps filter wrote one picture six times, or wrote six
    // pictures from the wrong instants, and every visual stage would then be
    // describing a video that does not exist.
    const digests = frames.map((name) => sha256(join(prepared.frames_dir, name)));
    check(
      'takes each frame from where it says it did',
      new Set([digests[0], digests[2], digests[4]]).size === 3,
      digests.join(' '),
    );
    // Source resolution, not proxy resolution. OCR reports boxes in the pixels
    // of the frame it was handed, and a box in the wrong pixel grid is not
    // wrong by a little.
    const frame = streams(join(prepared.frames_dir, frames[0]));
    check(
      'writes frames at the source resolution',
      frame.video?.width === 640 && frame.video?.height === 360,
      `${frame.video?.width}x${frame.video?.height}`,
    );

    console.log('analyze_audio');
    const audio = await worker.request('analyze_audio', { audio_path: prepared.audio_path });
    check('echoes the hop it measured at', audio.hop_ms === 100, audio.hop_ms);
    // 61 hops for a 6016ms WAV: sixty whole ones and the remainder, which the
    // reader keeps rather than discards.
    check(
      'measures a hop per 100ms of audio',
      near(audio.rms_db?.length, 61, 1),
      audio.rms_db?.length,
    );
    check(
      'measures one speech probability per hop',
      audio.speech_prob?.length === audio.rms_db?.length,
      `${audio.speech_prob?.length} against ${audio.rms_db?.length}`,
    );

    // Measured: the room tone sits between -34.5 and -30.5dB and the tone at
    // -13.1. The upper bound on the quiet hops is the assertion that matters —
    // it is what makes the silences below a finding rather than a tautology,
    // because -32dB is louder than the -40dB the request nominally calls
    // silence.
    const quiet = audio.rms_db.slice(2, 18);
    const loud = audio.rms_db.slice(22, 38);
    check(
      'hears room tone in the quiet, not digital silence',
      quiet.every((db) => db > -40 && db < -25),
      `${Math.min(...quiet)}dB to ${Math.max(...quiet)}dB`,
    );
    check(
      'hears the tone',
      loud.every((db) => db > -20),
      `quietest hop ${Math.min(...loud)}dB`,
    );

    const silences = (audio.events ?? []).filter((event) => event.event_type === 'silence');
    check(
      'finds the quiet where a fixed -40dB threshold would find none',
      silences.length === 2,
      JSON.stringify(silences),
    );
    if (silences.length === 2) {
      check(
        'starts the first silence at the start of the file',
        silences[0].start_ms === 0,
        silences[0].start_ms,
      );
      check(
        'ends the first silence where the tone begins',
        near(silences[0].end_ms, TONE_MS[0], 150),
        silences[0].end_ms,
      );
      check(
        'starts the second silence where the tone ends',
        near(silences[1].start_ms, TONE_MS[1], 150),
        silences[1].start_ms,
      );
      check(
        'runs the second silence to the end of the audio',
        near(silences[1].end_ms, 6100, 150),
        silences[1].end_ms,
      );
    }
    check(
      'puts no silence inside the tone',
      silences.every(
        (event) => event.end_ms <= TONE_MS[0] + 150 || event.start_ms >= TONE_MS[1] - 150,
      ),
      JSON.stringify(silences),
    );

    // A 440Hz tone crosses zero 0.055 times per sample at 16kHz, inside the
    // [0.01, 0.3] band the detector reads as voiced, so it comes back as speech
    // at confidence 0.5. That is a statement about the detector rather than
    // about the tone, and it is the part worth pinning: narrowing the band would
    // cost unvoiced stretches of real speech in exactly the same way, silently.
    const speech = (audio.events ?? []).filter((event) => event.event_type === 'speech');
    check('finds the loud stretch as a single run', speech.length === 1, JSON.stringify(speech));
    if (speech.length === 1) {
      check(
        'puts the loud stretch where the tone is',
        near(speech[0].start_ms, TONE_MS[0], 150) && near(speech[0].end_ms, TONE_MS[1], 150),
        `${speech[0].start_ms}-${speech[0].end_ms}`,
      );
    }

    console.log('streams, rates and silence');
    const trackProbe = await worker.request('probe', { path: tracks });
    check(
      'lists every audio stream, by its place among the audio streams',
      JSON.stringify(trackProbe.audio_streams?.map((s) => [s.index, s.channels])) ===
        JSON.stringify([
          [0, 2],
          [1, 1],
        ]),
      JSON.stringify(trackProbe.audio_streams),
    );
    // Generic handler names are what the muxer writes when nobody named a track;
    // reported as titles, both tracks were called "SoundHandler".
    check(
      'does not call an unnamed track "SoundHandler"',
      (trackProbe.audio_streams ?? []).every((s) => s.title === undefined),
      JSON.stringify(trackProbe.audio_streams),
    );
    const trackWork = join(dir, 'tracks-work');
    const chosen = await worker.request('prepare', { path: tracks, work_dir: trackWork });
    check(
      'listens to the stream with the speech, not the one with more channels',
      chosen.audio_stream_index === 1 && basename(chosen.audio_path ?? '') === 'audio-a1.wav',
      `${chosen.audio_stream_index} ${chosen.audio_path}`,
    );
    check(
      'says why, with the numbers',
      /^most speech of 2 \(0\.\d\d vs 0\.00\)$/.test(chosen.audio_stream_reason ?? ''),
      chosen.audio_stream_reason,
    );
    check(
      'names every extracted stream after itself',
      existsSync(join(trackWork, 'audio-a0.wav')) && existsSync(join(trackWork, 'audio-a1.wav')),
      readdirSync(trackWork).join(' '),
    );
    const asked = await worker.request('prepare', {
      path: tracks,
      work_dir: trackWork,
      audio_stream_index: 0,
    });
    check(
      'takes the stream it is asked for',
      asked.audio_stream_index === 0 && asked.audio_stream_reason === 'asked for',
      JSON.stringify(asked),
    );

    const vfrProbe = await worker.request('probe', { path: vfr });
    check(
      'gives a phone clip the rate it was set to',
      vfrProbe.fps_num === 30 && vfrProbe.fps_den === 1,
      `${vfrProbe.fps_num}/${vfrProbe.fps_den}`,
    );
    check(
      'keeps the measured average beside it, and says the rate varies',
      vfrProbe.avg_fps_num === 70 &&
        vfrProbe.avg_fps_den === 3 &&
        vfrProbe.variable_frame_rate === true,
      JSON.stringify(vfrProbe),
    );
    check('does not call a constant-rate file variable', probed.variable_frame_rate === false);
    const screenProbe = await worker.request('probe', { path: screen });
    check(
      'counts a Matroska picture over its own length, not the sound that outlasts it',
      screenProbe.fps_num === 30 &&
        screenProbe.fps_den === 1 &&
        screenProbe.variable_frame_rate === false,
      JSON.stringify(screenProbe),
    );
    const vfrPrepared = await worker.request('prepare', {
      path: vfr,
      work_dir: join(dir, 'vfr-work'),
      extract_audio: false,
      frame_fps: 0,
    });
    const vfrProxy = JSON.parse(
      run('ffprobe', [
        ...words('-v error -select_streams v:0 -show_entries'),
        'stream=r_frame_rate,avg_frame_rate,nb_frames',
        ...words('-print_format json'),
        vfrPrepared.proxy_path,
      ]),
    ).streams[0];
    // 180 frames at 30/1 for 6 s: the dropped ones repeated, so the frame at a
    // time is the same frame in every tool that decodes the proxy.
    check(
      'makes the proxy constant-rate at the nominal rate, on purpose',
      basename(vfrPrepared.proxy_path) === 'proxy-480p-cfr30.mp4' &&
        vfrProxy.r_frame_rate === '30/1' &&
        vfrProxy.avg_frame_rate === '30/1' &&
        vfrProxy.nb_frames === '180',
      JSON.stringify(vfrProxy),
    );

    const coverProbe = await worker.request('probe', { path: cover });
    check(
      'does not take album art for the picture',
      coverProbe.width === undefined &&
        coverProbe.video_codec === undefined &&
        coverProbe.fps_num === undefined &&
        coverProbe.audio_codec === 'aac',
      JSON.stringify(coverProbe),
    );
    const coverPrepared = await worker.request('prepare', {
      path: cover,
      work_dir: join(dir, 'cover-work'),
      proxy_height: 480,
      frame_fps: 1,
    });
    check(
      'makes no proxy and no frames of album art',
      coverPrepared.proxy_path === undefined &&
        coverPrepared.frames_dir === undefined &&
        coverPrepared.audio_path !== undefined,
      JSON.stringify(coverPrepared),
    );

    // A video with no audio track: the audio step used to run first, fail, and
    // take the frames down with it.
    const silentPrepared = await worker.request('prepare', {
      path: still,
      work_dir: join(dir, 'still-work'),
    });
    check(
      'prepares a video with no audio track without a failure',
      silentPrepared.audio_stream_count === 0 &&
        silentPrepared.audio_path === undefined &&
        silentPrepared.failed === undefined,
      JSON.stringify(silentPrepared),
    );
    check(
      'still makes its frames',
      silentPrepared.frame_timestamps_ms?.length === 3,
      JSON.stringify(silentPrepared.frame_timestamps_ms),
    );

    const nulls = [
      probed,
      silentFile,
      detected,
      prepared,
      audio,
      trackProbe,
      chosen,
      vfrProbe,
      vfrPrepared,
      coverProbe,
      coverPrepared,
      silentPrepared,
    ].flatMap((result) => nullsIn(result));
    check('sends no nulls', nulls.length === 0, nulls.join(', '));

    await worker.stop();
  } finally {
    if (worker?.child.exitCode === null) worker.child.kill();
    if (KEEP) {
      console.log(`left in ${dir}`);
    } else if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failures > 0) {
    console.error(`\n${failures} failed, in ${seconds}s`);
    process.exit(1);
  }
  console.log(`\nthe media path holds, in ${seconds}s`);
}

await main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
