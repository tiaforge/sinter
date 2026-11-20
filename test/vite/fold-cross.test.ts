// @vitest-environment node
// The build's cross-check of build-time helper calls (src/fold-cross.ts): a build shares one instance
// of the helpers module across its pages, each browser page has its own. A helper whose result
// depends on the calls before it (state kept in a container, however it is reached) would give each
// page what the build's page order made of it: the calls run again at the end in a fresh instance,
// the pages in reverse order, and a difference fails the build (SN534). Pure helpers, a memo cache
// included, fold as before.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { crossCheck, crossMessage, hashOf } from '../../src/fold-cross.js';
import { resultKey } from '../../src/compiler/compile.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-fold-cross-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** a project with these helpers and one page per argument, each calling `calls` over its own argument */
async function buildApp(helpers: Record<string, string>, calls: string[], args = ['home', 'about', 'c']) {
  const root = join(tmp, `app-${n++}`);
  const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
  for (const [f, s] of Object.entries(helpers)) put(f, s);
  const input: Record<string, string> = {};
  args.forEach((a, i) => {
    const f = `p${i}.html`;
    put(f, `<!doctype html><html><head><title>${a}</title></head><body><main>${calls.map((c) => `<p class="${c}" data-sn-text="${c}('${a}')"></p>`).join('')}</main></body></html>`);
    input[`p${i}`] = join(root, f);
  });
  let error: string | null = null;
  try {
    await build({ root, logLevel: 'silent', plugins: [sinter({ static: true })], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input } } });
  } catch (e) { error = (e as Error).message; }
  const html = (i: number) => { try { return readFileSync(join(root, 'dist', `p${i}`, 'index.html'), 'utf8'); } catch { return ''; } };
  return { error, html };
}

describe('state kept between calls, however it is reached, fails the build', () => {
  const helpers = {
    'src/sinter.helpers.ts': `import { table } from './lib/table.ts';
import * as U from './lib/table.ts';
const ids = new Map<string, number>();
export function idOf(s: string) { if (!ids.has(s)) ids.set(s, ids.size + 1); return ids.get(s)!; }
const state = { list: [] as string[], ids: {} as Record<string, number>, n: 0 };
export function pushed(s: string) { if (!state.list.includes(s)) state.list.push(s); return state.list.indexOf(s) + 1; }
export function counted(s: string) { return (state.ids[s] ??= ++state.n); }
const cache = new Map<string, number>();
export function aliased(s: string) { const t = cache; if (!t.has(s)) t.set(s, t.size + 1); return t.get(s)!; }
export function imported(s: string) { if (!table.has(s)) table.set(s, table.size + 1); return table.get(s)!; }
const keyed = new Map<string, number>();
export function computed(s: string) { if (!keyed.has(s)) keyed['set'](s, keyed.size + 1); return keyed.get(s)!; }
const assigned: Record<string, number> = {};
export function merged(s: string) { if (!(s in assigned)) Object.assign(assigned, { [s]: Object.keys(assigned).length + 1 }); return assigned[s]!; }
export function viaNamespace(s: string) { if (!U.other.has(s)) U.other.set(s, U.other.size + 1); return U.other.get(s)!; }
`,
    'src/lib/table.ts': 'export const table = new Map<string, number>();\nexport const other = new Map<string, number>();\n',
  };
  const all = ['idOf', 'pushed', 'counted', 'aliased', 'imported', 'computed', 'merged', 'viaNamespace'];

  test('SN534 names each helper, the arguments and the page', async () => {
    const { error } = await buildApp(helpers, all);
    expect(error).toMatch(/error SN534 helper-not-folded: .* gave other results when the build's calls ran again in a fresh copy of the helpers module, the pages in reverse order/);
    for (const h of all) expect(error, h).toContain(`${h}()`);
    // each page alone gives 1 in the browser; the build's pages compile in the order their HTML loads, which is not fixed,
    // and the fresh copy runs them in reverse: the first and the last page differ, whichever they are. The message names
    // the call, its own page (each page calls `idOf` over its own argument) and the build's result
    expect(error).toMatch(/idOf\((?:"home"\) on p0|"about"\) on p1|"c"\) on p2)\.html: another result than in the build \(\d\) in a fresh copy of the helpers module/);
  }, 120_000);
});

test('pure helpers fold as before: a memo cache, a method named like a container\'s', async () => {
  const { error, html } = await buildApp({
    'src/sinter.helpers.ts': `const memo = new Map<string, number>();
export function len(s: string) { if (!memo.has(s)) memo.set(s, s.length); return memo.get(s)!; }
const set = { add: (a: number, b: number) => a + b };
export function plus(s: string) { return set.add(s.length, 1); }
`,
  }, ['len', 'plus']);
  expect(error).toBe(null);
  expect(html(0)).toContain('<p class="len">4</p><p class="plus">5</p>');
  expect(html(1)).toContain('<p class="len">5</p><p class="plus">6</p>');
}, 120_000);

