import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EditorialError,
  IR_VERSION,
  ProjectContext,
  newId,
  type Project,
} from '@editorial-ir/contracts';
import { FileProjectStore, PROJECT_DIR } from '@editorial-ir/core';

/**
 * Finding the project a command is about.
 *
 * Walks up from the working directory, the way git does, so that running a
 * command from inside `footage/` works. An explicit `--project` always wins.
 */
export function openProject(explicit?: string): FileProjectStore {
  const root = explicit ? resolve(explicit) : findProjectRoot(process.cwd());
  if (!root) {
    throw new EditorialError(
      'not_found',
      'no project here. Run "oea init" to make one, or pass --project <dir>.',
    );
  }
  const store = new FileProjectStore(root);
  if (!store.exists()) {
    throw new EditorialError('not_found', `no project at ${root}. Run "oea init" there first.`);
  }
  return store;
}

export function findProjectRoot(from: string): string | undefined {
  let current = resolve(from);
  for (let depth = 0; depth < 32; depth++) {
    if (existsSync(resolve(current, PROJECT_DIR, 'project.json'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function createProject(
  root: string,
  options: { title?: string; type?: string; now?: () => string } = {},
): FileProjectStore {
  const store = new FileProjectStore(root);
  if (store.exists()) {
    throw new EditorialError('already_exists', `there is already a project at ${root}`);
  }

  const now = (options.now ?? (() => new Date().toISOString()))();
  const project: Project = {
    id: newId('prj'),
    title: options.title ?? basenameOf(root),
    ...(options.type ? { type: options.type } : {}),
    status: 'created',
    ir_version: IR_VERSION,
    created_at: now,
    updated_at: now,
  };

  store.initialise(project, ProjectContext.parse({ project_id: project.id, updated_at: now }));
  return store;
}

function basenameOf(path: string): string {
  const parts = resolve(path).split(/[\\/]/);
  return parts[parts.length - 1] || 'project';
}
