/**
 * Fails when `schemas/` is out of date with the TypeScript definitions.
 *
 * Run in CI: a contract that only exists in one language is how the two runtimes
 * drift apart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_NAMES, toJsonSchema, toJsonSchemaBundle } from '@editorial-ir/contracts';

const dir = process.argv[2] ?? 'schemas';
const stale: string[] = [];

function compare(file: string, expected: unknown): void {
  const path = join(dir, file);
  let actual: string;
  try {
    actual = readFileSync(path, 'utf8');
  } catch {
    stale.push(`${file} (missing)`);
    return;
  }
  if (actual !== `${JSON.stringify(expected, null, 2)}\n`) stale.push(file);
}

for (const name of SCHEMA_NAMES) compare(`${name}.schema.json`, toJsonSchema(name));
compare('editorial-ir.bundle.schema.json', toJsonSchemaBundle());

if (stale.length > 0) {
  console.error(`schemas/ is out of date:\n${stale.map((s) => `  - ${s}`).join('\n')}`);
  console.error('\nRun `pnpm schema:export` and commit the result.');
  process.exit(1);
}
console.log(`schemas/ is up to date (${SCHEMA_NAMES.length + 1} files)`);
