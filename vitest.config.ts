import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const src = resolve(import.meta.dirname, 'src');

export default defineConfig({
  resolve: {
    alias: [
      // the core's flags, switchable: each test runs on the smallest core for the pages it mounts (docs/proposals/site-core.md)
      { find: /^\.\/flags\.js$/, replacement: resolve(import.meta.dirname, 'test/core-flags.ts') },
      { find: '@tiaforge-ui/sinter/testing', replacement: `${src}/testing/index.ts` },
      { find: '@tiaforge-ui/sinter/check', replacement: `${src}/check/index.ts` },
      { find: /^@tiaforge-ui\/sinter\/messages\/(.+)$/, replacement: `${src}/messages/$1.ts` },
      { find: /^@tiaforge-ui\/sinter\/messages$/, replacement: `${src}/messages.ts` },
      { find: '@tiaforge-ui/sinter/retry', replacement: `${src}/retry.ts` },
      { find: '@tiaforge-ui/sinter/server', replacement: `${src}/server.ts` },
      { find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` },
      { find: /^@tiaforge-ui\/sinter\/runtime\/(.+)$/, replacement: `${src}/$1.ts` },
      { find: '@tiaforge-ui/sinter', replacement: `${src}/index.ts` },
    ],
  },
  test: {
    environment: 'happy-dom', include: ['test/**/*.test.ts', 'docs/recipes/*.test.ts'],
    // many tests are about warnings: a SINTER_STRICT set for an app's agent or CI must not fail this suite
    // (the strict-mode tests set it themselves)
    env: { SINTER_STRICT: '' },
    setupFiles: ['test/core-flags-setup.ts'],
  },
});
