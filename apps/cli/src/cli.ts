import { parseArgs } from 'node:util';
import { EditorialError } from '@editorial-ir/contracts';
import { colour, fail, heading, line, note } from './ui.js';
import { runInit } from './commands/init.js';
import { runIngest } from './commands/ingest.js';
import { runAnalyze } from './commands/analyze.js';
import { runTimeline } from './commands/timeline.js';
import { runPlan } from './commands/plan.js';
import { runApply, runEditors } from './commands/apply.js';
import { runSearch } from './commands/search.js';
import { runExplain } from './commands/explain.js';
import { runInspect } from './commands/inspect.js';
import { runAnnotate } from './commands/annotate.js';
import { runContext, runDemo, runDoctor, runSchema, runSkills } from './commands/misc.js';
import { runReview } from './commands/review.js';
import { runAgent } from './commands/agent.js';

/**
 * `oea` — the command line.
 *
 * The verbs follow the shape of the pipeline, because that is what a user has to
 * understand anyway: register media, say what it is, compile it, look at what
 * came out, plan a cut, send it somewhere. Every command that changes something
 * says what to do next, since the hardest part of a tool with seven stages is
 * knowing which one you are on.
 */
const OPTIONS = {
  project: { type: 'string' as const },
  perception: { type: 'string' as const },
  decision: { type: 'string' as const },
  skill: { type: 'string' as const },
  'skills-dir': { type: 'string' as const },
  duration: { type: 'string' as const },
  tolerance: { type: 'string' as const },
  editor: { type: 'string' as const },
  plan: { type: 'string' as const },
  out: { type: 'string' as const },
  name: { type: 'string' as const },
  title: { type: 'string' as const },
  type: { type: 'string' as const },
  aspect: { type: 'string' as const },
  limit: { type: 'string' as const },
  chapter: { type: 'string' as const },
  shots: { type: 'boolean' as const },
  frames: { type: 'boolean' as const },
  sheet: { type: 'boolean' as const },
  require: { type: 'string' as const, multiple: true },
  drop: { type: 'string' as const, multiple: true },
  budget: { type: 'string' as const },
  'max-escalations': { type: 'string' as const },
  force: { type: 'boolean' as const },
  'offline-minimal': { type: 'boolean' as const },
  'no-skip-inactive': { type: 'boolean' as const },
  json: { type: 'boolean' as const },
  full: { type: 'boolean' as const },
  quiet: { type: 'boolean' as const },
  list: { type: 'boolean' as const },
  clear: { type: 'boolean' as const },
  help: { type: 'boolean' as const, short: 'h' },
  version: { type: 'boolean' as const, short: 'v' },
};

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    note('Run "oea --help" for the list of commands.');
    return 2;
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.version) {
    line(VERSION);
    return 0;
  }
  if (!command || values.help) {
    printHelp(command);
    return command ? 0 : values.help ? 0 : 1;
  }

  const number = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsedNumber = Number(value);
    if (!Number.isFinite(parsedNumber)) {
      throw new EditorialError('invalid_input', `"${value}" is not a number`);
    }
    return parsedNumber;
  };

  // `multiple: true` in a non-literal options object widens to
  // `string | string[]`, and a single `--require evt_0001` really does arrive as
  // a bare string. Normalising here keeps the command signatures honest.
  const list = (value: string | string[] | undefined): string[] | undefined => {
    if (value === undefined) return undefined;
    const values_ = Array.isArray(value) ? value : [value];
    return values_.length > 0 ? values_ : undefined;
  };

  const common = {
    ...(values.project ? { project: values.project } : {}),
    ...(values.perception ? { perception: values.perception } : {}),
  };

  switch (command) {
    case 'init':
      return runInit({
        ...(rest[0] ? { directory: rest[0] } : {}),
        ...(values.title ? { title: values.title } : {}),
        ...(values.type ? { type: values.type } : {}),
      });

    case 'ingest':
      if (rest.length === 0) {
        fail('ingest needs at least one path');
        return 2;
      }
      return runIngest({ paths: rest, ...common });

    case 'analyze':
    case 'analyse':
      return runAnalyze({
        ...common,
        ...(values.decision ? { decision: values.decision } : {}),
        ...(values['offline-minimal'] ? { offlineMinimal: true } : {}),
        ...(values.force ? { force: true } : {}),
        ...(values['no-skip-inactive'] ? { skipInactive: false } : {}),
        ...(number(values.budget) === undefined ? {} : { budget: number(values.budget) }),
        ...(number(values['max-escalations']) === undefined
          ? {}
          : { maxEscalations: number(values['max-escalations']) }),
      });

    case 'timeline':
      return runTimeline({
        ...(values.project ? { project: values.project } : {}),
        ...(values.json ? { json: true } : {}),
        ...(values.full ? { full: true } : {}),
        ...(values.chapter ? { chapter: values.chapter } : {}),
      });

    case 'search':
      if (rest.length === 0) {
        fail('search needs something to look for');
        return 2;
      }
      return runSearch({
        query: rest.join(' '),
        ...(values.project ? { project: values.project } : {}),
        ...(values.aspect ? { aspect: values.aspect } : {}),
        ...(number(values.limit) === undefined ? {} : { limit: number(values.limit) }),
        ...(values.json ? { json: true } : {}),
      });

    case 'plan':
      return runPlan({
        ...(values.project ? { project: values.project } : {}),
        ...(values.skill ? { skill: values.skill } : {}),
        ...(values['skills-dir'] ? { skillsDir: values['skills-dir'] } : {}),
        ...(number(values.duration) === undefined ? {} : { duration: number(values.duration) }),
        ...(number(values.tolerance) === undefined ? {} : { tolerance: number(values.tolerance) }),
        ...(values.json ? { json: true } : {}),
        ...(values.quiet ? { quiet: true } : {}),
        ...(list(values.require) ? { require: list(values.require)! } : {}),
        ...(list(values.drop) ? { drop: list(values.drop)! } : {}),
      });

    case 'explain':
      if (!rest[0]) {
        fail('explain needs an event id, such as evt_0031');
        return 2;
      }
      return runExplain({
        target: rest[0],
        ...(values.project ? { project: values.project } : {}),
        ...(values.json ? { json: true } : {}),
      });

    case 'inspect':
      if (!rest[0]) {
        fail('inspect needs an event id, such as evt_0031');
        return 2;
      }
      return runInspect({
        target: rest[0],
        ...(values.project ? { project: values.project } : {}),
        ...(values.shots ? { shots: true } : {}),
        ...(values.frames ? { frames: true } : {}),
        ...(values.sheet ? { sheet: true } : {}),
        ...(values.json ? { json: true } : {}),
      });

    case 'annotate':
      return runAnnotate({
        ...(rest[0] ? { target: rest[0] } : {}),
        ...(rest[1] ? { kind: rest[1] } : {}),
        ...(rest[2] ? { value: rest.slice(2).join(' ') } : {}),
        ...(values.project ? { project: values.project } : {}),
        ...(values.list ? { list: true } : {}),
        ...(values.clear ? { clear: true } : {}),
      });

    case 'review':
      return runReview({
        ...(values.project ? { project: values.project } : {}),
        ...(values.plan ? { plan: values.plan } : {}),
        ...(values.json ? { json: true } : {}),
      });

    case 'agent':
      if (rest.length === 0) {
        fail(
          'agent needs an instruction, such as: oea agent "three minutes, ending on the night view"',
        );
        return 2;
      }
      return runAgent({
        instruction: rest.join(' '),
        ...(values.project ? { project: values.project } : {}),
        ...(values.skill ? { skill: values.skill } : {}),
        ...(values['skills-dir'] ? { skillsDir: values['skills-dir'] } : {}),
        ...(number(values.duration) === undefined ? {} : { duration: number(values.duration) }),
        ...(values.json ? { json: true } : {}),
      });

    case 'apply':
      return runApply({
        ...(values.project ? { project: values.project } : {}),
        ...(values.editor ? { editor: values.editor } : {}),
        ...(values.plan ? { plan: values.plan } : {}),
        ...(values.out ? { out: values.out } : {}),
        ...(values.name ? { name: values.name } : {}),
      });

    case 'editors':
      return runEditors();

    case 'skills':
      return runSkills({
        ...(rest[0] ? { name: rest[0] } : {}),
        ...(values['skills-dir'] ? { skillsDir: values['skills-dir'] } : {}),
      });

    case 'context':
      return runContext({
        ...(values.project ? { project: values.project } : {}),
        ...(values.json ? { json: true } : {}),
      });

    case 'doctor':
      return runDoctor();

    case 'schema':
      return runSchema({
        ...(rest[0] && rest[0] !== 'export' ? { name: rest[0] } : {}),
        ...(values.out ? { out: values.out } : {}),
      });

    case 'demo':
      return runDemoCommand(rest[0]);

    default:
      fail(`there is no command called "${command}"`);
      note('Run "oea --help" for the list.');
      return 2;
  }
}

