import { compileProject } from '@editorial-ir/core';
import {
  describeStandIn,
  formatTimecode,
  type AnalysisSavings,
  type AudioCompanion,
  type MaterialKind,
  type MaterialProfile,
  type MediaAsset,
} from '@editorial-ir/contracts';
import { resolveBackends } from '../backends.js';
import { openProject } from '../project.js';
import { Progress, colour, detail, formatCost, heading, note, success, warn } from '../ui.js';

export interface AnalyzeArgs {
  project?: string;
  perception?: string;
  decision?: string;
  force?: boolean;
  /** Analyse with rules and lexical hashing, and say so on the result. */
  offlineMinimal?: boolean;
  budget?: number;
  maxEscalations?: number;
  /** False asks the models about still, silent footage too: `--no-skip-inactive`. */
  skipInactive?: boolean;
}

export async function runAnalyze(args: AnalyzeArgs): Promise<number> {
  const store = openProject(args.project);

  // A project remembers how it was analysed. Re-analysing after adding a note
  // should use the perception it used the first time, not silently fall back to
  // whatever this machine happens to have: the user's only clue would be that
  // their project now has three events where it had seventy-three.
  const previous = store.readProject().perception;
  const perception = args.perception ?? previous;

  // And it remembers the tier it was analysed at, for the same reason.
  //
  // A project that already holds an offline_minimal IR was analysed that way on
  // purpose — there is no other way for one to exist, because the first run
  // would have refused. Making the user repeat the flag to add one annotation
  // and re-compile is friction with nothing behind it.
  //
  // Inheriting is safe because the mode only decides whether to *refuse*: a
  // model that has since been configured is still picked up, and the result is
  // stamped by what actually ran either way.
  const inherited = previousTier(store) === 'offline_minimal';
  const offlineMinimal = args.offlineMinimal === true || inherited;

  const backends = await resolveBackends({
    ...(perception ? { perception } : {}),
    ...(args.decision ? { decision: args.decision } : {}),
    ...(offlineMinimal ? { mode: 'offline-minimal' as const } : {}),
    onLog: (message) => warn(message),
  });
  if (inherited && args.offlineMinimal !== true && backends.missing.length > 0) {
    note('  carrying on without models, as this project was analysed before');
  }
  const progress = new Progress();

  heading('using');
  for (const item of backends.description) note(`  ${item}`);

  try {
    const result = await compileProject({
      store,
      suite: backends.suite,
      decision: backends.decision,
      ...(backends.escalationContext ? { escalationContext: backends.escalationContext } : {}),
      ...(backends.escalationDecision ? { escalationDecision: backends.escalationDecision } : {}),
      escalation: {
        ...(args.maxEscalations === undefined ? {} : { maxItems: args.maxEscalations }),
        ...(args.budget === undefined ? {} : { maxCostUsd: args.budget }),
        minValue: 0.5,
      },
      ...(args.budget === undefined ? {} : { budgetUsd: args.budget }),
      ...(args.force ? { forceObservations: true } : {}),
      ...(args.skipInactive === false ? { skipInactive: false } : {}),
      standInReason: backends.standInReason,
      onProgress: (stage, message, done, total) => progress.update(stage, message, done, total),
    });
    progress.clear();

    // The IR carries the project record as the compile read it, which is the
    // record from before this command: the perception it is about to store was
    // not in it yet. So the first analysis of a project said nothing about how
    // it was perceived, the second (same footage, same models) said `local` —
    // two different IRs from one input — and a re-analysis with another
    // perception was labelled with the previous one. The record written here
    // and the one inside the IR are the same record.
    const project = { ...result.ir.project, ...(perception ? { perception } : {}) };
    const ir = { ...result.ir, project };
    store.writeObservations(result.observations);
    store.writeIr(ir);
    store.writeEmbeddings(result.embeddings);
    store.writeProject(project);

    const { report } = result;
    success(`${ir.stats.event_count} events in ${ir.stats.chapter_count} chapters`);

    heading('the analysis');
    detail('material', formatTimecode(ir.stats.total_media_duration_ms, false));
    detail(
      'events',
      `${ir.stats.event_count}, averaging ${Math.round(ir.stats.mean_event_duration_ms / 1000)}s`,
    );
    detail('transcribed', `${ir.stats.utterance_count} utterances`);
    detail('shots', String(ir.stats.shot_count));
    detail('relations', String(ir.stats.relation_count));
    detail('took', `${Math.round(report.elapsedMs / 100) / 10}s`);
    detail('cost', formatCost(report.totalCostUsd));

    if (report.reusedObservations) {
      note('  perception was reused: nothing that affects it had changed');
    } else if (report.cacheHits > 0) {
      note(`  ${report.cacheHits} cached result(s) reused, ${report.cacheMisses} computed`);
    }

    if (report.escalatedContext.length > 0 || report.escalatedDecision.length > 0) {
      heading('looked at more closely');
      detail('described', String(report.escalatedContext.length));
      detail('re-judged', String(report.escalatedDecision.length));
      if (report.escalationLimitedBy !== 'nothing') {
        note(`  stopped by the ${report.escalationLimitedBy} limit`);
      }
    }

    // What the still, silent footage saved. Said with its measure — how much
    // footage and how many calls — because "skipped" alone reads like "missed".
    heading('still and silent');
    for (const [label, value] of stillAndSilentLines(report.inactive, ir.quality.savings)) {
      if (label === '') note(`  ${value}`);
      else detail(label, value);
    }

    // Said plainly, and said here rather than only in the file, because the
    // next command the user runs will not mention it and the number they get
    // from a benchmark will look exactly like a real one.
    if (ir.quality.tier !== 'standard') {
      heading('quality');
      detail(
        'tier',
        ir.quality.tier === 'degraded'
          ? colour.yellow('degraded — a model was configured and fell back')
          : colour.yellow('offline_minimal — not a measure of quality'),
      );
      for (const standIn of ir.quality.stand_ins) note(`  ${describeStandIn(standIn)}`);
    }

    // What each file was taken to be, because it decides how the file was cut
    // into events and a wrong guess is the user's to correct.
    if (ir.materials.length > 0) {
      heading('material');
      for (const line of materialLines(ir.materials, ir.assets)) note(`  ${line}`);
    }

    // Which recorder was taken for which camera's sound. Said because it
    // changes what the transcript is and what sound the export links, and a
    // wrong pairing is the user's to undo in context.yaml.
    const soundLines = recorderLines(ir.audio_companions, ir.assets, report.recorderNotes);
    if (soundLines.length > 0) {
      heading('separate sound');
      for (const line of soundLines) note(`  ${line}`);
    }

    heading('privacy');
    detail('media left this machine', report.mediaLeftDevice ? colour.yellow('yes') : 'no');
    if (report.mediaLeftDevice) {
      const remote = ir.model_runs.filter((run) => run.media_left_device);
      for (const run of remote)
        note(`  ${run.stage} to ${run.backend}${run.model ? ` (${run.model})` : ''}`);
    }

    // A multi-minute recording that came back as one shot is often the scene
    // detector's threshold rather than a genuine continuous take. A long take is
    // no longer one event — it is divided where the picture or the sound
    // changes — but where nothing measured changes it is divided evenly, and
    // that is a guess the user should know about. A screen recording is one
    // shot by nature, and is not worth a warning.
    const SUSPICIOUS_MS = 120_000;
    const oneShot = ir.assets.filter((asset) => {
      if (asset.kind !== 'video' || asset.duration_ms < SUSPICIOUS_MS) return false;
      const kind = ir.materials.find((m) => m.asset_id === asset.id)?.kind;
      if (kind === 'screen_recording') return false;
      return observationsShotCount(result.observations, asset.id) === 1;
    });
    if (oneShot.length > 0) {
      heading('one shot each');
      for (const asset of oneShot) {
        note(`  ${asset.file_name}: ${formatTimecode(asset.duration_ms, false)} with no cut found`);
      }
      note('  Either these are continuous takes, or the scene detector is set too high');
      note('  for this footage. A take is divided where its picture or sound changes,');
      note('  and into even parts where nothing does.');
    }

    if (report.unavailable.length > 0) {
      heading('not available');
      for (const { stage, reason } of report.unavailable) {
        note(`  ${stage}: ${reason}, so the analysis has less to go on`);
      }
    }

    if (report.failures.length > 0) {
      heading('could not read');
      for (const failure of report.failures) {
        warn(`  ${failure.stage} on ${failure.assetId}: ${failure.reason}`);
      }
    }

    if (ir.conflicts.length > 0) {
      heading('disagreements');
      for (const conflict of ir.conflicts)
        note(`  ${conflict.path}: ${conflict.note ?? 'recorded'}`);
    }

    heading('next');
    note('  oea timeline     see what it understood');
    note('  oea plan --skill travel-vlog --duration 180');
    return 0;
  } finally {
    progress.clear();
    await backends.close();
  }
}

