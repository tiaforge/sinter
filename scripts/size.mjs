// Size budget: min+gzip of the core as a page imports it, and of each feature module.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, minify } from 'vite';

const dist = resolve(import.meta.dirname, '../dist');
const dir = mkdtempSync(join(tmpdir(), 'sinter-size-'));
const entries = {
  core: `export { mount, $k } from '${dist}/index.js';`,
  sse: `export { default } from '${dist}/sse.js';`,
  ws: `export { webSocketTransport } from '${dist}/ws.js';`,
  optimistic: `export { default } from '${dist}/optimistic.js';`,
  paginate: `export { default } from '${dist}/paginate.js';`,
  persist: `export { default } from '${dist}/persist.js';`,
  dev: `export { default } from '${dist}/dev.js';`,
  // what the contacts example loads: core + sse + optimistic + persist
  page: `export { mount, $k } from '${dist}/index.js'; export { default as a } from '${dist}/sse.js'; export { default as b } from '${dist}/optimistic.js'; export { default as c } from '${dist}/persist.js';`,
};
const BUDGET = { core: 11 * 1024 };
let failed = false;
try {
  for (const [name, code] of Object.entries(entries)) {
    const entry = join(dir, `${name}.js`);
    writeFileSync(entry, code);
    const external = name === 'core' || name === 'page' ? [] : [/\/runtime\//];
    await build({
      logLevel: 'silent', configFile: false,
      build: { outDir: join(dir, 'out', name), lib: { entry, formats: ['es'], fileName: name }, minify: false, rollupOptions: { external } },
    });
    // lib mode keeps whitespace in ES output; minify fully, as an app build would
    const out = await minify(`${name}.js`, readFileSync(join(dir, 'out', name, `${name}.js`), 'utf8'), { compress: true, mangle: true });
    const js = Buffer.from(out.code);
    const gz = gzipSync(js, { level: 9 }).length;
    const budget = BUDGET[name];
    const over = budget && gz > budget;
    if (over) failed = true;
    console.log(`${name.padEnd(11)} ${String(js.length).padStart(6)} B min  ${String(gz).padStart(6)} B gzip${budget ? `  (budget ${budget})${over ? '  OVER' : ''}` : ''}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failed && process.argv.includes('--check')) process.exit(1);
