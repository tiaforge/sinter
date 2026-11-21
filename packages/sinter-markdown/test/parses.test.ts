// md.parse keeps its trees (sinter's memo()): lets and props are evaluated at every read, and md-doc's
// components read their `doc` at every node, so without it each read would parse again. In Chromium, on
// the recipe's page, with the parser aliased to one that records what it tokenizes: one parse per
// distinct source on the first render, none after a change elsewhere on the page, none for a new
// comment whose body another one already has, and one for a new body.
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import sinter from '@tiaforge-ui/sinter/vite';
import { app, page, PKG } from './app.js';
import { CSP, POST, COMMENTS } from './data.js';

const RECIPE = readFileSync(join(PKG, 'docs/recipes/article-with-comments.html'), 'utf8');
// `&amp;amp;` in an attribute is the text `&amp;`: the same body as the first comment
const CONTROLS = `<div data-sn-state="{ n: 0 }">
  <button id="bump" data-sn-on-click="n = n + 1" data-sn-text="n"></button>
  <button id="same" data-sn-on-click="upsert(comments, { id: 4, author: 'Ada again', body: 'Great post &amp;amp; thanks!' })">same</button>
  <button id="new" data-sn-on-click="upsert(comments, { id: 5, author: 'Kim', body: 'A *new* comment' })">new</button>
</div>`;
const a = app({ 'index.html': page(`${RECIPE}\n${CONTROLS}`, `<meta http-equiv="Content-Security-Policy" content="${CSP}">`) });
const out = join(a.root, 'dist');
let server: Server, url = '', browser: Browser;

beforeAll(async () => {
  await build({
    root: a.root, logLevel: 'silent',
    resolve: { alias: [{ find: /^@tiaforge-ui\/sinter-markdown\/parser$/, replacement: join(PKG, 'test/count-parser.js') }] },
    plugins: [sinter({ libraries: ['@tiaforge-ui/sinter-markdown'] })],
    build: { outDir: out, emptyOutDir: true },
  });
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const json = path === '/api/post' ? POST : path === '/api/post/comments' ? COMMENTS : null;
    if (json) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(json)); }
    if (path === '/uploads/plate.png') { res.setHeader('Content-Type', 'image/png'); return res.end(readFileSync(join(PKG, 'fixtures/diagram.png'))); }
    try {
      const body = readFileSync(join(out, path === '/' ? 'index.html' : path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); server?.close(); a.remove(); });

test('one parse per distinct source, none after a change elsewhere, none for a body already parsed', async () => {
  const p = await browser.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.querySelectorAll('.comment').length === 3 && !!document.querySelector('#body h2'));
  const parsed = () => p.evaluate(() => (globalThis as unknown as { __parsed: string[] }).__parsed.slice());
  const first = await parsed();
  // each source once: the article, its title, the three comments; and '' (the lets read before the data came) at most once
  expect(new Set(first).size).toBe(first.length);
  expect(first.filter((s) => s !== '').sort()).toEqual([POST.body, POST.title, ...COMMENTS.map((c) => c.body)].sort());

  // a change elsewhere on the page: nothing parses
  await p.click('#bump');
  await p.waitForFunction(() => document.querySelector('#bump')!.textContent === '1');
  expect(await parsed()).toEqual(first);

  // a comment whose body another one has: its row renders the same tree, and nothing parses
  await p.click('#same');
  await p.waitForFunction(() => document.querySelectorAll('.comment').length === 4);
  expect(await parsed()).toEqual(first);
  const html = await p.$$eval('.comment .md', (ds) => ds.map((d) => d.innerHTML.replace(/<!--[^>]*-->/g, '')));
  expect(html[3]).toBe(html[0]);
  expect(html[3]).toBe('<p>Great post &amp; thanks!</p>');

  // a new body: one parse
  await p.click('#new');
  await p.waitForFunction(() => document.querySelectorAll('.comment').length === 5);
  expect((await parsed()).slice(first.length)).toEqual(['A *new* comment']);
  expect(errors).toEqual([]);
});
