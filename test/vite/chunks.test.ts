// @vitest-environment node
// The chunk policy of multi-page builds (`sinter({ chunks })`): small shared chunks copied into the
// pages, large ones shared, lazy chunks lazy, Rolldown's runtime helpers in the `sinter` chunk.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as http } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromium } from '../browser.js';
import sinter, { type SinterOptions } from '../../src/vite.js';
import { codeSplitting, mergeRuntime } from '../../src/chunks-build.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-chunks-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const page = (name: string) => `<!doctype html><html><head><title>${name}</title><script type="module" src="./${name}.js"></script></head><body><div data-sn-state="{ n: 1 }"><p data-sn-text="n + 1"></p></div><output></output></body></html>`;
beforeAll(() => {
  // a and c use a small module, a and b a large one; a also loads a lazy module that shares `box` with it
  writeFileSync(join(root, 'tiny.js'), "let n = 0;\nexport const tiny = () => 'tiny-marker ' + ++n;\n");
  writeFileSync(join(root, 'big.js'), `export const big = ${JSON.stringify(Array.from({ length: 800 }, (_, i) => `big-marker-${i}`))};\n`);
  writeFileSync(join(root, 'box.js'), "export const box = { v: 'box-marker' };\n");
  writeFileSync(join(root, 'lazy.js'), "import { box } from './box.js';\nexport const lazy = () => { box.v = 'lazy-marker'; };\n");
  writeFileSync(join(root, 'a.js'), "import { tiny } from './tiny.js';\nimport { big } from './big.js';\nimport { box } from './box.js';\n// the page bundle is async: it may run before the body is parsed\nimport('./lazy.js').then(async (m) => { m.lazy(); if (document.readyState === 'loading') await new Promise((r) => addEventListener('DOMContentLoaded', r)); document.querySelector('output').textContent = [tiny(), big.length, box.v].join(' '); });\n");
  writeFileSync(join(root, 'b.js'), "import { big } from './big.js';\nimport { box } from './box.js';\nconst show = () => { document.querySelector('output').textContent = [big.length, box.v].join(' '); };\nif (document.readyState === 'loading') addEventListener('DOMContentLoaded', show); else show();\n");
  writeFileSync(join(root, 'c.js'), "import { tiny } from './tiny.js';\nconst show = () => { document.querySelector('output').textContent = tiny(); };\nif (document.readyState === 'loading') addEventListener('DOMContentLoaded', show); else show();\n");
  for (const p of ['a', 'b', 'c']) writeFileSync(join(root, `${p}.html`), page(p));
});

async function run(name: string, options: SinterOptions = {}) {
  const out = join(root, name);
  await build({
    root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ images: false, ...options })],
    build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { a: join(root, 'a.html'), b: join(root, 'b.html'), c: join(root, 'c.html') } } },
  });
  const files = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'));
  const code = Object.fromEntries(files.map((f) => [f, readFileSync(join(out, 'assets', f), 'utf8')]));
  const html = Object.fromEntries(['a', 'b', 'c'].map((p) => [p, readFileSync(join(out, `${p}.html`), 'utf8')]));
  /** the files whose code contains `marker` */
  const having = (marker: string) => files.filter((f) => code[f]!.includes(marker));
  /** what a page loads up front: its scripts and modulepreload links */
  const loads = (p: string) => [...html[p]!.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]!);
  return { out, files, code, html, having, loads };
}

describe('codeSplitting', () => {
  const es = {};
  test('a multi-page ES build: the runtime group and inlining below minSize', () => {
    expect(codeSplitting({}, es, 3, false)).toMatchObject({ groups: [{ minShareCount: 2, tags: ['$initial'] }], experimentalInlineCommonChunks: { maxSize: 10_000 } });
    expect(codeSplitting({ minSize: 4000 }, es, 3, false)).toMatchObject({ experimentalInlineCommonChunks: { maxSize: 4000 } });
    expect(codeSplitting({ minSize: 0 }, es, 3, false)).not.toHaveProperty('experimentalInlineCommonChunks');
    expect(codeSplitting({ runtime: false }, es, 3, false)).not.toHaveProperty('groups');
    expect(codeSplitting({ minSize: 0, runtime: false }, es, 3, false)).toBeNull();
  });
  test('left alone: one page, other formats, chunking the app configures, entry signatures kept', () => {
    expect(codeSplitting({}, es, 1, false)).toBeNull();
    expect(codeSplitting({}, { format: 'iife' }, 3, false)).toBeNull();
    for (const own of [{ codeSplitting: false }, { codeSplitting: { groups: [] } }, { advancedChunks: {} }, { manualChunks: () => null }]) expect(codeSplitting({}, own, 3, false)).toBeNull();
    // inlining needs `preserveEntrySignatures: false`; the group does not
    expect(codeSplitting({}, es, 3, 'strict')).not.toHaveProperty('experimentalInlineCommonChunks');
  });
});

