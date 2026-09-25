import { relative } from 'node:path';
import { SkillRegistry } from '@editorial-ir/skills';
import { planEdit, reviewPlan, validatePlan } from '@editorial-ir/agent';
import {
  formatTimecode,
  operationTimelineDuration,
  planDurationMs,
  summariseReport,
  type EditPlan,
  type SkillManifest,
} from '@editorial-ir/contracts';
import { openProject } from '../project.js';
import { requireIr } from '../ir.js';
import {
  colour,
  detail,
  fail,
  heading,
  line,
  note,
  success,
  table,
  truncate,
  warn,
} from '../ui.js';

export interface PlanArgs {
  project?: string;
  skill?: string;
  duration?: number;
  tolerance?: number;
  skillsDir?: string;
  json?: boolean;
  quiet?: boolean;
  /** Events to keep, whatever they score. */
  require?: string[];
  /** Events to leave out, whatever they score. */
  drop?: string[];
}

/**
 * The skill a stored plan was made with, when it can still be found.
 *
 * `oea plan` validates against the skill it planned with, and `oea review` and
 * `oea apply` validated the same plan without it — so the speech share a
 * talking-head cut promised, and the "this skill's limit cannot fill the
 * target" explanation, were checked once and never again. The plan records the
 * skill's name and version; a built-in, or one in `skillsDir`, with both the
 * same is the skill it was made with. Anything else validates as before,
 * without one, rather than against a different skill of the same name.
 */
export function skillOfPlan(plan: EditPlan, skillsDir?: string): SkillManifest | undefined {
  try {
    const registry = SkillRegistry.withBuiltIns(skillsDir ? [skillsDir] : []);
    const skill = registry.resolve(plan.skill.name);
    return skill.version === plan.skill.version ? skill : undefined;
  } catch {
    return undefined;
  }
}

export function runPlan(args: PlanArgs): number {
  const store = openProject(args.project);
  const ir = requireIr(store);
  const registry = SkillRegistry.withBuiltIns(args.skillsDir ? [args.skillsDir] : []);
  const skill = registry.resolve(args.skill ?? 'base-editor');

  const plan = planEdit({
    ir,
    skill,
    ...(args.duration === undefined ? {} : { targetDurationMs: Math.round(args.duration * 1000) }),
    ...(args.tolerance === undefined ? {} : { toleranceMs: Math.round(args.tolerance * 1000) }),
    ...(store.readObservations() ? { observations: store.readObservations()! } : {}),
    ...(args.require?.length || args.drop?.length
      ? {
          overrides: {
            ...(args.require?.length ? { require: args.require } : {}),
            ...(args.drop?.length ? { drop: args.drop } : {}),
          },
        }
      : {}),
  });

  const report = validatePlan(plan, {
    ir,
    skill,
    projectRoot: store.paths.root,
    checkMediaExists: true,
  });
  if (!report.ok) {
    fail(`the plan did not validate: ${summariseReport(report)}`);
    for (const issue of report.issues.filter((i) => i.severity === 'error')) {
      fail(`  ${issue.code}: ${issue.message}`);
    }
    return 1;
  }

  store.writePlan(plan);
  const project = store.readProject();
  store.writeProject({ ...project, status: 'planned', updated_at: new Date().toISOString() });

  if (args.json) {
    line(JSON.stringify(plan, null, 2));
    return 0;
  }

  success(`${plan.stats.operation_count} clips, ${formatTimecode(planDurationMs(plan), false)}`);

  heading('the cut');
  detail('skill', `${skill.name} ${skill.version}`);
  detail('target', formatTimecode(plan.sequence.target_duration_ms, false));
  detail('off by', `${Math.round(plan.stats.duration_error_ms / 100) / 10}s`);
  detail('kept', `${plan.stats.events_selected} of ${plan.stats.events_available} events`);
  const jumpCuts = plan.tracks.video.filter((operation) => operation.continues_previous).length;
  if (jumpCuts > 0) detail('jump cuts', `${jumpCuts}, where pauses were taken out`);
  detail('compression', `${Math.round(plan.stats.compression_ratio * 1000) / 10}% of the material`);
  detail('saved as', relative(process.cwd(), `${store.paths.plansDir}/${plan.id}.json`));

  if (!args.quiet) {
    heading('clips');
    const rows = plan.tracks.video.map((operation) => {
      const event = ir.events.find((e) => e.id === operation.event_id);
      return [
        colour.grey(operation.operation_id),
        formatTimecode(operation.timeline_start_ms, false),
        `${String(Math.round(operationTimelineDuration(operation) / 100) / 10).padStart(5)}s`,
        colour.cyan((operation.role ?? '').padEnd(10)),
        // The pieces of one take are one moment; naming it once reads as one.
        operation.continues_previous
          ? colour.grey('  …after a pause')
          : truncate(event?.title?.value ?? event?.description.value ?? '', 48),
      ];
    });
    table(rows);

    if (plan.markers.length > 0) {
      heading('chapters');
      table(plan.markers.map((marker) => [formatTimecode(marker.timeline_ms, false), marker.name]));
    }
  }

  const warnings = report.issues.filter((i) => i.severity === 'warning');
  if (warnings.length > 0) {
    heading('worth knowing');
    for (const issue of warnings) warn(`  ${issue.message}`);
  }

  const observations = reviewPlan(plan, ir);
  if (observations.length > 0) {
    heading('review');
    for (const observation of observations.slice(0, 8)) {
      note(
        `  ${formatTimecode(observation.timeline_ms, false)} ${observation.observation_type}: ${observation.message}`,
      );
    }
    if (observations.length > 8) note(`  ...and ${observations.length - 8} more`);
  }

  heading('next');
  note('  oea explain <event>          why a moment was kept or cut');
  note('  oea apply --editor otio      write it out for an editor');
  return 0;
}
