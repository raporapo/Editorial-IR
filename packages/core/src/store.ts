import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  compareText,
  EDIT_PLAN_VERSION,
  IR_VERSION,
  isCompatibleVersion,
  EditPlan,
  EditorialError,
  MediaAsset,
  EditorialIR,
  EmbeddingSet,
  ObservationTimeline,
  Project,
  ProjectContext,
  UserAnnotation,
  parseOrThrow,
  type MediaAsset as MediaAssetType,
} from '@editorial-ir/contracts';
import { z } from 'zod';
import { projectPaths, type ProjectPaths } from './paths.js';
import { FileCache, type PerceptionCache } from './cache.js';

/**
 * Where a project lives.
 *
 * The default is plain files on disk, in formats a person can open. That is a
 * product decision rather than a shortcut: the thing this project asks users to
 * trust is a representation of their own footage, and a representation they
 * cannot look at is one they have to take on faith. JSON diffs in review, YAML
 * is editable by hand, and neither needs a database to be running.
 *
 * The interface exists so that a hosted deployment can put the same documents in
 * Postgres without anything above it noticing.
 */
export interface ProjectStore {
  readonly paths: ProjectPaths;
  readonly cache: PerceptionCache;

  exists(): boolean;
  initialise(project: Project, context: ProjectContext): void;

  readProject(): Project;
  writeProject(project: Project): void;

  readContext(): ProjectContext;
  writeContext(context: ProjectContext): void;

  readAssets(): MediaAssetType[];
  writeAssets(assets: MediaAssetType[]): void;

  readAnnotations(): UserAnnotation[];
  writeAnnotations(annotations: UserAnnotation[]): void;

  readObservations(): ObservationTimeline | undefined;
  writeObservations(observations: ObservationTimeline): void;

  /** Frame vectors from the compile that produced the observations of this fingerprint. */
  readFrameVectors(fingerprint: string): Map<string, number[]> | undefined;
  writeFrameVectors(fingerprint: string, vectors: ReadonlyMap<string, number[]>): void;

  readIr(): EditorialIR | undefined;
  writeIr(ir: EditorialIR): void;

  readEmbeddings(): EmbeddingSet | undefined;
  writeEmbeddings(embeddings: EmbeddingSet): void;

  readPlan(planId: string): EditPlan | undefined;
  writePlan(plan: EditPlan): void;
  listPlans(): string[];
  latestPlan(): EditPlan | undefined;
}

/**
 * Refuses a document written by a version this one cannot read.
 *
 * Below 1.0.0 the minor is the breaking segment, which is what
 * `isCompatibleVersion` implements. The alternative to refusing is reading it
 * hopefully: almost every field in these schemas is optional or defaulted, so an
 * older document parses without complaint and produces something subtly wrong,
 * which is the worst of the three outcomes.
 */
function requireCompatible(
  documentVersion: string,
  runtimeVersion: string,
  what: string,
  remedy: string,
): void {
  if (isCompatibleVersion(documentVersion, runtimeVersion)) return;
  throw new EditorialError(
    'schema_violation',
    `${what} was written by version ${documentVersion}; this is ${runtimeVersion}`,
    { hint: `regenerate it with "${remedy}"` },
  );
}

export class FileProjectStore implements ProjectStore {
  readonly paths: ProjectPaths;
  readonly cache: PerceptionCache;

  constructor(root: string, cache?: PerceptionCache) {
    this.paths = projectPaths(root);
    this.cache = cache ?? new FileCache(this.paths.cacheDir);
  }

  exists(): boolean {
    return existsSync(this.paths.project);
  }

  initialise(project: Project, context: ProjectContext): void {
    mkdirSync(this.paths.dir, { recursive: true });
    mkdirSync(this.paths.plansDir, { recursive: true });
    mkdirSync(this.paths.workDir, { recursive: true });
    this.writeProject(project);
    this.writeContext(context);
    this.writeAssets([]);
    this.writeAnnotations([]);
  }

  private requireProject(): void {
    if (!this.exists()) {
      throw new EditorialError(
        'not_found',
        `no project at ${this.paths.root}. Run "oea init" first.`,
      );
    }
  }

  readProject(): Project {
    this.requireProject();
    return parseOrThrow(Project, readJson(this.paths.project), 'project.json');
  }

  writeProject(project: Project): void {
    writeJson(this.paths.project, project);
  }

  readContext(): ProjectContext {
    this.requireProject();
    // parseYaml returns any; it is validated on the next line, and typing it as
    // unknown is what makes that validation load-bearing rather than decorative.
    const raw: unknown = existsSync(this.paths.context)
      ? parseYaml(readFileSync(this.paths.context, 'utf8'))
      : undefined;
    if (raw === undefined || raw === null) {
      const project = this.readProject();
      return ProjectContext.parse({ project_id: project.id, updated_at: project.created_at });
    }
    return parseOrThrow(ProjectContext, raw, 'context.yaml');
  }

  /**
   * The context is YAML because it is the one file users are expected to write
   * by hand, and because comments survive there.
   */
  writeContext(context: ProjectContext): void {
    mkdirSync(this.paths.dir, { recursive: true });
    writeAtomic(
      this.paths.context,
      `${CONTEXT_HEADER}${stringifyYaml(context, { lineWidth: 100 })}`,
    );
  }

