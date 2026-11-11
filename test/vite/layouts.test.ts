// @vitest-environment node
// Layouts through the Vite plugin: the merged head is what the rest of the build sees (the layout's
// script and stylesheet bundled, the early scripts first, the fetch preload of the page's resource),
// the layout's relative URLs work from a page in a subfolder, and in a browser the title follows the
// page's data and state.
import { createServer as http, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-layouts-'));
const root = join(dir, 'app'), out = join(dir, 'dist');
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
const files: Record<string, string> = {
  'src/layouts/site-layout.html': `<!doctype html>
<html lang="en" data-sn-layout="{ title?: string; nav: string }">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <seo-tags data-sn-prop="{ title }"></seo-tags>
  <link rel="stylesheet" href="../styles/site.css">
  <script type="module" src="../main.ts"></script>
  <slot name="head"></slot>
</head>
<body>
  <site-header data-sn-prop="{ nav }"></site-header>
  <main><slot></slot></main>
</body>
</html>
`,
  'src/components/seo-tags.html': `<template data-sn-head="{ title?: string }">
  <title data-sn-text="title ? title + ' · Blog' : 'Blog'">Blog</title>
</template>
`,
  'src/components/site-header.html': `<template data-sn-component="{ nav: string }">
  <header class="site-header"><a href="/" data-sn-class="{ active: nav == 'home' }">Home</a></header>
</template>
<style>.site-header { display: flex; }</style>
`,
  'src/styles/site.css': 'body { margin: 0; }\n',
  'src/main.ts': 'document.documentElement.dataset.main = "yes";\n',
  'index.html': `<site-layout data-sn-prop="{ nav: 'home', title: 'Home' }">
  <h1>Welcome</h1>
</site-layout>
`,
  'blog/post.html': `<site-layout data-sn-path="/blog/post" data-sn-state="{ n: 0 }" data-sn-prop="{ nav: 'post', title: post ? post.title + (n ? ' (' + n + ')' : '') : undefined }">
  <sn-resource name="post" src="/api/post" items="post" type="any"></sn-resource>
  <link slot="head" rel="stylesheet" href="../src/styles/site.css">
  <h1 data-sn-text="post ? post.title : ''"></h1>
  <button data-sn-on-click="n++">more</button>
</site-layout>
`,
};

beforeAll(async () => {
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
  await build({
    root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()],
    build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input: { index: join(root, 'index.html'), post: join(root, 'blog/post.html') } } },
  });
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('the merged head is what the build sees: the layout\'s script and stylesheet bundled, the early scripts first, the preload', () => {
  const html = readFileSync(join(out, 'blog/post.html'), 'utf8');
  expect(html).toMatch(/^<!DOCTYPE html>\s*<html lang="en" data-sn="0">/);
  expect(html).not.toMatch(/site-layout|seo-tags|<slot|data-sn-layout/);
  const head = /<head>([\s\S]*)<\/head>/.exec(html)![1]!;
  expect(head).toMatch(/<title data-sn="\d+">Blog<\/title>/);
  expect(head).toContain('<link rel="preload" as="fetch" crossorigin="" href="/api/post">');
  // the layout's module script, bundled with the page module or on its own, and its stylesheet, hashed
  expect(head).not.toContain('main.ts');
  expect(head).not.toContain('site.css');
  expect(head).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/[\w-]+\.css">/);
  const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
  expect(js).toContain('document.documentElement.dataset.main = "yes"');
  const css = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
  expect(css).toMatch(/body\s*\{\s*margin:\s*0/);
  expect(css).toContain('@scope ([data-sn-c="site-header"]');
  // the constant title is in the HTML
  expect(readFileSync(join(out, 'index.html'), 'utf8')).toMatch(/<title[^>]*>Home · Blog<\/title>|<title data-sn="\d+">Blog<\/title>/);
});

test.runIf(!!chromium)('in Chromium: the title follows the page\'s data and its state, the layout\'s script ran, the header is the layout\'s', async () => {
  const site = http((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/api/post') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ post: { title: 'Hello' } })); }
    try {
      const body = readFileSync(join(out, path === '/' ? 'index.html' : path.endsWith('/post') ? 'blog/post.html' : path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  const port = await listen(site);
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    await tab.goto(`http://127.0.0.1:${port}/blog/post`);
    await tab.waitForFunction(() => document.title === 'Hello · Blog');
    expect(await tab.textContent('h1')).toBe('Hello');
    expect(await tab.getAttribute('html', 'data-main')).toBe('yes');
    expect(await tab.$$eval('header.site-header', (x) => x.length)).toBe(1);
    await tab.click('button');
    await tab.waitForFunction(() => document.title === 'Hello (1) · Blog');
    expect(await tab.$$eval('head title', (x) => x.length)).toBe(1);
    await tab.goto(`http://127.0.0.1:${port}/`);
    await tab.waitForFunction(() => document.title === 'Home · Blog');
    expect(await tab.getAttribute('header a', 'class')).toBe('active');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    site.close();
  }
}, 60_000);
