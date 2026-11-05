import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge/sinter/vite';

const pages = ['sse', 'ws', 'signalr'];

export default defineConfig({
  appType: 'mpa',
  plugins: [sinter()],
  build: { rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) } },
});
