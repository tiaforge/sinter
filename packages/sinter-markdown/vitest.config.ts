import { defineConfig } from 'vitest/config';

// The package's tests run against the sinter installed beside it (`file:../..` in this repository: the
// framework's own build, `npm run build` at the root first).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'docs/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // the tests that build apps run one file at a time: each starts Vite
    fileParallelism: false,
    env: { SINTER_STRICT: '' },
  },
});
