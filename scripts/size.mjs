// Size budget: min+gzip of the core as a page imports it, and of each feature module.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const dist = resolve(import.meta.dirname, '../dist');
const dir = mkdtempSync(join(tmpdir(), 'sinter-size-'));
const entries = {
  core: `export { mount, $k } from '${dist}/index.js';`,
  sse: `export { default } from '${dist}/sse.js';`,
  optimistic: `export { default } from '${dist}/optimistic.js';`,
  paginate: `export { default } from '${dist}/paginate.js';`,
  persist: `export { default } from '${dist}/persist.js';`,
};
const BUDGET = { core: 5 * 1024 };
let failed = false;
try {
  for (const [name, code] of Object.entries(entries)) {
    const entry = join(dir, `${name}.js`);
    writeFileSync(entry, code);
    const external = name === 'core' ? [] : [/\/runtime\//];
    await build({
      logLevel: 'silent', configFile: false,
      build: { outDir: join(dir, 'out', name), lib: { entry, formats: ['es'], fileName: name }, minify: true, rollupOptions: { external } },
    });
    const js = readFileSync(join(dir, 'out', name, `${name}.js`));
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