/**
 * The still-and-silent section of `oea analyze`, as label and value pairs; an
 * empty label is a note.
 *
 * It said nothing at all unless something was found, so "the footage was busy",
 * "nothing measured the picture" and "you switched it off" were one silence.
 * Every figure that is an estimate says so where it is shown.
 */
export function stillAndSilentLines(
  state: 'found' | 'none_found' | 'not_measured' | 'off',
  savings: AnalysisSavings | undefined,
): [string, string][] {
  if (state === 'off') {
    return [['', 'not looked for (--no-skip-inactive): every event was put to the models']];
  }
  if (state === 'not_measured') {
    return [['', 'not measured: no picture analysis ran, so nothing was skipped']];
  }
  if (state === 'none_found' || !savings) {
    return [['', 'none found: every stretch moved or made a sound']];
  }
  const lines: [string, string][] = [['footage', formatTimecode(savings.inactive_ms, false)]];
  if (savings.describe_calls_skipped + savings.judge_calls_skipped > 0) {
    lines.push([
      'not asked of a model',
      `${savings.describe_calls_skipped} description(s), ${savings.judge_calls_skipped} judgement(s)`,
    ]);
  }
  if (savings.escalations_avoided > 0) {
    lines.push(['closer looks not bought', String(savings.escalations_avoided)]);
  }
  if (savings.escalations_redirected > 0) {
    lines.push([
      'closer looks moved',
      `${savings.escalations_redirected}, to events with something in them`,
    ]);
  }
  const frames = savings.frames_not_sent + savings.frames_not_analysed;
  if (frames > 0) lines.push(['frames not sent or read', String(frames)]);
  if (savings.estimated_tokens_avoided > 0) {
    lines.push(['tokens avoided', `about ${savings.estimated_tokens_avoided} (an estimate)`]);
  }
  if (savings.estimated_cost_avoided_usd > 0) {
    // Finer than the cost line above: avoiding four tenths of a cent is worth
    // saying as that, not as "<$0.01".
    const usd = savings.estimated_cost_avoided_usd;
    const amount = usd < 0.001 ? 'under $0.001' : `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
    lines.push(['cost avoided', `about ${amount} (an estimate)`]);
  }
  lines.push(['', 'no time value changed: the media is untouched and every timecode is the same']);
  return lines;
}

/** How many guessed kinds are named one by one before the rest are counted. */
const MATERIALS_LISTED = 8;

const KIND_WORDS: Record<MaterialKind, string> = {
  raw: 'a camera recording',
  edited: 'already edited',
  clip: 'a clip, kept whole',
  screen_recording: 'a screen recording',
  audio_only: 'sound only',
  still: 'a still image',
};

/**
 * The material section of `oea analyze`: the guesses by name, the rest counted.
 *
 * Raw footage is the ordinary case, and a still or a sound file is what the file
 * itself says rather than a guess, so those are counted. Everything else — an
 * edit, a clip, a screen recording, and whatever the user set — is named with
 * its reason, so a wrong call can be seen and overruled. Naming the stills as
 * well buried exactly that call: photographs sort before `final_v3.mp4`, and in
 * a folder of forty of them the one file taken for an edit was "and 33 more".
 */
export function materialLines(
  materials: readonly MaterialProfile[],
  assets: readonly MediaAsset[],
): string[] {
  const counted = (kind: MaterialKind): MaterialProfile[] =>
    materials.filter((m) => m.kind === kind && m.provenance === 'inferred');
  const raw = counted('raw');
  const stills = counted('still');
  const sound = counted('audio_only');
  const named = materials.filter(
    (m) => !raw.includes(m) && !stills.includes(m) && !sound.includes(m),
  );

  const lines: string[] = [];
  if (raw.length > 0) lines.push(`${raw.length} camera recording(s)`);
  if (stills.length > 0) lines.push(`${stills.length} still image(s)`);
  if (sound.length > 0) lines.push(`${sound.length} sound-only file(s)`);
  for (const profile of named.slice(0, MATERIALS_LISTED)) {
    const asset = assets.find((a) => a.id === profile.asset_id);
    const why =
      profile.provenance === 'user_provided' ? 'as you said' : (profile.evidence[0] ?? '');
    lines.push(`${asset?.file_name ?? profile.asset_id}: ${KIND_WORDS[profile.kind]} (${why})`);
  }
  if (named.length > MATERIALS_LISTED) {
    lines.push(
      `and ${named.length - MATERIALS_LISTED} more, listed under materials in .oea/ir.json`,
    );
  }
  if (named.some((m) => m.provenance === 'inferred')) {
    lines.push('wrong? set it in context.yaml: background.materials: { "<file name>": raw }');
  }
  return lines;
}

/**
 * The separate-sound section of `oea analyze`: each recorder and the video it
 * was lined up with, where the recorder's first moment falls in that video,
 * and what in context.yaml could not be applied.
 */
export function recorderLines(
  companions: readonly AudioCompanion[],
  assets: readonly MediaAsset[],
  notes: readonly string[] = [],
): string[] {
  const name = (id: string): string => assets.find((a) => a.id === id)?.file_name ?? id;
  const lines = companions.map((companion) => {
    const at = companion.offset_ms / 1000;
    const where =
      at >= 0 ? `starts ${at.toFixed(2)}s into it` : `started ${(-at).toFixed(2)}s before it`;
    const how =
      companion.provenance === 'user_provided'
        ? 'as you said'
        : `measured, confidence ${companion.confidence.toFixed(2)}`;
    return `${name(companion.audio_asset_id)} is the sound of ${name(companion.asset_id)}: ${where} (${how})`;
  });
  lines.push(...notes);
  if (companions.some((c) => c.provenance !== 'user_provided')) {
    lines.push(
      'wrong? set it in context.yaml: background.recorders: [{ recorder: "<file>", video: "<file>", paired: false }]',
    );
  }
  return lines;
}

function observationsShotCount(
  observations: { shots: readonly { asset_id: string }[] },
  assetId: string,
): number {
  return observations.shots.filter((shot) => shot.asset_id === assetId).length;
}

/**
 * The tier of the analysis already on disk, if there is one this build can read.
 *
 * Deliberately forgiving: a project with no IR yet, or one written by a version
 * whose shape has since changed, simply has no previous tier. Neither is a
 * reason to refuse to analyse — analysing is how both get fixed.
 */
function previousTier(store: ReturnType<typeof openProject>): string | undefined {
  try {
    return store.readIr()?.quality.tier;
  } catch {
    return undefined;
  }
}
