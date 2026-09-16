/**
 * Writes `schemas/` from the TypeScript definitions.
 *
 * The output is committed. A schema change therefore shows up in review as a
 * diff of the cross-language contract, which is exactly the thing that breaks
 * the Python worker silently if nobody looks at it.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_NAMES, toJsonSchema, toJsonSchemaBundle } from '@editorial-ir/contracts';

const outDir = process.argv[2] ?? 'schemas';

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const name of SCHEMA_NAMES) {
  writeFileSync(
    join(outDir, `${name}.schema.json`),
    `${JSON.stringify(toJsonSchema(name), null, 2)}\n`,
  );
}
writeFileSync(
  join(outDir, 'editorial-ir.bundle.schema.json'),
  `${JSON.stringify(toJsonSchemaBundle(), null, 2)}\n`,
);

console.log(`wrote ${SCHEMA_NAMES.length + 1} schema files to ${outDir}/`);
