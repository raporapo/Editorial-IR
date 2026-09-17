import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  CONTRACT_VERSIONS,
  EditorialError,
  ProjectContext,
  SCHEMA_NAMES,
  toJsonSchema,
  toJsonSchemaBundle,
} from '@editorial-ir/contracts';
import { NodeCommandRunner } from '@editorial-ir/perception';
import { SkillRegistry, validateSkill } from '@editorial-ir/skills';
import { listAdapters } from '@editorial-ir/adapters';
import { resolveBackends } from '../backends.js';
import { createProject, openProject } from '../project.js';
import { colour, detail, fail, heading, line, note, success, table, warn } from '../ui.js';

/* -------------------------------------------------------------------------- */
/* skills                                                                      */
/* -------------------------------------------------------------------------- */

export function runSkills(args: { name?: string; skillsDir?: string }): number {
  const registry = SkillRegistry.withBuiltIns(args.skillsDir ? [args.skillsDir] : []);

  if (!args.name) {
    heading('skills');
    table(
      registry
        .list()
        .map((source) => [source.name, source.manifest.description.split('\n')[0] ?? '']),
    );
    line();
    note('oea skills <name>   what it does and why');
    return 0;
  }

  const source = registry.source(args.name);
  if (!source) {
    // Every other command that takes a name lists the alternatives when it does
    // not recognise one. This one did not, which for a typo is the difference
    // between a dead end and an answer.
    fail(`no skill called "${args.name}"`);
    note(
      `  available: ${registry
        .list()
        .map((s) => s.name)
        .join(', ')}`,
    );
    return 1;
  }

  if (source.readme) {
    line(source.readme.trim());
    line();
  }

  const resolved = registry.resolve(args.name);
  heading('as resolved');
  detail('extends', resolved.extends.join(', ') || 'nothing');
  detail(
    'clips',
    `${resolved.defaults.min_clip_duration_ms / 1000}s to ${resolved.defaults.max_clip_duration_ms / 1000}s`,
  );
  detail('order', resolved.arc.ordering);
  detail('rules', String(resolved.rules.length));

  heading('what it weighs');
  table(
    Object.entries(resolved.scoring.weights)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([metric, weight]) => [metric.padEnd(22), weight.toFixed(2)]),
  );

  const problems = validateSkill(resolved);
  if (problems.length > 0) {
    heading('problems');
    for (const problem of problems) warn(`  ${problem}`);
    return 1;
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* doctor                                                                      */
/* -------------------------------------------------------------------------- */

export async function runDoctor(): Promise<number> {
  const runner = new NodeCommandRunner();
  let problems = 0;

  heading('this machine');
  detail('node', process.version);
  detail('platform', `${process.platform} ${process.arch}`);

  const ffmpeg = await runner.available('ffmpeg');
  const ffprobe = await runner.available('ffprobe');
  detail('ffmpeg', ffmpeg ? colour.green('yes') : colour.red('missing'));
  detail('ffprobe', ffprobe ? colour.green('yes') : colour.red('missing'));

  if (!ffprobe) {
    problems++;
    warn('ffprobe is the one hard dependency: without it, media cannot be registered.');
    note('  macOS: brew install ffmpeg   Debian: apt install ffmpeg');
    note('  You can still try everything with: oea demo ./demo');
  }

  heading('what is configured');
  // Asked of the thing that decides, rather than read out of the environment a
  // second time. The hand-rolled version looked at `OEA_VLM_MODEL` while the
  // compiler wires a closer look only when its base URL is set too, so a shell
  // with half a pair configured was told it had a model it would not get; and
  // `OEA_DECISION=model` with no base URL got "everything checks out" from the
  // command whose whole job is to find that before the analysis does.
  try {
    const backends = await resolveBackends({ onLog: (message) => note(`  ${message}`) });
    try {
      for (const item of backends.description) note(`  ${item}`);
    } finally {
      await backends.close();
    }
  } catch (error) {
    problems++;
    warn(`  ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!process.env.OEA_VLM_BASE_URL && !process.env.OEA_DECISION_BASE_URL) {
    note('  Everything runs locally and costs nothing. To add a stronger model for');
    note('  the events that need one, set OEA_VLM_BASE_URL and OEA_VLM_MODEL.');
  }

  heading('skills and editors');
  const registry = SkillRegistry.withBuiltIns();
  detail(
    'skills',
    registry
      .list()
      .map((s) => s.name)
      .join(', '),
  );
  detail(
    'editors',
    listAdapters()
      .map((a) => a.id)
      .join(', '),
  );

  for (const source of registry.list()) {
    const issues = validateSkill(registry.resolve(source.name));
    for (const issue of issues) {
      problems++;
      warn(`  ${source.name}: ${issue}`);
    }
  }

  heading('contracts');
  for (const [name, version] of Object.entries(CONTRACT_VERSIONS)) detail(name, version);

  line();
  if (problems === 0) success('everything checks out');
  else warn(`${problems} thing(s) need attention`);
  return problems === 0 ? 0 : 1;
}

/* -------------------------------------------------------------------------- */
/* schema                                                                      */
/* -------------------------------------------------------------------------- */

export function runSchema(args: { out?: string; name?: string }): number {
  if (args.name) {
    if (!SCHEMA_NAMES.includes(args.name as (typeof SCHEMA_NAMES)[number])) {
      throw new EditorialError('not_found', `there is no schema called ${args.name}`, {
        available: SCHEMA_NAMES,
      });
    }
    line(JSON.stringify(toJsonSchema(args.name as (typeof SCHEMA_NAMES)[number]), null, 2));
    return 0;
  }

  if (!args.out) {
    line(JSON.stringify(toJsonSchemaBundle(), null, 2));
    return 0;
  }

  mkdirSync(args.out, { recursive: true });
  for (const name of SCHEMA_NAMES) {
    writeFileSync(
      join(args.out, `${name}.schema.json`),
      `${JSON.stringify(toJsonSchema(name), null, 2)}\n`,
    );
  }
  writeFileSync(
    join(args.out, 'editorial-ir.bundle.schema.json'),
    `${JSON.stringify(toJsonSchemaBundle(), null, 2)}\n`,
  );
  success(`wrote ${SCHEMA_NAMES.length + 1} schema files to ${args.out}`);
  return 0;
}

/* -------------------------------------------------------------------------- */
/* context                                                                     */
/* -------------------------------------------------------------------------- */

export function runContext(args: { project?: string; json?: boolean }): number {
  const store = openProject(args.project);
  const context = store.readContext();

  if (args.json) {
    line(JSON.stringify(context, null, 2));
    return 0;
  }

  heading('what you have told it');
  detail('occasion', context.background.occasion ?? colour.grey('nothing yet'));
  detail(
    'people',
    context.background.people.map((p) => `${p.id}${p.role ? ` (${p.role})` : ''}`).join(', ') ||
      colour.grey('nobody'),
  );
  detail('places', context.background.places.map((p) => p.id).join(', ') || colour.grey('nowhere'));
  detail(
    'target',
    context.editing_goal.target_duration_ms
      ? `${Math.round(context.editing_goal.target_duration_ms / 1000)}s`
      : colour.grey('not set'),
  );
  detail('tone', context.editing_goal.tone.join(', ') || colour.grey('not set'));
  if (context.editing_goal.instruction)
    detail('instruction', context.editing_goal.instruction.trim());

  line();
  note(`Edit ${relative(process.cwd(), store.paths.context)} to change any of this.`);
  note('It outranks everything the models decide, and is never overwritten.');
  return 0;
}

/* -------------------------------------------------------------------------- */
/* demo                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where the worked example lives, which is two different places.
 *
 * In this repository it is `examples/anniversary-trip`, shared by the tests and
 * the golden snapshot. In a published package it is copied to `example/` at pack
 * time, because `files` cannot reach outside the package directory and `oea
 * demo` has to work on a fresh install — it is the first command in the README
 * and the only one that needs no footage of your own.
 */
const EXAMPLE_CANDIDATES = [
  // This repository, and deliberately first: the copy the tests and the golden
  // snapshot use wins over any stale one left behind by a local `pnpm pack`.
  // apps/cli/{src,dist}/commands/misc.* -> the workspace root.
  '../../../../examples/anniversary-trip',
  // Packaged: dist/commands/misc.js -> the package root.
  '../../example',
].map((candidate) => resolve(fileURLToPath(new URL(candidate, import.meta.url))));

function exampleDir(): string {
  // Checked by a file it must contain rather than by the directory, so that a
  // directory which happens to sit at one of these paths cannot shadow it.
  const found = EXAMPLE_CANDIDATES.find((candidate) =>
    existsSync(join(candidate, 'perception.fixture.json')),
  );
  if (!found) {
    throw new EditorialError('not_found', 'the worked example is not installed beside this build', {
      looked_in: EXAMPLE_CANDIDATES,
    });
  }
  return found;
}

export function runDemo(args: { directory?: string }): { root: string; fixture: string } {
  const root = resolve(args.directory ?? './oea-demo');
  const example = exampleDir();

  mkdirSync(root, { recursive: true });
  cpSync(join(example, 'footage'), join(root, 'footage'), { recursive: true });
  const fixture = join(root, 'perception.fixture.json');
  cpSync(join(example, 'perception.fixture.json'), fixture);

  const store = createProject(root, { title: '大阪1周年旅行', type: 'travel_vlog' });
  const project = store.readProject();
  store.writeContext(
    ProjectContext.parse({
      ...(parseYaml(readFileSync(join(example, 'context.yaml'), 'utf8')) as Record<
        string,
        unknown
      >),
      project_id: project.id,
    }),
  );

  return { root, fixture };
}
