import { defineConfig } from 'vite';
import sinter from '@tiaforge/sinter/vite';

// Builds the sinter variant (sinter/index.html → dist/index.html); the other variants are static pages.
export default defineConfig({
  root: 'sinter',
  base: '/sinter/',
  plugins: [sinter()],
  build: {
    outDir: '../dist', emptyOutDir: true, modulePreload: { polyfill: false },
    // the harness gets its own chunk so the library size (run.mjs) leaves it out
    rollupOptions: { output: { manualChunks: (id) => (id.includes('/pages/') ? 'harness' : undefined) } },
  },
  server: { fs: { allow: ['..'] } },
});
