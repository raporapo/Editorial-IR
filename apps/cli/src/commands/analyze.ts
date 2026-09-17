import { compileProject } from '@editorial-ir/core';
import { describeStandIn, formatTimecode } from '@editorial-ir/contracts';
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
      standInReason: backends.standInReason,
      onProgress: (stage, message, done, total) => progress.update(stage, message, done, total),
    });
    progress.clear();

    store.writeObservations(result.observations);
    store.writeIr(result.ir);
    store.writeEmbeddings(result.embeddings);
    store.writeProject({
      ...result.ir.project,
      ...(perception ? { perception } : {}),
    });

    const { ir, report } = result;
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

    heading('privacy');
    detail('media left this machine', report.mediaLeftDevice ? colour.yellow('yes') : 'no');
    if (report.mediaLeftDevice) {
      const remote = ir.model_runs.filter((run) => run.media_left_device);
      for (const run of remote)
        note(`  ${run.stage} to ${run.backend}${run.model ? ` (${run.model})` : ''}`);
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
