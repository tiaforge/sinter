import { defineConfig } from 'vite';
import { ivi } from '@ivi/rolldown';

// the ivi reference page for self.mjs: npx vite build -c vite.ivi.config.js → dist-ivi/
export default defineConfig({
  root: 'ivi',
  base: './',
  plugins: [ivi({ filter: { id: /\.js$/ } })],
  build: { outDir: '../dist-ivi', emptyOutDir: true, modulePreload: { polyfill: false } },
});
