// @vitest-environment node
// A build's pages of their own described without a walk (docs/proposals/redesign-notes/page-walked-once.md): what the
// other pages read of a page before it compiles is its head (`pageHead`: its paths, `data-sn-prefetch="off"`,
// `data-sn-swap="off"`), the rest is its own compile's, read once every page has compiled (the page modules' prefetch
// import, the prefetch module). Each app is built with the route off (`SN_LATE_DESCRIBE=0`: a `describeOnly` compile
// per page) and on, and the two builds must be the same, every file; the test says which route each description took
// (`LATE_STATS`), and the audit (`SN_DESCRIBE_AUDIT=1`) holds.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, afterEach, expect, test } from 'vitest';
import { compile, pageHead } from '../../src/compiler/index.js';
import sinter, { LATE_STATS } from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-late-describe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const saved = { late: process.env.SN_LATE_DESCRIBE, audit: process.env.SN_DESCRIBE_AUDIT };
afterEach(() => {
  for (const [k, v] of [['SN_LATE_DESCRIBE', saved.late], ['SN_DESCRIBE_AUDIT', saved.audit]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const page = (attrs: string, body: string) => `<!doctype html><html lang="en"${attrs}><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

/** an app of `files` (path -> text) */
function app(name: string, files: Record<string, string>) {
  const root = join(dir, name);
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), text); }
  return root;
}

/** the app built with the route off and on: every file of both, and what the route counted */
async function both(root: string, options: Parameters<typeof sinter>[0] = {}) {
  const input = Object.fromEntries(walk(root).filter((f) => f.endsWith('.html') && !f.includes('/src/')).map((f) => [relative(root, f).replace(/\.html$/, ''), f]));
  const once = async (out: string) => {
    const before = { head: LATE_STATS.head, compiled: { ...LATE_STATS.compiled }, rewritten: LATE_STATS.rewritten };
    await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: join(root, '..', out), emptyOutDir: true, minify: false, rollupOptions: { input } }, plugins: [sinter(options)] });
    const files = Object.fromEntries(walk(join(root, '..', out)).map((f) => [relative(join(root, '..', out), f), readFileSync(f, 'utf8')]));
    const compiled = Object.fromEntries(Object.entries(LATE_STATS.compiled).map(([k, n]) => [k, n - (before.compiled[k] ?? 0)]).filter(([, n]) => n));
    return { files, head: LATE_STATS.head - before.head, compiled, rewritten: LATE_STATS.rewritten - before.rewritten };
  };
  process.env.SN_LATE_DESCRIBE = '0';
  const off = await once(`${relative(dir, root)}-off`);
  delete process.env.SN_LATE_DESCRIBE;
  const on = await once(`${relative(dir, root)}-on`);
  expect(Object.keys(on.files).sort()).toEqual(Object.keys(off.files).sort());
  for (const f of Object.keys(off.files)) expect(on.files[f], f).toBe(off.files[f]);
  return { off, on };
}

/** something to run: a page with a module (a page with none prefetches nothing) */
const COUNTER = '<p data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></p>';
const pages = {
  // a page that reads only what its URL says: another page requests its data ahead (its description's `parts`)
  'index.html': page(' data-sn-path="/"', '<a href="/article/1">one</a> <a href="/about">about</a> <a href="/draft">draft</a>' + COUNTER),
  'about.html': page(' data-sn-path="/about"', '<p>about</p>' + COUNTER),
  'article.html': page(' data-sn-path="/article/:id"', '<sn-resource name="a" src="/api/a/{$url.id}"></sn-resource><h1 data-sn-text="a?.title"></h1>'),
  // `data-sn-prefetch="off"` from its layout, and its path too
  'draft.html': '<x-quiet><p>draft</p></x-quiet>',
  'src/layouts/x-quiet.html': page(' data-sn-path="/draft" data-sn-prefetch="off"', '<main><slot></slot></main>'),
};

test('pages of their own: described off their heads, the same files as with a description compiled per page', async () => {
  const { off, on } = await both(app('plain', pages));
  expect(off).toMatchObject({ head: 0, compiled: { off: 4 } });
  expect(on).toMatchObject({ head: 4, compiled: {} });
  // the page modules import the prefetch module (a page has data to request ahead), and it lists that page
  const prefetch = Object.entries(on.files).find(([f]) => /^assets\/prefetch-.*\.js$/.test(f));
  expect(prefetch?.[1]).toContain('/api/a/');
  expect(Object.entries(on.files).filter(([f, t]) => /^assets\/(index|about)-.*\.js$/.test(f) && t.includes('prefetch-')).length).toBe(2);
});

test('no page with data to request ahead: no prefetch import and no prefetch module', async () => {
  const { on } = await both(app('none', { ...pages, 'article.html': page(' data-sn-path="/article/:id"', '<h1 data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></h1>') }));
  expect(on).toMatchObject({ head: 4, compiled: {} });
  expect(Object.keys(on.files).some((f) => f.includes('prefetch'))).toBe(false);
});

test('every page module written before the page with data to request ahead compiled gets its import', async () => {
  // the page with the request compiles last (inputs in order): the others are compiled guessing none and written again
  const files = { ...pages, 'zz.html': page(' data-sn-path="/zz/:id"', '<sn-resource name="z" src="/api/z/{$url.id}"></sn-resource><p data-sn-text="z?.n"></p>'), 'article.html': page(' data-sn-path="/article/:id"', '<h1 data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></h1>') };
  const { on } = await both(app('last', files));
  expect(on.head).toBe(5);
  expect(on.rewritten).toBeGreaterThan(0);
});

test('under the audit: each description compiled beside its head, and each page\'s compile against it', async () => {
  process.env.SN_DESCRIBE_AUDIT = '1';
  const { on } = await both(app('audited', pages));
  expect(on.head).toBe(4);
});

test('what is read as pages compile: compiled descriptions, counted (`prerender: \'auto\'`, swaps)', async () => {
  const auto = await both(app('auto', pages), { prefetch: { html: { prerender: 'auto' } } });
  expect(auto.on).toMatchObject({ head: 0, compiled: { "prerender: 'auto'": 4 } });
  const swaps = await both(app('swaps', pages), { swap: true });
  expect(swaps.on).toMatchObject({ head: 0, compiled: { swaps: 4 } });
  const embed = await both(app('embed', pages), { embed: true });
  expect(embed.on).toMatchObject({ head: 0, compiled: { embed: 4 } });
});

test('a page\'s head is what its description compiles to: its paths and its `off` attributes, through its layout', () => {
  const root = app('head', {
    'src/layouts/x-site.html': page(' data-sn-path="/a /b/:id" data-sn-prefetch="off" data-sn-swap=" off "', '<slot></slot>'),
    'src/layouts/x-bare.html': page('', '<slot></slot>'),
  });
  for (const [file, html] of [
    ['p.html', '<x-site><p>p</p></x-site>'],
    ['q.html', '<x-bare><p>q</p></x-bare>'],
    ['r.html', page(' data-sn-path="/r" data-sn-prefetch="on"', '<p>r</p>')],
    ['s.html', page(' data-sn-path="bad"', '<p>s</p>')],
  ] as const) {
    const options = { root, file: join(root, file), readFile: (f: string) => readFileSync(f, 'utf8'), dev: false, helpers: { module: null, names: [], namespaces: {} }, describeOnly: true } as Parameters<typeof compile>[1];
    const r = compile(html, options), h = pageHead(html, options);
    expect(h, file).toEqual({ path: r.path, prefetchOff: !!r.prefetchOff, swapOff: !!r.swapOff });
  }
});
