import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Copies the worked example into the package, just before it is packed.
 *
 * `oea demo` is the first command in the README and the only one that needs no
 * footage of your own, so it has to work on a fresh `npm i -g @editorial-ir/cli`.
 * It cannot be a committed copy inside the package, because then the example the
 * tests compile and the example users get would drift apart; and `files` cannot
 * reach outside the package directory. So it is copied at pack time, from the
 * one source of truth, and the `package` CI job installs the tarball and runs
 * `oea demo` to prove it arrived.
 */
const source = fileURLToPath(new URL('../../../examples/anniversary-trip', import.meta.url));
const target = fileURLToPath(new URL('../example', import.meta.url));

if (!existsSync(source)) {
  console.error(`bundle-example: nothing at ${source}`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`bundle-example: ${source} -> ${target}`);
