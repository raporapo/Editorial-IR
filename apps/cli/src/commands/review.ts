import {
  formatTimecode,
  operationTimelineDuration,
  summariseReport,
} from '@editorial-ir/contracts';
import { recordRevision, reviewPlan, suggestRevisions, validatePlan } from '@editorial-ir/agent';
import { EditorialError } from '@editorial-ir/contracts';
import { openProject } from '../project.js';
import { requireIr } from '../ir.js';
import { colour, detail, heading, line, note, success, table, warn } from '../ui.js';

export interface ReviewArgs {
  project?: string;
  plan?: string;
  json?: boolean;
}

/**
 * Reading a cut back and saying what is wrong with it.
 *
 * The first plan is a rough cut, and the failures of an automatic edit are
 * recognisable enough to check for. This works from the plan and the IR rather
 * than from rendered frames: most of what is wrong with a rough cut is visible
 * in what it selected.
 */
export function runReview(args: ReviewArgs): number {
  const store = openProject(args.project);
  const ir = requireIr(store);

  const plan = args.plan ? store.readPlan(args.plan) : store.latestPlan();
  if (!plan) {
    throw new EditorialError('not_found', 'there is no plan yet. Run "oea plan" first.');
  }

  const validation = validatePlan(plan, {
    ir,
    projectRoot: store.paths.root,
    checkMediaExists: true,
  });
  const observations = reviewPlan(plan, ir);
  const suggestions = suggestRevisions(observations, plan, ir);

  if (args.json) {
    line(
      JSON.stringify(
        {
          validation,
          observations,
          suggestions,
          revision: recordRevision(plan, 1, observations, 'review'),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  heading('the cut');
  detail('plan', plan.id);
  detail('skill', `${plan.skill.name} ${plan.skill.version}`);
  detail('clips', String(plan.stats.operation_count));
  detail('length', formatTimecode(plan.stats.total_duration_ms, false));
  detail(
    'mean clip',
    `${
      Math.round(
        plan.tracks.video.reduce((sum, o) => sum + operationTimelineDuration(o), 0) /
          Math.max(1, plan.tracks.video.length) /
          100,
      ) / 10
    }s`,
  );

  // Who was asked. Empty for the deterministic planner, which asks nobody; an
  // agent-made plan names the model that saw the project's background and
  // transcripts, and that has to be findable after the fact rather than only in
  // the output of the command that did it.
  if (plan.model_runs.length > 0) {
    heading('who was asked');
    for (const run of plan.model_runs) {
      const where = run.locality === 'remote_api' ? colour.yellow('off this machine') : 'here';
      const tokens =
        run.input_tokens === undefined && run.output_tokens === undefined
          ? ''
          : ` (${run.input_tokens ?? 0} in, ${run.output_tokens ?? 0} out)`;
      note(`  ${run.stage}: ${run.model ?? run.backend}, ${where}${tokens}`);
    }
  }

  heading('validity');
  if (validation.ok && validation.issues.length === 0) {
    success('nothing to report');
  } else {
    note(`  ${summariseReport(validation)}`);
    for (const issue of validation.issues) {
      const render = issue.severity === 'error' ? colour.red : colour.yellow;
      note(`  ${render(issue.code)} ${issue.message}`);
    }
  }

  heading('how it reads');
  if (observations.length === 0) {
    success('nothing jumped out');
  } else {
    table(
      observations.map((observation) => [
        formatTimecode(observation.timeline_ms, false),
        colour.yellow(observation.observation_type),
        observation.message,
      ]),
    );
  }

  if (suggestions.length > 0) {
    heading('what would help');
    for (const suggestion of suggestions) {
      const target = suggestion.operation_id ? ` ${suggestion.operation_id}` : '';
      note(`  ${suggestion.action}${target}: ${suggestion.reason}`);
      if (suggestion.candidate_event_id) {
        note(`    try: oea annotate ${suggestion.candidate_event_id} essential`);
      }
    }
    line();
    note('Suggestions are not applied. Adding a shot back makes the piece longer,');
    note('and that is your call rather than the planner’s.');
  }

  if (!validation.ok) warn('this plan has errors and should not be applied');
  return validation.ok ? 0 : 1;
}
