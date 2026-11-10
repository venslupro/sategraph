import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Workspace packages are consumed as TypeScript source, so tests alias them. */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@satgraph\/([a-z-]+)$/, replacement: `${root}packages/$1/src/index.ts` },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts'],
    reporters: ['default'],
  },
});
