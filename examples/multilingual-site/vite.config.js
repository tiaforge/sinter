import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  plugins: [sinter({ localePrefix: true, messages: false, site: 'https://example.com', static: ['index.html', 'about.html', 'docs/**'] })],
});
