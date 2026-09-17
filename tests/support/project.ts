import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IR_VERSION, newId, ProjectContext } from '@editorial-ir/contracts';
import { FileProjectStore, MemoryCache, ingestPaths, placeAssets } from '@editorial-ir/core';
import {
  HashingTextEmbedding,
  createFixtureSuite,
  PerceptionFixture,
} from '@editorial-ir/perception';
import { parse as parseYaml } from 'yaml';

/** The committed worked example, copied into a temporary directory per test. */
export const EXAMPLE_DIR = fileURLToPath(
  new URL('../../examples/anniversary-trip', import.meta.url),
);

export function readExampleFixture(): PerceptionFixture {
  return PerceptionFixture.parse(
    JSON.parse(readFileSync(join(EXAMPLE_DIR, 'perception.fixture.json'), 'utf8')),
  );
}

export function exampleSuite() {
  const suite = createFixtureSuite(readExampleFixture());
  return { ...suite, text: new HashingTextEmbedding() };
}

/** Copies the example into a scratch directory and ingests it. */
export async function makeExampleProject(): Promise<FileProjectStore> {
  const root = mkdtempSync(join(tmpdir(), 'editorial-ir-'));
  cpSync(join(EXAMPLE_DIR, 'footage'), join(root, 'footage'), { recursive: true });

  const store = new FileProjectStore(root, new MemoryCache());
  const now = '2026-05-17T09:00:00.000Z';
  const project = {
    id: newId('prj'),
    title: '大阪1周年旅行',
    type: 'travel_vlog',
    status: 'created' as const,
    ir_version: IR_VERSION,
    created_at: now,
    updated_at: now,
  };

  const context = ProjectContext.parse({
    ...(parseYaml(readFileSync(join(EXAMPLE_DIR, 'context.yaml'), 'utf8')) as Record<
      string,
      unknown
    >),
    project_id: project.id,
  });

  store.initialise(project, context);

  const suite = exampleSuite();
  const result = await ingestPaths([join(root, 'footage')], {
    projectRoot: root,
    probe: suite.probe,
    cache: store.cache,
  });
  store.writeAssets(result.assets);

  return store;
}

export { placeAssets };
