import { defineConfig } from 'vitest/config';

// `npm run bench`: timed runs, one file at a time, printed as tables (not part of `npm test`)
export default defineConfig({
  test: {
    root: import.meta.dirname, environment: 'happy-dom', include: ['*.bench.ts'],
    fileParallelism: false, testTimeout: 120_000, silent: false,
  },
});
