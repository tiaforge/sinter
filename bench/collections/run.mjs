// One build of the prototype's app, in this process: prints its time, peak memory and output as JSON.
// node bench/collections/run.mjs <root>
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';

const root = process.argv[2];
const t0 = performance.now();
let error = null;
try { await build({ root, configFile: join(root, 'vite.config.js') }); } catch (e) { error = String(e?.message ?? e).slice(0, 2000); }
const ms = performance.now() - t0;
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = error ? [] : walk(join(root, 'dist'));
const of = (re) => files.filter((f) => re.test(f));
const size = (fs) => fs.reduce((a, f) => a + statSync(f).size, 0);
console.log(JSON.stringify({
  ms: Math.round(ms), maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024), error,
  html: of(/\.html$/).length, htmlMb: +(size(of(/\.html$/)) / 1e6).toFixed(1),
  js: of(/\.js$/).length, jsKb: Math.round(size(of(/\.js$/)) / 1e3), files: files.length,
}));
