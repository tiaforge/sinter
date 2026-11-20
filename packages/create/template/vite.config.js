import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
import temper from '@tiaforge-ui/temper/vite';
import api from './server/api.js';

export default defineConfig({
  plugins: [
    // Compiles the data-sn-* pages; with TypeScript installed, `vite build` checks every expression against src/sinter.types.ts.
    // strict: warnings fail the build, `sinter check` and the dev server's page (docs/strict.md). Keep a code a warning
    // with its reason, strict: { allow: { SN504: 'why' } }, rather than turning strict off.
    sinter({ strict: true }),
    // temper check on the markup: a wrong data-* value fails the build, the dev server warns. `inspect` also audits
    // the rendered page in dev (overflow, contrast, clipped text) and prints findings in the terminal.
    temper({ inspect: true }),
    // The demo backend (server/api.js). Replace it with your API, e.g. server: { proxy: { '/api': 'http://localhost:3000' } }.
    api(),
  ],
});