test('mergeRuntime: the helpers move into the sinter chunk, which keeps its name; unknown imports leave the bundle as it is', async () => {
  const rt = { type: 'chunk' as const, fileName: 'assets/rolldown-runtime-AAAAAAAA.js', name: 'rolldown-runtime', code: 'var e=1,t=e=>e+1;export{t as n,e as t};', isEntry: false, isDynamicEntry: false, imports: [], dynamicImports: [], moduleIds: ['\0rolldown/runtime.js'] };
  const host = { type: 'chunk' as const, fileName: 'assets/sinter-BBBBBBBB.js', name: 'sinter', code: 'import{n as e}from"./rolldown-runtime-AAAAAAAA.js";const r=e(1);export{r as t};', isEntry: false, isDynamicEntry: false, imports: [rt.fileName], dynamicImports: [], moduleIds: ['/x/runtime/app.js'] };
  const page = { type: 'chunk' as const, fileName: 'assets/a-CCCCCCCC.js', name: 'a', code: 'const __vite__mapDeps=["assets/rolldown-runtime-AAAAAAAA.js"];import{n as e,t}from"./rolldown-runtime-AAAAAAAA.js";import{t as r}from"./sinter-BBBBBBBB.js";console.log(e(t),r);', isEntry: true, isDynamicEntry: false, imports: [rt.fileName, host.fileName], dynamicImports: [], moduleIds: ['/x/a.js'] };
  const bundle = () => Object.fromEntries([rt, host, page].map((c) => [c.fileName, { ...c, imports: [...c.imports] }]));
  const b = bundle();
  expect(mergeRuntime(b)).toBe(true);
  expect(Object.keys(b)).toEqual([host.fileName, page.fileName]);
  // the host imports nothing now: it runs as it is, and exports the helpers too
  const exports = await import(`data:text/javascript,${encodeURIComponent(b[host.fileName]!.code)}`);
  expect(exports.t).toBe(2);
  expect(exports.__sinter_rt_n(1)).toBe(2);
  expect(b[page.fileName]!.code).toContain('import{__sinter_rt_n as e,__sinter_rt_t as t}from"./sinter-BBBBBBBB.js"');
  expect(b[page.fileName]!.code).toContain('["assets/sinter-BBBBBBBB.js"]');
  expect((b[page.fileName] as typeof page).imports).toEqual([host.fileName]);
  expect((b[host.fileName] as typeof host).imports).toEqual([]);
  // a namespace import of the helpers: nothing changes
  const c = bundle();
  (c[page.fileName] as typeof page).code += 'import*as x from"./rolldown-runtime-AAAAAAAA.js";';
  expect(mergeRuntime(c)).toBe(false);
  expect(Object.keys(c)).toHaveLength(3);
  expect(c[host.fileName]!.code).toBe(host.code);
});

test('a small shared chunk is copied into the pages, a large one stays shared, a lazy one stays lazy', async () => {
  const r = await run('default');
  // tiny.js: in the bundles of a and c, no file of its own
  const tiny = r.having('tiny-marker');
  expect(tiny).toHaveLength(2);
  for (const f of tiny) expect(['a', 'c'].filter((p) => r.loads(p).includes(f))).toHaveLength(1);
  for (const f of tiny) expect(r.loads('b')).not.toContain(f);
  // big.js: one shared chunk, preloaded by both pages, not by c
  const big = r.having('big-marker-799');
  expect(big).toHaveLength(1);
  expect(r.loads('a')).toContain(big[0]);
  expect(r.loads('b')).toContain(big[0]);
  expect(r.loads('c')).not.toContain(big[0]);
  // the lazy module: a file of its own that no page loads up front
  const lazy = r.having('lazy-marker');
  expect(lazy).toHaveLength(1);
  for (const p of ['a', 'b', 'c']) expect(r.loads(p)).not.toContain(lazy[0]);
  // box.js, which the lazy chunk uses too, is not copied into it: the lazy chunk takes page a's (one instance, checked below)
  expect(r.having('box-marker')).not.toContain(lazy[0]);
  // sinter's runtime: one chunk for every page, with Rolldown's helpers in it (no file of their own)
  const runtime = r.files.filter((f) => /^sinter-[\w-]{8}\.js$/.test(f));
  expect(runtime).toHaveLength(1);
  for (const p of ['a', 'b', 'c']) expect(r.loads(p)).toContain(runtime[0]);
  expect(r.files.filter((f) => f.startsWith('rolldown-runtime'))).toEqual([]);
  expect(Object.values(r.code).join('\n')).not.toContain('rolldown-runtime');

  if (!chromium) return;
  const server = http((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    try {
      const body = readFileSync(join(r.out, path));
      res.setHeader('Content-Type', path.endsWith('.html') ? 'text/html' : 'text/javascript');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const shown: Record<string, string> = {};
    for (const p of ['a', 'b', 'c']) {
      await tab.goto(`${base}/${p}.html`);
      await tab.waitForFunction(() => document.querySelector('output')!.textContent !== '');
      shown[p] = await tab.evaluate(() => `${document.querySelector('output')!.textContent} | ${document.querySelector('p')!.textContent}`);
      const failed = await tab.evaluate(() => performance.getEntriesByType('resource').filter((e) => (e as PerformanceResourceTiming).responseStatus >= 400).map((e) => e.name));
      expect(failed).toEqual([]);
    }
    // the lazy chunk changed the one `box` page a has
    expect(shown).toEqual({ a: 'tiny-marker 1 800 lazy-marker | 2', b: '800 box-marker | 2', c: 'tiny-marker 1 | 2' });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.close();
  }
}, 60_000);

test('`chunks: false`: Vite\'s chunks, the small one shared, no sinter chunk', async () => {
  const r = await run('off', { chunks: false });
  const tiny = r.having('tiny-marker');
  expect(tiny).toHaveLength(1);
  for (const p of ['a', 'c']) expect(r.loads(p)).toContain(tiny[0]);
  expect(r.files.some((f) => /^sinter-[\w-]{8}\.js$/.test(f))).toBe(false);
});

test('`minSize: 0`: nothing copied, sinter\'s runtime still one chunk', async () => {
  const r = await run('no-inline', { chunks: { minSize: 0 } });
  expect(r.having('tiny-marker')).toHaveLength(1);
  expect(r.files.filter((f) => /^sinter-[\w-]{8}\.js$/.test(f))).toHaveLength(1);
  expect(r.files.some((f) => f.startsWith('rolldown-runtime'))).toBe(false);
});
