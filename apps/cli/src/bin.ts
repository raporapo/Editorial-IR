#!/usr/bin/env node
import { EditorialError } from '@editorial-ir/contracts';
import { main } from './cli.js';
import { fail, note } from './ui.js';

/** Details can hold anything, and `[object Object]` helps nobody. */
function formatDetail(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => formatDetail(item)).join(', ');
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (EditorialError.is(error)) {
    fail(error.message);
    // Details are the difference between "not found" and "not found, here is
    // what does exist".
    for (const [key, value] of Object.entries(error.details)) {
      if (value === undefined) continue;
      note(`  ${key}: ${formatDetail(value)}`);
    }
    process.exitCode = 1;
  } else {
    fail(error instanceof Error ? error.message : String(error));
    if (process.env.OEA_DEBUG && error instanceof Error && error.stack) note(error.stack);
    process.exitCode = 1;
  }
}
