import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  base: './',
  plugins: [sinter()],
  build: { modulePreload: { polyfill: false } },
});
