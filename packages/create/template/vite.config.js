import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
import temper from '@tiaforge-ui/temper/vite';
import api from './server/api.js';

export default defineConfig({
  appType: 'mpa',
  plugins: [
    // Compiles the data-sn-* pages; typecheck: every expression is checked against src/sinter.types.ts in `vite build`.
    sinter({ typecheck: true }),
    // temper check on the markup: a wrong data-* value fails the build, the dev server warns.
    temper(),
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
