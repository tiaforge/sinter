// @vitest-environment node
// `<html lang>` as the page's locale in a real build (an app that sets no locale): the HTML has build-time constants in
// the language, the page's head scripts (the shared early runtime and the page's own) write the first paint in it with
// the page module held back, and the page module writes the same. An app whose config module calls
// `configure({ locale })` uses its own source, not the attribute, at build and in the browser.
import { createServer as http, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-page-lang-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

const PAGE = `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><title>x</title>
<script type="application/json" data-sn-resource="a">{"a":{"at":"2026-01-26T10:00:00Z","n":1234.5}}</script></head>
<body>
  <sn-resource name="a" src="/api/a" select="a"></sn-resource>
  <p id="c" data-sn-state="{ day: '2026-11-11' }" data-sn-text="date(day, 'long')"></p>
  <p id="d" data-sn-text="date(a.at, 'long')"></p>
  <p id="n" data-sn-text="number(a.n)"></p>
  <p id="l" data-sn-text="$locale ?? '-'"></p>
</body>
</html>
`;
const CONFIG = "import { configure } from '@tiaforge-ui/sinter';\nconfigure({ locale: { get: () => 'fr', set() {} } });\n";

/** builds an app (with `config` as its config module); its dist folder */
async function app(name: string, config?: string) {
  const root = join(dir, name), out = join(root, 'dist');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'index.html'), PAGE);
  if (config) writeFileSync(join(root, 'src/sinter.config.js'), config);
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: out, emptyOutDir: true } });
  return out;
}
let plain = '', configured = '';
beforeAll(async () => { plain = await app('plain'); configured = await app('configured', CONFIG); }, 120_000);

const serve = (out: string) => http((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  try {
    const body = readFileSync(join(out, path === '/' ? 'index.html' : path));
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(body);
  } catch { res.statusCode = 404; res.end(); }
});

test('the HTML: a calendar date over constants in German', () => {
  expect(readFileSync(join(plain, 'index.html'), 'utf8')).toContain('<p id="c">11. November 2026</p>');
  // the app's own locale source: nothing in the attribute's language at build
  expect(readFileSync(join(configured, 'index.html'), 'utf8')).not.toContain('11. November 2026');
});

/** the texts of the page at `out`; `early`: with only the head scripts (the page module is not served) */
async function texts(out: string, early: boolean) {
  const site = serve(out);
  const port = await listen(site);
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage();
    const scripts: string[] = [];
    await tab.route('**/assets/*.js', (r) => {
      const url = r.request().url();
      scripts.push(url);
      return early && !/-head-/.test(url) ? r.abort() : r.continue();
    });
    await tab.goto(`http://127.0.0.1:${port}/`);
    await tab.waitForFunction(() => document.getElementById('n')!.textContent !== '');
    if (!early) await tab.waitForFunction(() => document.getElementById('l')!.textContent !== '');
    const got = await tab.evaluate(() => Object.fromEntries(['c', 'd', 'n', 'l'].map((id) => [id, document.getElementById(id)!.textContent])));
    return { got, heads: scripts.filter((s) => /-head-/.test(s)).length };
  } finally { await browser.close(); site.close(); }
}
const long = (l: string) => new Intl.DateTimeFormat(l, { dateStyle: 'long' }).format(new Date('2026-01-26T10:00:00Z'));

test.skipIf(!chromium)('the head scripts\' first paint and the page module write German; $locale is "de"', async () => {
  const want = { c: '11. November 2026', d: long('de'), n: '1.234,5', l: 'de' };
  const first = await texts(plain, true);
  expect(first.heads).toBeGreaterThan(0);
  expect(first.got).toEqual(want);
  expect((await texts(plain, false)).got).toEqual(want);
}, 60_000);

test.skipIf(!chromium)('configure({ locale }) in the config module: its locale, not the attribute', async () => {
  const live = await texts(configured, false);
  expect(live.got).toEqual({ c: '11 novembre 2026', d: long('fr'), n: '1 234,5', l: 'fr' });
}, 60_000);
