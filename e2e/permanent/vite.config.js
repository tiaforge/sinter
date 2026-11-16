import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

const pages = ['index', 'b', 'plain', 'off', 'nojs'];

export default defineConfig({
  appType: 'mpa',
  plugins: [sinter({ swap: true })],
  build: { rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) } },
});
