import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

const pages = ['index', 'about', 'docs/getting-started', 'status'];

export default defineConfig({
  appType: 'mpa',
  // the pages with nothing to run must stay that way: a handler in a shared component would fail the build (SN322)
  plugins: [sinter({ static: ['index.html', 'about.html', 'docs/**'] })],
  build: {
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) },
  },
});
