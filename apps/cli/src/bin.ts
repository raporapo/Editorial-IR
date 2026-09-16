#!/usr/bin/env node
import { EditorialError } from '@editorial-ir/contracts';
import { main } from './cli.js';
import { fail, note } from './ui.js';

/**
 * `oea timeline | head` is a normal thing to do, and so is quitting `less`
 * halfway. Both close the pipe while there is still output to write, and Node's
 * default for that is an unhandled 'error' event and a stack trace — which looks
 * exactly like a crash, in response to the user doing nothing wrong.
 *
 * Reading to the end of the pipe is not this program's job. Stop writing and
 * leave, the way every other command line tool does.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

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
