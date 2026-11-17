import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

const pages = ['article', 'tree', 'island'];
export default defineConfig({
  appType: 'mpa',
  plugins: [sinter({ components: ['@tiaforge-ui/sinter-markdown'] })],
  // sinter-markdown is linked from packages/ (file:): its imports of sinter resolve to this app's
  resolve: { dedupe: ['@tiaforge-ui/sinter'] },
  build: { rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) } },
});
