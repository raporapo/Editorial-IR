#!/usr/bin/env node
/**
 * Measure how the scene detector behaves on footage, without the footage
 * going anywhere.
 *
 * The threshold that decides where shots begin is the one number in this
 * project that cannot be calibrated on synthetic material. Colour fields with
 * added grain are adversarial for a content metric in ways real footage is not,
 * and a default tuned on them would trade a measurable problem for an
 * unmeasurable one. What settles it is the score distribution of real footage —
 * which is a few dozen numbers, not the video.
 *
 * So this runs where the footage already is and prints only arithmetic. No
 * frames, no transcript, no OCR, no descriptions, no file contents. Filenames
 * are replaced with `clip_01` unless you ask for them. Read the code: every
 * line that reaches stdout is in `report()` at the bottom.
 *
 *   node scripts/scene-report.mjs ./my-footage
 *   node scripts/scene-report.mjs ./my-footage --continuous
 *   node scripts/scene-report.mjs a.mp4 --cuts-at 12.0,45.5,98.2
 *   node scripts/scene-report.mjs ./my-footage --names
 *   node scripts/scene-report.mjs a.mp4 --candidates 25
 *
 * `--continuous` says these clips are unedited camera takes, so every boundary
 * found inside one is a false positive. That needs no annotation from you and
 * is the single most useful thing to measure.
 *
 * `--cuts-at` gives the true cut times of one edited clip in seconds, so recall
 * can be measured too.
 *
 * `--candidates N` lists the N highest-scoring moments as timestamps, so the
 * question "which of these are real cuts?" can be answered by reading a short
 * list rather than by typing every cut time from scratch. Timestamps and scores
 * only — still nothing from the picture or the sound.
 *
 * Needs only ffmpeg. Paste the output back; it is a few hundred bytes.
 */
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const VIDEO = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.avi', '.webm', '.mts', '.m2ts']);

// The thresholds worth comparing: the old default, the current one, and the
// range either side of it. These are the project's own numbers, scaled the way
// `detect_shots` scales them for ffmpeg.
const FFMPEG_SCALE = 1 / 3;
const CANDIDATES = [0.05, 0.1, 0.15, 0.2, 0.3, 0.45];
const CURRENT = 0.15;
const PREVIOUS = 0.3;
// Matches the detector's own floor, so a burst of boundaries one frame apart
// counts once here exactly as it would there.
const MIN_SHOT_MS = 800;

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', () => resolve({ code: 127, out: '', err: '' }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function durationSeconds(file) {
  const { out } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  return Number.parseFloat(out.trim()) || 0;
}

/**
 * Every frame whose scene score clears a low floor, with its score.
 *
 * One decode pass. The floor is well under any candidate threshold, so the same
 * pass answers for all of them — and it keeps the output bounded on footage
 * where every frame differs slightly from the last.
 */
async function sceneScores(file) {
  const { err } = await run('ffmpeg', [
    '-hide_banner',
    '-v',
    'info',
    '-nostdin',
    '-i',
    file,
    '-filter:v',
    `select='gt(scene,0.01)',metadata=print:key=lavfi.scene_score`,
    '-an',
    '-f',
    'null',
    '-',
  ]);
  const hits = [];
  let pending;
  for (const line of err.split('\n')) {
    const time = /pts_time:([0-9.]+)/.exec(line);
    if (time) pending = Number.parseFloat(time[1]);
    const score = /lavfi\.scene_score=([0-9.]+)/.exec(line);
    if (score && pending !== undefined) {
      hits.push({ seconds: pending, score: Number.parseFloat(score[1]) });
      pending = undefined;
    }
  }
  return hits;
}

