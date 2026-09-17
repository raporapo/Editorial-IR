import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  compareText,
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

  readIr(): EditorialIR | undefined;
  writeIr(ir: EditorialIR): void;

  readEmbeddings(): EmbeddingSet | undefined;
  writeEmbeddings(embeddings: EmbeddingSet): void;

  readPlan(planId: string): EditPlan | undefined;
  writePlan(plan: EditPlan): void;
  listPlans(): string[];
  latestPlan(): EditPlan | undefined;
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

  readIr(): EditorialIR | undefined {
    if (!existsSync(this.paths.ir)) return undefined;
    return parseOrThrow(EditorialIR, readJson(this.paths.ir), 'ir.json');
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
    return parseOrThrow(EditPlan, readJson(path), `${planId}.json`);
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
