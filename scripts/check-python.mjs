#!/usr/bin/env node
/**
 * The Python half of the verification, when Python is here to run it.
 *
 * CI lints and tests the worker, and `pnpm verify` did not — so the worker's
 * lint went red and stayed red, invisible to anyone who ran the command the
 * guide tells them to run before claiming anything works. It is skipped, out
 * loud, on a machine without Python or without ruff: a contributor working on
 * the TypeScript side should not be required to install a Python toolchain, and
 * silence is what let this rot in the first place.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const WORKER = 'services/perception';

function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'inherit', ...options });
}

function have(command, args) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

if (!existsSync(WORKER)) {
  console.log(`no ${WORKER}; nothing to check`);
  process.exit(0);
}

const python = ['python3', 'python'].find((name) => have(name, ['--version']));
if (!python) {
  console.log('skipped: no python3 on this machine (CI runs it)');
  process.exit(0);
}

let failed = false;

if (have(python, ['-m', 'ruff', '--version'])) {
  if (run(python, ['-m', 'ruff', 'check', WORKER]).status !== 0) failed = true;
} else {
  console.log('skipped: ruff is not installed (pip install ruff)');
}

if (have(python, ['-m', 'pytest', '--version'])) {
  const result = run(python, ['-m', 'pytest', `${WORKER}/tests`, '-q'], {
    env: { ...process.env, PYTHONPATH: `${WORKER}/src` },
  });
  if (result.status !== 0) failed = true;
} else {
  console.log('skipped: pytest is not installed (pip install pytest)');
}

process.exit(failed ? 1 : 0);
