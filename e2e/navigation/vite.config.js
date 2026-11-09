import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

const pages = ['index', 'item'];

export default defineConfig({
  appType: 'mpa',
  // the defaults: inline Speculation Rules, allowed by the hash the build adds to the pages' CSP <meta>
  plugins: [sinter()],
  build: { rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) } },
});
