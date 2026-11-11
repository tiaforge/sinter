// @vitest-environment node
// Bindings in the head (docs/proposals/layouts.md, Head bindings): `<title>` text and a
// `<meta name|property>`'s `content`, and `data-sn-if` templates over head elements. What the early
// script knows (helpers; with embedded data, `$url` and the data) renders as the head is parsed,
// without the page module; other data when it arrives.
import { createServer as http, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { engines } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-head-bindings-'));
const root = join(dir, 'app'), out = join(dir, 'dist');
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

beforeAll(async () => {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'sinter.helpers.js'), "export const site = () => 'Docs';\nexport const withImage = () => true;\n");
  writeFileSync(join(root, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title data-sn-text="site() + ' · Blog'">Blog</title>
  <meta name="description" content="Notes" data-sn-attr="{ content: 'About ' + site() }">
  <template data-sn-if="withImage()"><meta property="og:image" data-sn-attr="{ content: '/img/' + site() + '.png' }"></template>
  <script type="application/json" data-sn-data="post">{ "post": { "title": "Embedded" } }</script>
  <meta property="og:title" content="Blog" data-sn-attr="{ content: post ? post.title + ($url.q ? ' ' + $url.q : '') : 'Blog' }">
  <meta property="og:description" content="Blog" data-sn-attr="{ content: other ? other.text : 'Blog' }">
</head>
<body>
  <sn-resource name="post" src="/api/post" items="post" type="any"></sn-resource>
  <sn-resource name="other" src="/api/other" items="other" type="any"></sn-resource>
  <p id="t" data-sn-text="post ? post.title : ''"></p>
</body>
</html>
`);
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: out, emptyOutDir: true, minify: false } });
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('the build: bindings on <title> and <meta content>, the literal content kept for scrapers', () => {
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  expect(html).toMatch(/<title data-sn="\d+">Blog<\/title>/);
  expect(html).toMatch(/<meta name="description" content="Notes" data-sn="\d+">/);
  expect(html).toMatch(/<meta property="og:title" content="Blog" data-sn="\d+">/);
  expect(html).toMatch(/<script src="\/assets\/index-head-[\w-]+\.js"><\/script>/);
  // the page's embedded data: no preload of it
  expect(html).not.toContain('href="/api/post"');
});

test('in every engine: the early script renders the head (helpers, embedded data, $url) without the page module; other data when it arrives', async () => {
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const page = /src="(\/assets\/index-[\w-]+\.js)" async/.exec(html)![1]!;
  let block = false;
  const site = http((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/api/other') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ other: { text: 'From the API' } })); }
    if (block && path === page) { res.statusCode = 404; return res.end(); }
    try {
      const body = readFileSync(join(out, path === '/' ? 'index.html' : path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  const port = await listen(site);
  try {
    for (const engine of await engines()) {
      const browser = await engine.type.launch(engine.executablePath ? { executablePath: engine.executablePath } : {});
      try {
        const tab = await browser.newPage();
        const meta = (sel: string) => tab.$eval(sel, (m) => m.getAttribute('content')).catch(() => null);
        // without the page module: the early script alone renders what needs no request
        block = true;
        await tab.goto(`http://127.0.0.1:${port}/?q=now`, { waitUntil: 'load' });
        expect(await tab.title(), engine.name).toBe('Docs · Blog');
        expect(await meta('meta[name="description"]'), engine.name).toBe('About Docs');
        expect(await meta('meta[property="og:image"]'), engine.name).toBe('/img/Docs.png');
        expect(await meta('meta[property="og:title"]'), engine.name).toBe('Embedded now');
        expect(await meta('meta[property="og:description"]'), engine.name).toBe('Blog');
        expect(await tab.$$eval('head title', (x) => x.length)).toBe(1);
        // with it: data from a request fills what reads it
        block = false;
        await tab.goto(`http://127.0.0.1:${port}/`);
        await tab.waitForFunction(() => document.querySelector('meta[property="og:description"]')?.getAttribute('content') === 'From the API');
        expect(await meta('meta[property="og:title"]'), engine.name).toBe('Embedded');
        expect(await tab.textContent('#t')).toBe('Embedded');
      } finally {
        await browser.close();
      }
    }
  } finally {
    site.close();
  }
}, 120_000);
