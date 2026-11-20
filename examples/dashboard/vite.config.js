import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
import temper from '@tiaforge-ui/temper/vite';
import api from './server/api.js';

export default defineConfig({
  // two pages: the header links them; with swaps on, a link swaps the next page in and the layout's player and
  // notes stay (data-sn-permanent)
  plugins: [
    // The backend describes itself in server/openapi.yml: every resource is typed from it, and the
    // build checks each expression in index.html against it (typecheck). A wrong field name fails it.
    // the API: paths on the page (`src="/services"`) are relative to its base, `/api` (the spec's server), and
    // checked against the spec; the event stream is not in the spec, so it is declared here
    sinter({ apis: { dashboard: { openapi: 'server/openapi.yml', operations: { 'GET /events': {} } } }, typecheck: true, swap: true }),
    // Checks the markup's data-* attributes: a wrong value fails the build and warns in dev. `inspect` also audits the
    // rendered page in dev (overflow, contrast, clipped text) and prints findings in the terminal.
    temper({ inspect: true }),
    // The demo backend (server/api.js). Replace it with your API, e.g. server: { proxy: { '/api': 'http://localhost:3000' } }.
    api(),
  ],
});
