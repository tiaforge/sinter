import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const src = resolve(import.meta.dirname, 'src');

export default defineConfig({
  resolve: {
    alias: [
      { find: '@tiaforge-ui/sinter/testing', replacement: `${src}/testing/index.ts` },
      { find: '@tiaforge-ui/sinter/check', replacement: `${src}/check/index.ts` },
      { find: '@tiaforge-ui/sinter', replacement: `${src}/index.ts` },
    ],
  },
  test: { environment: 'happy-dom', include: ['test/**/*.test.ts', 'docs/recipes/*.test.ts'] },
});