test('a helper that returns undefined, a call over another call\'s result, a counter called twice on one page', async () => {
  const root = join(tmp, `app-${n++}`);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), `export function maybe(s: string) { return s === 'x' ? 'yes' : undefined; }
export function parse(s: string) { return { words: s.split('') }; }
export function count(doc: { words: string[] }) { return doc.words.length; }
const st = { n: 0 };
export function uid(p: string) { return p + ++st.n; }
`);
  writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><title>x</title></head><body><main data-sn-state="{ s: 'abc' }" data-sn-let="{ doc: parse(s) }">
<i class="m" data-sn-text="maybe('y') ?? 'none'"></i><b class="c" data-sn-text="count(doc)"></b><u class="u" data-sn-text="uid('f') + uid('f') + uid('g')"></u></main></body></html>`);
  let err: string | null = null;
  try { await build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true } }); } catch (e) { err = (e as Error).message; }
  expect(err).toBe(null);
  const out = readFileSync(join(root, 'dist/index.html'), 'utf8');
  // undefined is a result like any other (no false SN534); the chain folds and replays
  expect(out).toContain('<i class="m">none</i>');
  expect(out).toContain('<b class="c">3</b>');
  // uid() gives another result the second time: it stays in the browser
  expect(out).not.toMatch(/<u class="u">f1/);
  expect(out).toMatch(/<u class="u" data-sn=/);
}, 120_000);

test('crossCheck: the pages in reverse order, in a module instance of its own; a helper that throws there is a difference', () => {
  let n = 0;
  const m = { next: () => ++n, fmt: { same: (s: string) => s.toUpperCase() }, boom: () => { throw new Error('no'); } };
  const h = (v: unknown) => hashOf(resultKey(v));
  const bad = crossCheck(m, [
    ['a.html', [{ key: 'next', args: [], hash: h(1), id: 0 }, { key: 'fmt$same', args: [{ v: 'x' }], hash: h('X'), id: 1 }]],
    ['b.html', [{ key: 'next', args: [], hash: h(2), id: 0 }, { key: 'boom', args: [], hash: h(0), id: 1 }]],
  ]);
  expect(bad.map((b) => [b.page, b.key, b.got])).toEqual([['b.html', 'next', '1'], ['b.html', 'boom', 'threw (no)'], ['a.html', 'next', '2']]);
  expect(crossMessage(bad)).toMatch(/^next\(\), boom\(\) gave other results .*\n {2}next\(\) on b\.html: another result than in the build \(1\) in a fresh copy/);
  // an argument that was another call's result is that call's result in the replay
  const chain = crossCheck({ parse: (s: string) => ({ w: s.split('') }), len: (d: { w: string[] }) => d.w.length }, [
    ['c.html', [{ key: 'parse', args: [{ v: 'ab' }], hash: h({ w: ['a', 'b'] }), id: 0 }, { key: 'len', args: [{ r: 0 }], hash: h(2), id: 1 }]],
  ]);
  expect(chain).toEqual([]);
});

test('under `vite build --watch`, each build has a fresh copy of the helpers module: an edit counts, nothing carries over', async () => {
  const root = join(tmp, `app-${n++}`);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), 'const seen = new Map<string, number>();\nexport function idOf(s: string) { if (!seen.has(s)) seen.set(s, seen.size + 1); return seen.get(s)! * 10; }\n');
  writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><title>x</title></head><body><main><p data-sn-text="idOf('a')"></p></main></body></html>`);
  const watcher = await build({ root, logLevel: 'silent', plugins: [sinter({ static: true })], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true, watch: {} } }) as unknown as { on(e: string, f: (ev: { code: string; error?: Error }) => void): void; close(): Promise<void> };
  const builds: string[] = [];
  let waiting: { done: () => void; fail: (e: unknown) => void } | null = null;
  watcher.on('event', (ev) => {
    if (ev.code === 'ERROR') waiting?.fail(ev.error);
    if (ev.code === 'END') { builds.push(readFileSync(join(root, 'dist/index.html'), 'utf8')); waiting?.done(); }
  });
  const seen = { n: 0 };
  const next = () => new Promise<void>((done, fail) => {
    const want = ++seen.n;
    if (builds.length >= want) return done();
    waiting = { done: () => { if (builds.length >= want) { waiting = null; done(); } }, fail };
  });
  try {
    await next();
    // a rebuild: the page changes, then the helper changes
    writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><title>y</title></head><body><main><p data-sn-text="idOf('b')"></p></main></body></html>`);
    await next();
    writeFileSync(join(root, 'src/sinter.helpers.ts'), 'const seen = new Map<string, number>();\nexport function idOf(s: string) { if (!seen.has(s)) seen.set(s, seen.size + 1); return seen.get(s)! * 100; }\n');
    writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><title>z</title></head><body><main><p data-sn-text="idOf('b')"></p></main></body></html>`);
    await next();
  } finally { await watcher.close(); }
  // each build's own instance: 'b' is the first id there too (not 2, after 'a' in the last build), and the edit shows
  expect(builds.map((h) => h.match(/<p>(\d+)<\/p>/)?.[1])).toEqual(['10', '10', '100']);
}, 120_000);
