// @vitest-environment node
// `sinter({ compileHints: true })`: each page module and the chunk with sinter's core start with V8's
// `//# allFunctionsCalledOnLoad`, their source maps a line further down; without the option, nothing changes.
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
const HINT = '//# allFunctionsCalledOnLoad\n';
const CORE = join(src, 'runtime/app.ts');

/** a written chunk; `entry` from the bundle, `core`: its source map has the core's module */
type Chunk = { f: string; code: string; map: { mappings: string; sources: string[] } | null; entry: boolean; core: boolean };
async function chunks(compileHints: boolean, rollupOptions?: object): Promise<Chunk[]> {
  const dir = join(out, String(compileHints) + (rollupOptions ? '-own' : ''));
  const res = await build({ root, logLevel: 'silent', plugins: [sinter({ compileHints })], resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false, sourcemap: true, ...(rollupOptions ? { rollupOptions } : {}) } });
  const bundle = (Array.isArray(res) ? res : [res]).flatMap((r) => ('output' in r ? r.output : []));
  const assets = join(dir, 'assets');
  return readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => {
    const map = readdirSync(assets).includes(f + '.map') ? JSON.parse(readFileSync(join(assets, f + '.map'), 'utf8')) as Chunk['map'] : null;
    const c = bundle.find((x) => x.fileName === 'assets/' + f);
    return { f, code: readFileSync(join(assets, f), 'utf8'), map, entry: c?.type === 'chunk' && c.isEntry, core: !!map?.sources.some((s) => resolve(assets, s) === CORE) };
  });
}

/** the hinted build against the one without: the page modules and the core's chunk hinted once, their maps a line down, the rest as before */
function compare(off: Chunk[], on: Chunk[]) {
  expect(off.some((c) => c.code.includes('allFunctionsCalledOnLoad'))).toBe(false);
  expect(on.map((c) => c.f).sort()).toEqual(off.map((c) => c.f).sort());
  for (const c of on) {
    const before = off.find((o) => o.f === c.f)!;
    if (!c.entry && !c.core) { expect(c.code, c.f).toBe(before.code); continue; }
    expect(c.code.startsWith(HINT), c.f).toBe(true);
    expect(c.code.split('allFunctionsCalledOnLoad').length, c.f).toBe(2);
    expect(c.code.slice(HINT.length), c.f).toBe(before.code);
    expect(c.map!.mappings, c.f).toBe(';' + before.map!.mappings);
  }
}

test('the page modules start with the hint once (the core bundled into one of them), their source maps shifted by a line; builds without it are as before', async () => {
  const off = await chunks(false), on = await chunks(true);
  // the fixture's one page: the core is in its page module
  expect(on.filter((c) => c.core).map((c) => c.entry)).toEqual([true]);
  compare(off, on);
});

test('the core in a chunk of its own, whatever its name, gets the hint too; the other chunks are as before', async () => {
  const own = { output: { manualChunks: (id: string) => (id === CORE ? 'my-core' : undefined) } };
  const off = await chunks(false, own), on = await chunks(true, own);
  expect(on.filter((c) => c.core).map((c) => [c.entry, c.f.startsWith('my-core-')])).toEqual([[false, true]]);
  expect(on.filter((c) => !c.entry && !c.core).length).toBeGreaterThan(0);
  compare(off, on);
});
