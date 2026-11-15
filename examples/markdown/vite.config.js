import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
import { api } from './api.mjs';

// SINTER_EMBED=1: placeholders for embedded data (server.mjs fills them)
// MEASURE=1: the parser counted (src/md-measured.js in place of src/md.js), for measure.mjs. An alias, not a
// plugin: the early files are bundled with the app's aliases only. md-measured.js imports `./md.js?pure`,
// which it does not match
const MEASURED = resolve(import.meta.dirname, 'src/md-measured.js');
const DECODER = { 'decode-named-character-reference': resolve(import.meta.dirname, 'node_modules/decode-named-character-reference/index.js') };
const pages = ['article', 'comments', 'tree', 'stream', 'island'];
export default defineConfig({
  appType: 'mpa',
  // micromark's entity decoder has a browser build that decodes through innerHTML, which
  // require-trusted-types-for 'script' blocks (the proposal's section 11). DOM_DECODER=1 keeps it.
  resolve: { alias: [
    ...(process.env.DOM_DECODER ? [] : Object.entries(DECODER).map(([find, replacement]) => ({ find, replacement }))),
    ...(process.env.MEASURE ? [{ find: /^(?:\.\/|\/src\/)md\.js$/, replacement: MEASURED }] : []),
  ] },
  plugins: [sinter({ embed: !!process.env.SINTER_EMBED }), api()],
  build: {
    minify: process.env.MINIFY !== '0',
    outDir: process.env.SINTER_EMBED ? 'dist-embed' : 'dist',
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) },
  },
});
