import { relative } from 'node:path';
import { createAdapter, listAdapters } from '@editorial-ir/adapters';
import { validatePlan } from '@editorial-ir/agent';
import { EditorialError, summariseReport } from '@editorial-ir/contracts';
import { openProject } from '../project.js';
import { requireIr } from '../ir.js';
import { detail, fail, heading, note, success, table, warn } from '../ui.js';

export interface ApplyArgs {
  project?: string;
  editor?: string;
  plan?: string;
  out?: string;
  name?: string;
}

export async function runApply(args: ApplyArgs): Promise<number> {
  const store = openProject(args.project);
  const ir = requireIr(store);

  const editor = args.editor ?? 'otio';
  const adapter = createAdapter(editor);

  const plan = args.plan ? store.readPlan(args.plan) : store.latestPlan();
  if (!plan) {
    throw new EditorialError('not_found', 'there is no plan yet. Run "oea plan" first.');
  }

  // Validated against this adapter specifically, so capability mismatches are
  // reported before anything is written rather than discovered in the NLE.
  const report = validatePlan(plan, {
    ir,
    capabilities: adapter.capabilities,
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

  const result = await adapter.apply({
    plan,
    ir,
    projectRoot: store.paths.root,
    outputDir: args.out ?? store.paths.outputDir,
    ...(args.name ? { name: args.name } : {}),
  });

  success(`wrote ${result.artifacts.length} file(s) for ${adapter.capabilities.name}`);
  heading('files');
  table(result.artifacts.map((a) => [relative(process.cwd(), a.path), a.description]));

  if (result.downgrades.length > 0) {
    heading('changed to fit');
    for (const downgrade of result.downgrades) {
      warn(
        `  ${downgrade.capability}: ${downgrade.action}${downgrade.operation_id ? ` (${downgrade.operation_id})` : ''}`,
      );
    }
  }

  for (const warning of result.warnings) note(`  ${warning}`);

  const project = store.readProject();
  store.writeProject({ ...project, status: 'applied', updated_at: new Date().toISOString() });
  return 0;
}

export function runEditors(): number {
  heading('editors');
  for (const capabilities of listAdapters()) {
    detail(
      capabilities.id,
      `${capabilities.name} (${capabilities.mode}, ${capabilities.output_extensions.join(' ')})`,
    );
    for (const note_ of capabilities.notes) note(`      ${note_}`);
  }
  return 0;
}
