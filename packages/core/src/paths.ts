import { join } from 'node:path';

/**
 * The layout of a project directory.
 *
 * Everything the tool writes lives under one hidden directory beside the
 * footage, and everything in it is either recoverable from the media or small
 * enough to read. The originals are never touched, never moved and never
 * rewritten.
 */
export const PROJECT_DIR = '.oea';

export interface ProjectPaths {
  root: string;
  dir: string;
  project: string;
  context: string;
  annotations: string;
  assets: string;
  observations: string;
  /**
   * Frame vectors, beside the observations they belong to.
   *
   * A separate file because they are numbers no human will read in a diff — a
   * one-hour project is tens of megabytes of them — and because
   * `observations.json` is a document somebody may reasonably open.
   */
  frameVectors: string;
  ir: string;
  embeddings: string;
  plansDir: string;
  cacheDir: string;
  workDir: string;
  outputDir: string;
}

export function projectPaths(root: string): ProjectPaths {
  const dir = join(root, PROJECT_DIR);
  return {
    root,
    dir,
    project: join(dir, 'project.json'),
    context: join(dir, 'context.yaml'),
    annotations: join(dir, 'annotations.json'),
    assets: join(dir, 'assets.json'),
    observations: join(dir, 'observations.json'),
    frameVectors: join(dir, 'frame-vectors.json'),
    ir: join(dir, 'ir.json'),
    embeddings: join(dir, 'embeddings.json'),
    plansDir: join(dir, 'plans'),
    // Derivatives: proxies, extracted audio, sampled frames. Safe to delete.
    cacheDir: join(dir, 'cache'),
    workDir: join(dir, 'work'),
    // Where adapters write project files for editing applications.
    outputDir: join(root, 'output'),
  };
}
