// @vitest-environment node
// A page swapped in reads its array parameters (`$url.sender`, bound as a list) as lists from its first
// evaluation, as on a load: in a let, in a resource the page before may prefetch. (caley saw `$url.sender`
// undefined on a swap into its mail page; this setup does not show it.)
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-swap-lists-'));
afterAll(() => { if (!process.env.SN_KEEP) rmSync(dir, { recursive: true, force: true }); });

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body>\n${body}\n</body></html>\n`;

test.skipIf(!chromium)('a list parameter is a list at the first evaluation, on a load and on a swap', async () => {
  const root = join(dir, 'app');
  const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
  // a helper that records what the let's first evaluation got
  put('src/sinter.helpers.ts', `export function seen(x: string[]): number { ((globalThis as any).__seen ??= []).push(Array.isArray(x) ? 'list' : typeof x); return [...x].length; }\n`);
  put('index.html', page('<a id="go" href="/mail/">mail</a><p data-sn-text="$url.q"></p>'));
  put('mail.html', page(`<sn-resource name="m" src="/api/m?n={seen($url.sender)}"></sn-resource><div data-sn-let="{ n: seen($url.sender) }"><p id="n" data-sn-text="n"></p>
    <label><input type="checkbox" value="a" data-sn-model="$url.sender"> a</label><label><input type="checkbox" value="b" data-sn-model="$url.sender"> b</label></div>`));
  const out = join(root, 'dist');
  await build({ root, logLevel: 'silent', plugins: [sinter({ swap: true })], resolve: { alias },
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: { index: join(root, 'index.html'), mail: join(root, 'mail.html') } } } });
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    try {
      const file = path.endsWith('/') ? path + 'index.html' : extname(path) ? path : path + '.html';
      const body = readFileSync(join(out, file));
      res.setHeader('Content-Type', extname(file) === '.js' ? 'text/javascript' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(path.startsWith('/api/') ? '{}' : ''); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium!.launch();
  try {
    const p = await browser.newPage();
    const docs: string[] = [];
    p.on('request', (r) => { if (r.resourceType() === 'document') docs.push(new URL(r.url()).pathname); });
    // a load
    await p.goto(base + '/mail/');
    await p.waitForFunction(() => document.querySelector('#n')?.textContent === '0');
    expect(await p.evaluate(() => (globalThis as any).__seen)).toEqual(expect.arrayContaining(['list']));
    expect((await p.evaluate(() => (globalThis as any).__seen)).filter((x: string) => x !== 'list')).toEqual([]);
    // a swap
    await p.goto(base + '/');
    await p.evaluate(() => { (globalThis as any).__seen = []; });
    docs.length = 0;
    await p.click('#go');
    await p.waitForFunction(() => document.querySelector('#n')?.textContent === '0');
    expect(docs).toEqual([]);
    const seen = await p.evaluate(() => (globalThis as any).__seen);
    expect(seen.filter((x: string) => x !== 'list')).toEqual([]);
  } finally {
    await browser.close();
    server.close();
  }
}, 120_000);
