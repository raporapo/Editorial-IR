import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, relative, dirname } from 'node:path';

/**
 * Every relative link in every markdown file points at something that exists.
 *
 * Documentation rots quietly: a file is renamed, nothing fails, and the link
 * stays broken until somebody clicks it — which, for a README, is somebody
 * deciding whether to use the project at all. This costs a few milliseconds and
 * it is checked by `pnpm verify`.
 */
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', 'tmp', '.venv', 'example']);
const LINK = /\]\(([^)\s]+?)(?:#[^)]*)?\)/g;

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* markdownFiles(path);
    else if (entry.endsWith('.md')) yield path;
  }
}

const broken = [];
let checked = 0;

for (const file of markdownFiles(process.argv[2] ?? '.')) {
  const contents = readFileSync(file, 'utf8');
  for (const [, link] of contents.matchAll(LINK)) {
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    checked++;
    const target = normalize(join(dirname(file), decodeURIComponent(link)));
    if (!existsSync(target)) broken.push(`${relative('.', file)} -> ${link}`);
  }
}

if (broken.length > 0) {
  console.error(`${broken.length} broken link(s):`);
  for (const entry of broken) console.error(`  ${entry}`);
  process.exit(1);
}
console.log(`${checked} relative link(s) resolve`);
