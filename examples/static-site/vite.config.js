import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  // the pages with nothing to run must stay that way: a handler in a shared component would fail the build (SN322)
  plugins: [sinter({ static: ['index.html', 'about.html', 'docs/**'] })],
});
