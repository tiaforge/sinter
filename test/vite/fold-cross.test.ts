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
import { crossCheck, crossMessage } from '../../src/fold-cross.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
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
    // each page alone gives 1 in the browser; the build gave the last page 3, the fresh copy (last page first) gives it 1
    expect(error).toMatch(/idOf\("c"\) on p2\.html: 3 in the build, 1 in a fresh copy of the helpers module/);
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

test('crossCheck: the pages in reverse order, in a module instance of its own; a helper that throws there is a difference', () => {
  let n = 0;
  const m = { next: () => ++n, fmt: { same: (s: string) => s.toUpperCase() }, boom: () => { throw new Error('no'); } };
  const bad = crossCheck(m, [['a.html', [{ key: 'next', args: [], json: '1' }, { key: 'fmt$same', args: ['x'], json: '"X"' }]], ['b.html', [{ key: 'next', args: [], json: '2' }, { key: 'boom', args: [], json: '0' }]]]);
  expect(bad.map((b) => [b.page, b.key, b.got])).toEqual([['b.html', 'next', '1'], ['b.html', 'boom', 'threw (no)'], ['a.html', 'next', '2']]);
  expect(crossMessage(bad)).toMatch(/^next\(\), boom\(\) gave other results .*\n {2}next\(\) on b\.html: 2 in the build, 1 in a fresh copy/);
});
