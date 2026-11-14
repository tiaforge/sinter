import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
import temper from '@tiaforge-ui/temper/vite';
import api from './server/api.js';

export default defineConfig({
  appType: 'mpa',
  plugins: [
    // Compiles the data-sn-* pages; typecheck: every expression is checked against src/sinter.types.ts in `vite build`.
    // strict: warnings fail the build, `sinter check` and the dev server's page (docs/strict.md). Keep a code a warning
    // with its reason, strict: { allow: { SN504: 'why' } }, rather than turning strict off.
    sinter({ typecheck: true, strict: true }),
    // temper check on the markup: a wrong data-* value fails the build, the dev server warns. `inspect` also audits
    // the rendered page in dev (overflow, contrast, clipped text) and prints findings in the terminal.
    temper({ inspect: true }),
    // The demo backend (server/api.js). Replace it with your API, e.g. server: { proxy: { '/api': 'http://localhost:3000' } }.
    api(),
  ],
  build: {
    // One entry per page: a sinter app is a multi-page app.
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        task: resolve(import.meta.dirname, 'task.html'),
      },
    },
  },
});
