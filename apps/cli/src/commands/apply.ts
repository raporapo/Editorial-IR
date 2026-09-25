import { relative } from 'node:path';
import { createAdapter, listAdapters } from '@editorial-ir/adapters';
import { buildCaptions, validatePlan } from '@editorial-ir/agent';
import {
  EditorialError,
  summariseReport,
  type EditPlan,
  type EditorialIR,
  type ObservationTimeline,
} from '@editorial-ir/contracts';
import { openProject } from '../project.js';
import { requireIr, requirePlan } from '../ir.js';
import { skillOfPlan } from './plan.js';
import { detail, fail, heading, note, success, table, warn } from '../ui.js';

export interface ApplyArgs {
  project?: string;
  editor?: string;
  plan?: string;
  out?: string;
  name?: string;
  /** Work captions out from the transcript when the plan has none. */
  captions?: boolean;
  /** The preview's width in pixels. */
  width?: number;
  /** `key=value` settings for the adapter, as `--option` gave them. */
  options?: string[];
}

/** Targets that exist only to carry captions, so an apply to them always wants some. */
const CAPTION_TARGETS = new Set(['srt', 'vtt']);

export async function runApply(args: ApplyArgs): Promise<number> {
  const store = openProject(args.project);
  const ir = requireIr(store);

  const editor = args.editor ?? 'otio';
  const adapter = createAdapter(editor);
  // Read before anything runs, so a mistyped --option is the first thing said
  // rather than something found after the plan was validated.
  const options = applyOptions(args);

  // Asked before anything is validated or written: a target that runs a
  // program (the preview runs ffmpeg) says whether it can, and "ffmpeg is not
  // installed" is a better first line than a half-written output directory.
  if (adapter.available && !(await adapter.available())) {
    fail(`${adapter.capabilities.name} cannot run on this machine`);
    if (adapter.capabilities.renders_preview) {
      note(
        '  it needs ffmpeg on PATH (macOS: brew install ffmpeg, Debian/Ubuntu: apt install ffmpeg)',
      );
      note('  or point OEA_FFMPEG at one');
    }
    return 1;
  }

  let plan = requirePlan(store, args.plan);
  if (CAPTION_TARGETS.has(editor) || args.captions) {
    plan = withCaptionsIfMissing(plan, ir, store.readObservations());
  }

  // Validated against this adapter specifically, so capability mismatches are
  // reported before anything is written rather than discovered in the NLE.
  const report = validatePlan(plan, {
    ir,
    skill: skillOfPlan(plan),
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
    options,
  });

  if (result.artifacts.length > 0) {
    success(`wrote ${result.artifacts.length} file(s) for ${adapter.capabilities.name}`);
    heading('files');
    table(result.artifacts.map((a) => [relative(process.cwd(), a.path), a.description]));
  } else {
    warn(`nothing was written for ${adapter.capabilities.name}`);
  }

  if (result.downgrades.length > 0) {
    heading('changed to fit');
    for (const downgrade of result.downgrades) {
      warn(
        `  ${downgrade.capability}: ${downgrade.action}${downgrade.operation_id ? ` (${downgrade.operation_id})` : ''}`,
      );
    }
  }

  for (const warning of result.warnings) note(`  ${warning}`);
  if (result.elapsed_ms !== undefined && result.elapsed_ms >= 1000) {
    note(`  took ${Math.round(result.elapsed_ms / 100) / 10}s`);
  }

  if (result.artifacts.length === 0) return 1;
  const project = store.readProject();
  store.writeProject({ ...project, status: 'applied', updated_at: new Date().toISOString() });
  return 0;
}

/**
 * The plan with captions, working them out from the transcript when it has
 * none. The plan file itself is left as it is — `oea plan --captions` is what
 * stores them — so an apply never changes what a later apply will read.
 */
function withCaptionsIfMissing(
  plan: EditPlan,
  ir: EditorialIR,
  observations: ObservationTimeline | undefined,
): EditPlan {
  if (plan.tracks.text.some((text) => text.kind === 'caption')) return plan;
  const notes: string[] = [];
  const captions = buildCaptions(plan, ir, observations, { notes });
  if (captions.length > 0) {
    note(`worked out ${captions.length} caption(s) from the transcript`);
  } else if ((observations?.utterances.length ?? 0) === 0) {
    // Said here because the adapter can only say "no captions", and its advice
    // — run this very command — is what the user just did.
    note(
      'no captions: the analysis has no transcript. Captions need a speech model — analyse with ' +
        '"--perception python" (see "oea doctor")',
    );
  } else {
    note('no captions: nothing is said inside the clips of this cut');
  }
  for (const line of notes) note(`  ${line}`);
  return { ...plan, tracks: { ...plan.tracks, text: [...plan.tracks.text, ...captions] } };
}

/**
 * `--option key=value` and the named flags, as one bag of settings.
 *
 * Values read as what they look like — `true`/`false`, numbers, otherwise text —
 * and each adapter documents the keys it reads and ignores the rest.
 */
export function applyOptions(args: Pick<ApplyArgs, 'options' | 'width'>): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const entry of args.options ?? []) {
    const at = entry.indexOf('=');
    if (at <= 0) {
      throw new EditorialError('invalid_input', `--option wants key=value, and got "${entry}"`);
    }
    const key = entry.slice(0, at).trim();
    const raw = entry.slice(at + 1).trim();
    options[key] =
      raw === 'true'
        ? true
        : raw === 'false'
          ? false
          : raw !== '' && Number.isFinite(Number(raw))
            ? Number(raw)
            : raw;
  }
  if (args.width !== undefined) options.width = args.width;
  return options;
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