/**
 * Sets up the worked example and compiles it, so the first run shows something.
 *
 * Explicitly offline-minimal, and not as a convenience. The demo replays
 * recorded perception and judges it with rules, on a machine that may have no
 * models configured at all — that is the whole point of a command you can run
 * the minute you install this. What it must not do is produce an IR that looks
 * like the product working at full strength, so it takes the same stamp any
 * other model-less run would.
 */
async function runDemoCommand(directory: string | undefined): Promise<number> {
  const { root, fixture } = runDemo(directory ? { directory } : {});
  note(`made a project at ${root}`);

  const ingested = await runIngest({
    paths: [`${root}/footage`],
    project: root,
    perception: `fixture:${fixture}`,
  });
  if (ingested !== 0) return ingested;

  const analysed = await runAnalyze({
    project: root,
    perception: `fixture:${fixture}`,
    offlineMinimal: true,
  });
  if (analysed !== 0) return analysed;

  heading('try');
  note(`  oea timeline --project ${root}`);
  note(`  oea plan --project ${root} --skill travel-vlog --duration 180`);
  note(`  oea plan --project ${root} --skill shorts --duration 40`);
  note(`  oea apply --project ${root} --editor otio`);
  return 0;
}

export const VERSION = '0.1.0';

function printHelp(command: string | undefined): void {
  if (command && command !== 'help') {
    note(`No help for "${command}" yet.`);
    return;
  }

  line(`${colour.bold('oea')} — compile video into something an editor can reason about`);
  line();
  line('Everything below runs locally by default: no GPU, no network, no cost.');

  heading('getting somewhere in one command');
  line('  oea demo ./demo              set up the worked example and analyse it');

  heading('quality');
  line('  Analysis needs a model for description, judgement and search. Set them with');
  line('  OEA_VLM_*, OEA_DECISION_* and OEA_EMBED_*, or run with --offline-minimal to');
  line('  use rules and lexical search — marked as such on the result. "oea doctor" says');
  line('  what this machine has.');

  heading('a project');
  line('  oea init [dir]               make a project here');
  line('  oea ingest <paths...>        register media (never modified, never moved)');
  line('  oea context                  what you have told it about the footage');
  line('  oea analyze                  compile the Editorial IR');

  heading('what it understood');
  line('  oea timeline [--full]        events, chapters and how they were judged');
  line('  oea search <query>           find a moment by describing it');
  line('  oea explain <event>          why a moment was kept or cut');
  line('  oea inspect <event>          what is actually in it: shots, frames, a contact sheet');
  line('  oea annotate <target> <kind> correct it; you outrank every model');

  heading('a cut');
  line('  oea skills [name]            what each editing style does');
  line('  oea plan --skill <name> --duration <seconds>');
  line('               --require evt_0031  keep a moment, whatever it scores');
  line('               --drop evt_0044     leave one out');
  line('  oea agent "<what you want>"  plan with a model in the loop (needs one)');
  line('  oea review                   what is wrong with the latest cut');
  line('  oea editors                  what each editing application can take');
  line('  oea apply --editor <id>      write the cut out');

  heading('everything else');
  line('  oea doctor                   what is installed and what is configured');
  line('  oea schema [name] [--out d]  the contracts, as JSON Schema');

  heading('options');
  line('  --project <dir>              which project (default: found by walking up)');
  line('  --perception local|python[:<interpreter>]|fixture:<path>');
  line('  --decision heuristic|local-system-one|jev');
  line('  --budget <usd>               refuse to spend more than this');
  line('  --force                      re-run perception even if nothing changed');
  line('  --no-skip-inactive           ask the models about still, silent footage too');
  line('  --json                       machine-readable output');
  line('  --quiet                      the summary without the list of clips');

  heading('stronger models, when you want them');
  line('  OEA_VLM_BASE_URL, OEA_VLM_MODEL            a closer look at hard events');
  line('  OEA_DECISION_BASE_URL, OEA_DECISION_MODEL  a second opinion on judgement');
  line('  OEA_EMBED_BASE_URL, OEA_EMBED_MODEL        meaning-based search');
  line('  OEA_AGENT_BASE_URL, OEA_AGENT_MODEL        the agent in "oea agent"');
  line();
  note('Keys come from the environment, never from flags: a key in shell history');
  note('is a key in a backup.');
}
