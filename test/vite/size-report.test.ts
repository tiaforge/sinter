// @vitest-environment node
// The build's per-page size lines (src/vite.ts `reportRuntime`, `report`): info lines, measured (gzip) only when they are
// printed. At `logLevel: 'warn'` only what the first-paint budget's warning needs is gzipped (the early files, the shared
// head script), once per distinct text; at the default level, or with a custom logger, every line is there
// with the sizes of the files the build wrote, each script gzipped once however many pages share it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { build, createLogger } from 'vite';
import { afterAll, beforeEach, expect, test, vi } from 'vitest';

/** gzipSync calls from sinter's own modules (the mock reaches the modules vitest loads, not Vite's) */
const gz = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:zlib', async (orig) => {
  const z = await orig<typeof import('node:zlib')>();
  return { ...z, gzipSync: (...a: Parameters<typeof z.gzipSync>) => { gz.n++; return z.gzipSync(...a); } };
});
const { default: sinter } = await import('../../src/vite.js');

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?([\w-]+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-size-report-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => { gz.n = 0; });

// three pages with a page module and an early script (one source for all three), and one with no JavaScript
const live = `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body>
<sn-resource name="items" src="/api/items?q={$url.q}" select="items" key="id" type="any"></sn-resource>
<ul><template data-sn-for="i in items"><li data-sn-text="i.name"></li></template></ul>
<section data-sn-state="{ open: false }"><button data-sn-on-click="open = !open">t</button><p data-sn-show="open">x</p></section>
</body></html>
`;
const names = ['a', 'b', 'c', 'plain'];
const root = join(tmp, 'app');
mkdirSync(root, { recursive: true });
for (const n of names) writeFileSync(join(root, `${n}.html`), n === 'plain' ? '<!doctype html><html><head><title>p</title></head><body><p>hi</p></body></html>' : live);

async function site(out: string, config: { logLevel?: 'warn' | 'info'; customLogger?: import('vite').Logger }) {
  await build({ root, ...config, resolve: { alias }, plugins: [sinter()], build: { outDir: join(tmp, out), emptyOutDir: true, rollupOptions: { input: Object.fromEntries(names.map((n) => [n, join(root, `${n}.html`)])) } } });
}

test('at logLevel warn, only the budget is measured: the one early file the three pages share and the shared head script', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { await site('warn', { logLevel: 'warn' }); } finally { log.mockRestore(); }
  expect(gz.n).toBe(2);
});

test('at the default level the lines are printed with the written files\' sizes, each script gzipped once', async () => {
  const lines: string[] = [];
  const logger = createLogger('info', { allowClearScreen: false });
  logger.info = (m: string) => { lines.push(m); };
  await site('info', { customLogger: logger });
  const out = join(tmp, 'info');
  const kb = (f: string) => `${(zlib.gzipSync(readFileSync(join(out, f), 'utf8')).length / 1000).toFixed(1)} kB`;
  const calls = gz.n;
  for (const n of ['a', 'b', 'c']) {
    const html = readFileSync(join(out, n, 'index.html'), 'utf8');
    const shared = /<script src="\/(assets\/sinter-head-[\w-]+\.js)">/.exec(html)![1]!, own = /<script src="\/(assets\/[abc]-head-[\w-]+\.js)">/.exec(html)![1]!;
    expect(lines).toContain(`sinter: early script of ${n}.html: ${own} ${kb(own)} gzip + ${shared} ${kb(shared)} gzip (shared)`);
    const page = /<script type="module" crossorigin src="\/(assets\/[\w-]+\.js)" async>/.exec(html)![1]!;
    expect(lines.find((l) => l.startsWith(`sinter: ${n}.html: JavaScript ${kb(page)} gzip`))).toBeTruthy();
  }
  expect(lines).toContain('sinter: plain.html: no JavaScript');
  // the three pages' scripts are the same texts (the size of a text is kept for the build): the early file, the shared
  // head script, the page module (one text under three names) and the chunk it imports, each gzipped once
  expect(calls).toBe(4);
});

test('a custom logger gets the lines at any log level', async () => {
  const lines: string[] = [];
  const logger = createLogger('warn', { allowClearScreen: false });
  logger.info = (m: string) => { lines.push(m); };
  await site('custom', { logLevel: 'warn', customLogger: logger });
  expect(lines.filter((l) => /^sinter: [abc]\.html: JavaScript .* kB gzip/.test(l))).toHaveLength(3);
});
