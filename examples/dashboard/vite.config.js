import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
import api from './server/api.js';

export default defineConfig({
  plugins: [
    // The backend describes itself in server/openapi.yml: every resource is typed from it, and the
    // build checks each expression in index.html against it (typecheck). A wrong field name fails it.
    sinter({ openapi: 'server/openapi.yml', typecheck: true }),
    // The demo backend (server/api.js). Replace it with your API, e.g. server: { proxy: { '/api': 'http://localhost:3000' } }.
    api(),
  ],
});