/** Boundaries a threshold would produce, after the detector's minimum shot length. */
function boundariesAt(hits, sensitivity) {
  const cutoff = sensitivity * FFMPEG_SCALE;
  const kept = [];
  for (const hit of hits) {
    if (hit.score <= cutoff) continue;
    const last = kept[kept.length - 1];
    if (last !== undefined && (hit.seconds - last) * 1000 < MIN_SHOT_MS) continue;
    kept.push(hit.seconds);
  }
  return kept;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

/** How close each found boundary is to a cut you said was there. */
function score(found, truth, toleranceS = 1.0) {
  if (truth === undefined) return undefined;
  const matched = new Set();
  let hit = 0;
  for (const cut of truth) {
    const near = found.findIndex((f, i) => !matched.has(i) && Math.abs(f - cut) <= toleranceS);
    if (near >= 0) {
      matched.add(near);
      hit++;
    }
  }
  return { found: found.length, truth: truth.length, hit, extra: found.length - hit };
}

function videosIn(path) {
  const info = statSync(path);
  if (!info.isDirectory()) return [path];
  return readdirSync(path)
    .filter((name) => VIDEO.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(path, name));
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const cutsArg = args.find((a) => a.startsWith('--cuts-at='));
  const cutsIndex = args.indexOf('--cuts-at');
  const rawCuts = cutsArg
    ? cutsArg.slice('--cuts-at='.length)
    : cutsIndex >= 0
      ? args[cutsIndex + 1]
      : undefined;
  const truth = rawCuts
    ? rawCuts
        .split(',')
        .map((v) => Number.parseFloat(v))
        .filter((v) => !Number.isNaN(v))
    : undefined;
  const continuous = flags.has('--continuous');
  const showNames = flags.has('--names');
  const candidatesArg = args.find((a) => a.startsWith('--candidates='));
  const candidatesIndex = args.indexOf('--candidates');
  const rawCandidates = candidatesArg
    ? candidatesArg.slice('--candidates='.length)
    : candidatesIndex >= 0
      ? args[candidatesIndex + 1]
      : undefined;
  const candidates = rawCandidates ? Number.parseInt(rawCandidates, 10) || 0 : 0;

  const targets = args.filter((a) => !a.startsWith('--') && a !== rawCuts && a !== rawCandidates);
  if (targets.length === 0) {
    console.error(
      'usage: node scripts/scene-report.mjs <file-or-directory> [--continuous] [--names] [--cuts-at 12.0,45.5]',
    );
    process.exit(2);
  }

  const probe = await run('ffprobe', ['-version']);
  if (probe.code !== 0) {
    console.error('ffmpeg/ffprobe not found on PATH. Install ffmpeg and run this again.');
    process.exit(2);
  }

  const files = targets.flatMap(videosIn);
  if (files.length === 0) {
    console.error('no video files found there');
    process.exit(2);
  }

  const rows = [];
  for (const [index, file] of files.entries()) {
    process.stderr.write(`reading ${index + 1}/${files.length}\r`);
    const seconds = await durationSeconds(file);
    const hits = await sceneScores(file);
    const counts = Object.fromEntries(CANDIDATES.map((c) => [c, boundariesAt(hits, c).length]));
    const scored =
      truth && files.length === 1 ? score(boundariesAt(hits, CURRENT), truth) : undefined;
    rows.push({
      label: showNames ? basename(file) : `clip_${String(index + 1).padStart(2, '0')}`,
      seconds,
      hits,
      counts,
      scored,
    });
  }
  process.stderr.write('        \r');
  report(rows, { continuous, truth, candidates });
}

/**
 * Everything that reaches stdout, in one place so it can be checked at a glance.
 *
 * Durations, counts and score percentiles. Nothing derived from the picture or
 * the sound beyond how much consecutive frames differ.
 */
function report(rows, { continuous, truth, candidates }) {
  const line = (s = '') => console.log(s);

  line('--- scene detector report -------------------------------------------');
  line(`clips: ${rows.length}   ffmpeg scene metric, min shot ${MIN_SHOT_MS}ms`);
  line();

  line('boundaries found, by sensitivity');
  line(
    ['clip'.padEnd(10), 'secs'.padStart(7), ...CANDIDATES.map((c) => String(c).padStart(7))].join(
      '',
    ),
  );
  for (const row of rows) {
    line(
      [
        row.label.padEnd(10),
        row.seconds.toFixed(0).padStart(7),
        ...CANDIDATES.map((c) => String(row.counts[c]).padStart(7)),
      ].join(''),
    );
  }
  line(
    `${' '.repeat(17)}${CANDIDATES.map((c) => (c === CURRENT ? 'now' : c === PREVIOUS ? 'old' : '').padStart(7)).join('')}`,
  );
  line();

  const all = rows.flatMap((r) => r.hits.map((h) => h.score)).sort((a, b) => a - b);
  if (all.length > 0) {
    line('score distribution across all clips (this is what sets the threshold)');
    line(
      `  n=${all.length}  p50=${percentile(all, 50).toFixed(3)}  p90=${percentile(all, 90).toFixed(3)}  ` +
        `p99=${percentile(all, 99).toFixed(3)}  max=${all[all.length - 1].toFixed(3)}`,
    );
    line();
  }

  if (continuous) {
    line('these were declared unedited takes, so every boundary is a false positive');
    for (const c of CANDIDATES) {
      const total = rows.reduce((sum, r) => sum + r.counts[c], 0);
      const perMinute = total / (rows.reduce((s, r) => s + r.seconds, 0) / 60 || 1);
      line(
        `  sensitivity ${String(c).padEnd(5)} ${String(total).padStart(5)} false boundaries  ` +
          `(${perMinute.toFixed(1)} per minute)`,
      );
    }
    line();
  }

  if (truth && rows.length === 1 && rows[0].scored) {
    const s = rows[0].scored;
    line(`against ${s.truth} cut(s) you gave, at the current sensitivity ${CURRENT}`);
    line(`  matched ${s.hit}/${s.truth} within 1.0s, with ${s.extra} extra`);
    line();
  }

  if (candidates > 0) {
    line(`the ${candidates} highest-scoring moments, so you can say which are real cuts`);
    line(`  (mark each R for a real cut or F for not one, and send the line back)`);
    for (const row of rows) {
      const top = [...row.hits].sort((a, b) => b.score - a.score).slice(0, candidates);
      top.sort((a, b) => a.seconds - b.seconds);
      line(`  ${row.label}:`);
      for (const hit of top) {
        const m = Math.floor(hit.seconds / 60);
        const sec = (hit.seconds % 60).toFixed(1).padStart(4, '0');
        line(`    ${String(m).padStart(3)}:${sec}   ${hit.score.toFixed(3)}   [ ]`);
      }
    }
    line();
  }

  line('nothing above is derived from the picture or the sound.');
  line('---------------------------------------------------------------------');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
