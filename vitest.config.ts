import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@editorial-ir/contracts': pkg('contracts'),
      '@editorial-ir/perception': pkg('perception'),
      '@editorial-ir/decision': pkg('decision'),
      '@editorial-ir/index': pkg('index'),
      '@editorial-ir/skills': pkg('skills'),
      '@editorial-ir/core': pkg('core'),
      '@editorial-ir/agent': pkg('agent'),
      '@editorial-ir/adapters': pkg('adapters'),
      '@editorial-ir/cli': fileURLToPath(new URL('./apps/cli/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/index.ts'],
    },
  },
});
