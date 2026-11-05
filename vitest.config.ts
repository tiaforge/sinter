import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const src = resolve(import.meta.dirname, 'src');

export default defineConfig({
  resolve: {
    alias: [
      { find: '@tiaforge/sinter/testing', replacement: `${src}/testing/index.ts` },
      { find: '@tiaforge/sinter/check', replacement: `${src}/check/index.ts` },
      { find: '@tiaforge/sinter', replacement: `${src}/index.ts` },
    ],
  },
  test: { environment: 'happy-dom', include: ['test/**/*.test.ts', 'docs/recipes/*.test.ts'] },
});
