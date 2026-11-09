import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

const pages = ['index', 'item'];

export default defineConfig({
  appType: 'mpa',
  // the strict setup: rules from a response header, so the pages run under script-src 'self' (server.mjs)
  plugins: [sinter({ speculation: { mode: 'prefetch', delivery: 'header' } })],
  build: { rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) } },
});
