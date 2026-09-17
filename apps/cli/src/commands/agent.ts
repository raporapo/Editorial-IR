import {
  EditorialError,
  formatTimecode,
  planDurationMs,
  summariseReport,
} from '@editorial-ir/contracts';
import { AgentToolkit, LlmEditingAgent, validatePlan } from '@editorial-ir/agent';
import { ModelRunRecorder } from '@editorial-ir/core';
import { localityOf } from '@editorial-ir/perception';
import { SkillRegistry } from '@editorial-ir/skills';
import { openProject } from '../project.js';
import { openIndex, requireIr } from '../ir.js';
import { colour, detail, fail, heading, line, note, success, table, truncate } from '../ui.js';

export interface AgentArgs {
  instruction: string;
  project?: string;
  skill?: string;
  skillsDir?: string;
  duration?: number;
  json?: boolean;
}

/**
 * Planning a cut with a model in the loop.
 *
 * It does not write the cut. It reads the analysis through the same toolkit
 * anything else would use, says which moments this particular request is about,
 * and the deterministic planner turns that into a plan that is on target and
 * valid by construction.
 *
 * Reach for it when a request has intent in it that a skill file cannot express:
 * "the meals do not all need to be shown", "end on the night view".
 */
export async function runAgent(args: AgentArgs): Promise<number> {
  const baseUrl = process.env.OEA_AGENT_BASE_URL ?? process.env.OEA_DECISION_BASE_URL;
  const model = process.env.OEA_AGENT_MODEL ?? process.env.OEA_DECISION_MODEL;
  if (!baseUrl || !model) {
    throw new EditorialError(
      'invalid_input',
      'the agent needs a model: set OEA_AGENT_BASE_URL and OEA_AGENT_MODEL',
      {
        hint: 'A local server works: OEA_AGENT_BASE_URL=http://localhost:11434/v1',
        alternative: 'oea plan does the same job without a model, and is the default path',
      },
    );
  }

  const store = openProject(args.project);
  const ir = requireIr(store);
  const registry = SkillRegistry.withBuiltIns(args.skillsDir ? [args.skillsDir] : []);
  const skill = registry.resolve(args.skill ?? 'base-editor');

  const targetDurationMs = args.duration
    ? Math.round(args.duration * 1000)
    : (ir.context.editing_goal.target_duration_ms ?? 180_000);

  // Say where this is about to go, before it goes.
  //
  // The agent sends the whole of `context.yaml` — the occasion, the people, the
  // places, the instruction in the user's own words — and the transcript of
  // every event it chooses to inspect. None of that was recorded anywhere: the
  // run wrote a plan and nothing else, `oea analyze` went on printing "media
  // left this machine: no" and "cost: nothing", and `docs/privacy.md` had no row
  // for it. A stage that sends a user's notes to a hosted model and leaves no
  // trace is the thing this project says it does not do.
  const { locality, remote } = localityOf(baseUrl);
  heading('sending');
  note(
    `  ${remote ? colour.yellow('to a remote model') : 'to a model on this machine'}: ${model} at ${baseUrl}`,
  );
  note('  your project background and the transcript of every moment it looks at');

  const toolkit = new AgentToolkit(ir, openIndex(store, ir));
  const agent = new LlmEditingAgent(toolkit, {
    baseUrl,
    model,
    ...((process.env.OEA_AGENT_API_KEY ?? process.env.OEA_DECISION_API_KEY)
      ? { apiKey: process.env.OEA_AGENT_API_KEY ?? process.env.OEA_DECISION_API_KEY }
      : {}),
    onStep: (step) => note(`  ${colour.grey(`${step.tool}`)} ${step.summary}`),
  });

  heading('working');
  const result = await agent.plan({
    instruction: args.instruction,
    skill,
    targetDurationMs,
    ...(store.readObservations() ? { observations: store.readObservations()! } : {}),
  });

  const report = validatePlan(result.plan, {
    ir,
    projectRoot: store.paths.root,
    checkMediaExists: true,
  });
  if (!report.ok) {
    fail(`the plan did not validate: ${summariseReport(report)}`);
    return 1;
  }

  // The run goes into the plan, so the artifact says who made it. `planning`
  // has been a PipelineStage since the contract was written and nothing had
  // ever recorded one — this command wrote a plan and left no trace anywhere
  // that a model had seen the user's notes. It belongs on the plan rather than
  // in the IR because the next `oea analyze` rebuilds the IR and not this.
  const runs = new ModelRunRecorder();
  const runId = runs.record({
    stage: 'planning',
    backend: 'openai-compatible',
    model,
    locality,
    // The toolkit here is built without an inspection source, so `look_at_event`
    // has no frames to send. If that ever changes, this must change with it.
    mediaLeavesDevice: false,
    parameters: { instruction: args.instruction, skill: skill.name },
  });
  runs.addCost(runId, 0, result.inputTokens, result.outputTokens);
  const planned = { ...result.plan, model_runs: runs.all() };
  store.writePlan(planned);
  result.plan.model_runs = planned.model_runs;

  if (args.json) {
    line(JSON.stringify({ plan: result.plan, proposal: result.proposal }, null, 2));
    return 0;
  }

  success(
    `${result.plan.stats.operation_count} clips, ${formatTimecode(planDurationMs(result.plan), false)}`,
  );

  heading('what it decided');
  if (result.proposal.reasoning) note(`  ${result.proposal.reasoning}`);
  if (result.proposal.keep.length > 0) detail('kept', result.proposal.keep.join(', '));
  if (result.proposal.drop.length > 0) detail('left out', result.proposal.drop.join(', '));
  for (const item of result.proposal.emphasise) {
    detail(item.event_id, item.reason);
  }

  heading('the cut');
  table(
    result.plan.tracks.video.map((operation) => {
      const event = ir.events.find((e) => e.id === operation.event_id);
      return [
        colour.grey(operation.operation_id),
        formatTimecode(operation.timeline_start_ms, false),
        colour.cyan((operation.role ?? '').padEnd(10)),
        truncate(event?.description.value ?? '', 48),
      ];
    }),
  );

  detail('tokens', `${result.inputTokens} in, ${result.outputTokens} out`);
  heading('next');
  note('  oea review                   what is wrong with it');
  note('  oea apply --editor otio      write it out');
  return 0;
}
