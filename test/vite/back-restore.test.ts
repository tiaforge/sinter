// @vitest-environment node
// Back to a page the back/forward cache does not hold (its HTML is `no-store`): its resources show what the page
// showed as it was left, without `cache`, before the API answers; then the API's data. On a load (`back_forward`)
// and on a swap's traversal (`sinter({ swap: true })`).
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-back-restore-'));
afterAll(() => { if (!process.env.SN_KEEP) rmSync(dir, { recursive: true, force: true }); });

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body>\n${body}\n</body></html>\n`;

for (const [swap, bare] of [[false, false], [true, false], [true, true]] as const) {
  test.skipIf(!chromium)(`Back shows the list as it was left, then the API's (${swap ? (bare ? 'a swap from a page with nothing to run, which reloads' : 'a swap') : 'a load'})`, async () => {
    const root = join(dir, swap ? (bare ? 'bare' : 'swap') : 'load');
    const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
    put('index.html', page('<sn-resource name="items" src="/api/items" select="items" key="id"></sn-resource><ul><template data-sn-for="x in items"><li data-sn-text="x.name"></li></template></ul><a id="go" href="/other/">other</a>'));
    put('other.html', page(bare ? '<p id="other">other</p>' : '<p id="other" data-sn-state="{ n: 1 }" data-sn-text="n" data-sn-on-click="n++"></p>'));
    const out = join(root, 'dist');
    await build({ root, logLevel: 'silent', plugins: [sinter({ swap, prefetch: false })], resolve: { alias },
      build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: { index: join(root, 'index.html'), other: join(root, 'other.html') } } } });
    let calls = 0;
    const server: Server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://x').pathname;
      if (path === '/api/items') {
        const n = ++calls;
        res.setHeader('Content-Type', 'application/json');
        // Back would take a subresource from the HTTP cache otherwise, as browsers do on a traversal
        res.setHeader('Cache-Control', 'no-store');
        // the first load answers at once; the one after Back, a second later and with other data
        setTimeout(() => res.end(JSON.stringify({ items: n === 1 ? [{ id: 1, name: 'left' }] : [{ id: 2, name: 'fresh' }] })), n === 1 ? 0 : 1000);
        return;
      }
      try {
        const file = path.endsWith('/') ? path + 'index.html' : extname(path) ? path : path + '.html';
        const body = readFileSync(join(out, file));
        res.setHeader('Content-Type', extname(file) === '.js' ? 'text/javascript' : 'text/html');
        // never kept in the back/forward cache: Back loads the page
        if (extname(file) === '.html') res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      } catch { res.statusCode = 404; res.end(''); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // no back/forward cache: Back loads the page (a swap's Back never uses it)
    const browser = await chromium!.launch({ args: ['--disable-back-forward-cache'] });
    try {
      const p = await browser.newPage();
      const errors: string[] = [];
      p.on('pageerror', (e) => errors.push(String(e)));
      await p.goto(base + '/');
      await p.waitForFunction(() => document.querySelector('li')?.textContent === 'left');
      await p.click('#go');
      await p.waitForSelector('#other');
      const docs: string[] = [];
      p.on('request', (r) => { if (r.resourceType() === 'document') docs.push(new URL(r.url()).pathname); });
      await p.goBack();
      // before the API answers (a second): the list as it was left
      await p.waitForFunction(() => document.querySelector('li')?.textContent === 'left', null, { timeout: 800 }).catch(async (e) => {
        throw new Error(`${e.message}: ${await p.evaluate(() => JSON.stringify({ html: document.body.innerHTML.slice(0, 300), keys: Object.keys(sessionStorage), nav: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type }))}`);
      });
      if (!swap) expect(await p.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type)).toBe('back_forward');
      await p.waitForFunction(() => document.querySelector('li')?.textContent === 'fresh', null, { timeout: 5000 });
      // a swap's Back requests no document; from a page with nothing to run, and without swaps, Back loads it
      expect(docs).toEqual(swap && !bare ? [] : ['/']);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      server.close();
    }
  }, 120_000);
}
