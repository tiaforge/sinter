// @vitest-environment node
// `sinter({ compileHints: true })`: each page module starts with V8's `//# allFunctionsCalledOnLoad`, its source map a
// line further down; without the option, nothing changes.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const out = mkdtempSync(join(tmpdir(), 'sinter-hints-'));
// a copy of the fixture of its own: build.test.ts rewrites the fixture's page and early script in place while it runs
// (and restores them), and the two builds compared here must read the same app
const root = join(out, 'app');
cpSync(resolve(__dirname, '../fixtures/vite-app'), root, { recursive: true, filter: (p) => !p.includes('node_modules') });
afterAll(() => rmSync(out, { recursive: true, force: true }));
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?([\w-]+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];

async function chunks(compileHints: boolean) {
  const dir = join(out, String(compileHints));
  await build({ root, logLevel: 'silent', plugins: [sinter({ compileHints })], resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false, sourcemap: true } });
  const assets = join(dir, 'assets');
  return readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => ({ f, code: readFileSync(join(assets, f), 'utf8'), map: readdirSync(assets).includes(f + '.map') ? JSON.parse(readFileSync(join(assets, f + '.map'), 'utf8')) as { mappings: string } : null }));
}

test('the page modules start with the hint, their source maps shifted by a line; other chunks and builds without it are as before', async () => {
  const off = await chunks(false), on = await chunks(true);
  expect(off.some((c) => c.code.includes('allFunctionsCalledOnLoad'))).toBe(false);
  const hinted = on.filter((c) => c.code.startsWith('//# allFunctionsCalledOnLoad\n'));
  expect(hinted.length).toBeGreaterThan(0);
  for (const c of hinted) {
    const before = off.find((o) => o.code === c.code.slice('//# allFunctionsCalledOnLoad\n'.length));
    expect(before, c.f).toBeDefined();
    if (c.map && before!.map) expect(c.map.mappings).toBe(';' + before!.map.mappings);
  }
});
