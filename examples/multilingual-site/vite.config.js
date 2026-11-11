import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

const pages = ['index', 'about', 'docs/getting-started', 'status'];

export default defineConfig({
  appType: 'mpa',
  plugins: [sinter({ localePrefix: true, site: 'https://example.com', static: ['index.html', 'about.html', 'docs/**'] })],
  build: {
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) },
  },
});
