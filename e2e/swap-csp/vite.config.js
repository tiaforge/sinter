import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

const pages = ['index', 'b'];

export default defineConfig({
  appType: 'mpa',
  // each language its own pages (/en/, /de/): the pages' text is in their HTML, nothing is loaded for it
  plugins: [sinter({ swap: true, localePrefix: true })],
  build: { rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) } },
});
