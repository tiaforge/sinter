import { defineConfig } from 'vite';
import sinter from '@tiaforge/sinter/vite';

export default defineConfig({
  base: './',
  plugins: [sinter()],
  build: { modulePreload: { polyfill: false } },
});
