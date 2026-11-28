// @vitest-environment node
// The shared head script keeps the parts of the early runtime the site's pages use (src/runtime/early-flags.ts): the
// reader of embedded data only when a page's early file reads some, the computed keys' guard only when a page's early
// functions have one. A page's own early file is the same either way.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?([\w-]+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-early-flags-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const page = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>x</title>${head}</head><body>${body}</body></html>\n`;
// state persisted, so the page has an early file; the second also reads a computed key early
const PLAIN = page('<section data-sn-state="{ tab: \'a\' }" data-sn-persist="ui"><button data-sn-on-click="tab = \'b\'">t</button><p data-sn-text="tab"></p></section>');
const KEYED = page('<section data-sn-state="{ tab: \'a\', names: { a: \'A\', b: \'B\' } }" data-sn-persist="ui"><button data-sn-on-click="tab = \'b\'">t</button><p data-sn-text="names[tab]"></p></section>');
const EMBEDDED = page('<sn-resource name="user" src="/api/user" type="any"></sn-resource><p data-sn-text="user.name"></p>', '<script type="application/json" data-sn-resource="user">{"name":"Ada"}</script>');

/** builds a site of these pages, and returns its shared head script and each page's own early file */
async function site(name: string, pages: Record<string, string>) {
  const root = join(tmp, name), out = join(tmp, name + '-out');
  mkdirSync(root, { recursive: true });
  for (const [n, html] of Object.entries(pages)) writeFileSync(join(root, `${n}.html`), html);
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: out, emptyOutDir: true, rollupOptions: { input: Object.fromEntries(Object.keys(pages).map((n) => [n, join(root, `${n}.html`)])) } } });
  const files = readdirSync(join(out, 'assets')), read = (f: string) => readFileSync(join(out, 'assets', f), 'utf8');
  return { shared: read(files.find((f) => /^sinter-head-/.test(f))!), own: Object.fromEntries(Object.keys(pages).map((n) => [n, read(files.find((f) => new RegExp(`^${n}-head-`).test(f))!)])) };
}
// the reader walks a resource's `select` path, the guard refuses `__proto__`: each names what only it does
const reader = (code: string) => /\.select\b/.test(code), guard = (code: string) => code.includes('__proto__') && code.includes('is not allowed');

test('a site without embedded data: its head script holds no reader of it, and no key guard when no early function has a computed key', async () => {
  const a = await site('plain', { a: PLAIN, b: PLAIN });
  expect(reader(a.shared)).toBe(false);
  expect(guard(a.shared)).toBe(false);
  const b = await site('keyed', { a: PLAIN, b: KEYED });
  expect(reader(b.shared)).toBe(false);
  expect(guard(b.shared)).toBe(true);
  // the page that uses neither is the same file in both sites
  expect(b.own.a).toBe(a.own.a);
});

test('a site with a page that has embedded data: its head script holds the reader, for every page', async () => {
  const a = await site('embedded', { a: PLAIN, b: EMBEDDED });
  expect(reader(a.shared)).toBe(true);
  expect(a.own.b).toContain('emb:');
  // and the page's own early file is what it is in a site where every page has embedded data
  const b = await site('embedded-all', { b: EMBEDDED });
  expect(reader(b.shared)).toBe(true);
  expect(b.own.b).toBe(a.own.b);
});
