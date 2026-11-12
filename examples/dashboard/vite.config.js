import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
import temper from '@tiaforge-ui/temper/vite';
import api from './server/api.js';

export default defineConfig({
  plugins: [
    // The backend describes itself in server/openapi.yml: every resource is typed from it, and the
    // build checks each expression in index.html against it (typecheck). A wrong field name fails it.
    sinter({ openapi: 'server/openapi.yml', typecheck: true }),
    // Checks the markup's data-* attributes: a wrong value fails the build and warns in dev. `inspect` also audits the
    // rendered page in dev (overflow, contrast, clipped text) and prints findings in the terminal.
    temper({ inspect: true }),
    // The demo backend (server/api.js). Replace it with your API, e.g. server: { proxy: { '/api': 'http://localhost:3000' } }.
    api(),
  ],
});