  readAssets(): MediaAssetType[] {
    if (!existsSync(this.paths.assets)) return [];
    return parseOrThrow(z.array(MediaAsset), readJson(this.paths.assets), 'assets.json');
  }

  writeAssets(assets: MediaAssetType[]): void {
    writeJson(this.paths.assets, assets);
  }

  readAnnotations(): UserAnnotation[] {
    if (!existsSync(this.paths.annotations)) return [];
    return parseOrThrow(
      z.array(UserAnnotation),
      readJson(this.paths.annotations),
      'annotations.json',
    );
  }

  writeAnnotations(annotations: UserAnnotation[]): void {
    writeJson(this.paths.annotations, annotations);
  }

  readObservations(): ObservationTimeline | undefined {
    if (!existsSync(this.paths.observations)) return undefined;
    return parseOrThrow(
      ObservationTimeline,
      readJson(this.paths.observations),
      'observations.json',
    );
  }

  writeObservations(observations: ObservationTimeline): void {
    writeJson(this.paths.observations, observations);
  }

  /**
   * The frame vectors a compile produced, keyed `<asset_id>:<timestamp_ms>`.
   *
   * They were held in memory and thrown away, so the second compile of an
   * unchanged project produced a materially different IR — every event's
   * boundary confidence moved, and the visual index changed from the vision
   * model's space to hashed text — under the identical fingerprint, which is
   * computed over the media and the models and so could not tell the two
   * apart. Nothing downstream could either.
   */
  readFrameVectors(fingerprint: string): Map<string, number[]> | undefined {
    if (!existsSync(this.paths.frameVectors)) return undefined;
    const raw = readJson(this.paths.frameVectors);
    if (raw === null || typeof raw !== 'object') return undefined;
    const stored = raw as { fingerprint?: unknown; vectors?: unknown };
    // The fingerprint travels with them, because these are only the right
    // vectors for the observations they were computed alongside. A sidecar left
    // behind by an earlier analysis is not a cache hit, it is the wrong answer.
    if (stored.fingerprint !== fingerprint) return undefined;
    if (stored.vectors === null || typeof stored.vectors !== 'object') return undefined;
    const out = new Map<string, number[]>();
    for (const [key, value] of Object.entries(stored.vectors as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const numbers: number[] = [];
      for (const item of value) if (typeof item === 'number') numbers.push(item);
      if (numbers.length === value.length) out.set(key, numbers);
    }
    return out;
  }

  writeFrameVectors(fingerprint: string, vectors: ReadonlyMap<string, number[]>): void {
    if (vectors.size === 0) {
      rmSync(this.paths.frameVectors, { force: true });
      return;
    }
    writeJson(this.paths.frameVectors, { fingerprint, vectors: Object.fromEntries(vectors) });
  }

  readIr(): EditorialIR | undefined {
    if (!existsSync(this.paths.ir)) return undefined;
    const ir = parseOrThrow(EditorialIR, readJson(this.paths.ir), 'ir.json');
    // "A document from an incompatible version is rejected rather than read
    // hopefully" is what the documentation promises, and nothing did it: a
    // schema whose fields are mostly optional or defaulted parses an IR from an
    // older shape happily and hands back something subtly wrong.
    requireCompatible(ir.ir_version, IR_VERSION, 'ir.json', 'oea analyze --force');
    return ir;
  }

  writeIr(ir: EditorialIR): void {
    writeJson(this.paths.ir, ir);
  }

  readEmbeddings(): EmbeddingSet | undefined {
    if (!existsSync(this.paths.embeddings)) return undefined;
    return parseOrThrow(EmbeddingSet, readJson(this.paths.embeddings), 'embeddings.json');
  }

  writeEmbeddings(embeddings: EmbeddingSet): void {
    writeJson(this.paths.embeddings, embeddings);
  }

  readPlan(planId: string): EditPlan | undefined {
    const path = join(this.paths.plansDir, `${planId}.json`);
    if (!existsSync(path)) return undefined;
    const plan = parseOrThrow(EditPlan, readJson(path), `${planId}.json`);
    requireCompatible(plan.edit_plan_version, EDIT_PLAN_VERSION, `${planId}.json`, 'oea plan');
    return plan;
  }

  writePlan(plan: EditPlan): void {
    mkdirSync(this.paths.plansDir, { recursive: true });
    writeJson(join(this.paths.plansDir, `${plan.id}.json`), plan);
  }

  listPlans(): string[] {
    if (!existsSync(this.paths.plansDir)) return [];
    return readdirSync(this.paths.plansDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  }

  latestPlan(): EditPlan | undefined {
    const plans = this.listPlans()
      .map((id) => this.readPlan(id))
      .filter((p): p is EditPlan => p !== undefined);
    if (plans.length === 0) return undefined;
    return plans.sort((a, b) => compareText(a.created_at, b.created_at)).at(-1);
  }
}

const CONTEXT_HEADER = `# What you know that the footage cannot contain.
#
# This file outranks everything the models decide. Nothing here is ever
# overwritten by analysis, and an occasion written here changes which moments
# the edit considers important.
#
`;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new EditorialError('io_error', `could not read ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Writes beside the target and renames.
 *
 * An interrupted compile must not leave an IR that parses as valid but is half
 * of one, because the next run would trust it.
 */
function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}
