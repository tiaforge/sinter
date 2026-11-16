// Markdown from an API, in Chromium, under Trusted Types: the recipe's article and its comments, parsed
// in the browser by md.parse in a `data-sn-let`. Built twice: with the parser loaded with the page, and
// with the parser lazy (`sinter({ lazy })`), where each let waits for it. Every page runs under
// `script-src 'self'; style-src 'self'; require-trusted-types-for 'script'` and fails on any violation
// report or console error, the harness of sinter's test/vite/trusted-types.test.ts. The sources carry
// entities (`&amp;`): a parser that decoded them through innerHTML would throw there.
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import sinter from '@tiaforge-ui/sinter/vite';
import { app, page, PKG } from './app.js';

import { CSP, POST, COMMENTS } from './data.js';

const HEAD = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

// the recipe's page (docs/recipes/article-with-comments.html), as the app's index.html
const BODY = readFileSync(join(PKG, 'docs/recipes/article-with-comments.html'), 'utf8');

const a = app({ 'index.html': page(BODY, HEAD) });
const builds = { eager: join(a.root, 'dist'), lazy: join(a.root, 'dist-lazy') };
const servers: Server[] = [];
let browser: Browser;

/** a build and its API */
function serve(dir: string): Promise<string> {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = url.pathname === '/api/post' ? POST : url.pathname === '/api/post/comments' ? COMMENTS : null;
    if (json) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(json)); }
    // an upload: a same-origin image, one the app's resizing service would take
    if (url.pathname === '/uploads/plate.png') { res.setHeader('Content-Type', 'image/png'); return res.end(readFileSync(join(PKG, 'fixtures/diagram.png'))); }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    try {
      const body = readFileSync(join(dir, path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}/`)));
}

/** a tab that records every policy violation and console error */
async function tab(): Promise<{ page: Page; check: () => Promise<void> }> {
  const p = await browser.newPage();
  const errors: string[] = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __violations: string[] }).__violations.push(`${e.violatedDirective} ${e.sample}`));
  });
  return { page: p, check: async () => {
    expect(await p.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
    expect(errors).toEqual([]);
  } };
}

/** builds the app; `lazy`: with the parser in `sinter({ lazy })` */
const make = (lazy: boolean) => build({
  root: a.root, logLevel: 'silent',
  // a resizing service for the app's own images from the API: md-image does not use it
  plugins: [sinter({ components: ['@tiaforge-ui/sinter-markdown'], images: { remote: { url: 'cloudflare', origins: ['self'] } }, ...(lazy ? { lazy: ['@tiaforge-ui/sinter-markdown'] } : {}) })],
  build: { outDir: lazy ? builds.lazy : builds.eager, emptyOutDir: true },
});
beforeAll(async () => {
  await make(false);
  await make(true);
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  for (const s of servers) s.close();
  a.remove();
});

describe.each((['eager', 'lazy'] as const))('the parser %s', (kind) => {
  test('the article: entities decoded, headings with their anchors, inline content without wrappers', async () => {
    const { page: p, check } = await tab();
    await p.goto(await serve(builds[kind]));
    // the title, the table of contents and the body: each renders when its let has a tree
    await p.waitForFunction(() => !!document.querySelector('#body h2') && document.querySelectorAll('#post nav a').length === 2 && !!document.querySelector('#post h1 .md')?.textContent);
    expect(await p.textContent('#post h1 .md')).toBe('Fish & chips');
    // the table of contents and the anchors come from one tree
    expect(await p.$$eval('#post nav a', (as) => as.map((a) => [a.getAttribute('href'), a.textContent]))).toEqual([['#md-fish--chips', 'Fish & chips'], ['#md-where', 'Where']]);
    expect(await p.$$eval('#body :is(h1, h2)', (hs) => hs.map((h) => h.id))).toEqual(['md-fish--chips', 'md-where']);
    expect(await p.$eval('#body h1', (h) => [h.id, h.textContent])).toEqual(['md-fish--chips', 'Fish & chips']);
    expect(await p.$eval('#body p', (e) => e.innerHTML.replace(/<!--[^>]*-->/g, ''))).toBe('A short history of <em>fish &amp; chips</em>, with <a href="https://example.com/history">a source</a> and <code>code &amp;amp; more</code>.');
    expect(await p.$$eval('#body li', (l) => l.map((e) => e.textContent))).toEqual(['London © 1860', 'Lancashire']);
    // an image from the API is a plain <img>: not sent through the app's resizing service
    expect(await p.$eval('#body img', (i) => [i.getAttribute('src'), i.getAttribute('srcset'), i.getAttribute('alt')])).toEqual(['/uploads/plate.png', null, 'A plate']);
    // raw HTML is text by default
    expect(await p.$$eval('#body kbd', (k) => k.length)).toBe(0);
    expect(await p.textContent('#body')).toContain('<kbd>Ctrl</kbd> is shown as written.');
    await check();
  });

  test('the comments: the user-content policy, the link fill, unsafe URLs refused', async () => {
    const { page: p, check } = await tab();
    await p.goto(await serve(builds[kind]));
    await p.waitForFunction(() => document.querySelectorAll('.comment p').length >= 3);
    const comments = await p.$$eval('.comment', (cs) => cs.map((c) => c.querySelector('.md')!.innerHTML.replace(/<!--[^>]*-->/g, '')));
    expect(comments[0]).toBe('<p>Great post &amp; thanks!</p>');
    // no heading and no image: a paragraph of strong text, a link to the image; links take the fill
    expect(comments[1]).toBe('<p><strong>Not a heading</strong></p><p><a rel="nofollow ugc" href="https://example.com/p.jpg">a photo</a> and <a rel="nofollow ugc" href="https://example.com">a link</a></p>');
    // raw HTML shown as written; a javascript: URL is not written
    expect(await p.$$eval('.comment:nth-child(3) p', (ps) => ps.map((e) => e.textContent))).toEqual(['<script>alert(1)</script>', 'A bad link.']);
    expect(await p.$eval('.comment:nth-child(3) a', (e) => [e.getAttribute('href'), e.getAttribute('rel')])).toEqual([null, 'nofollow ugc']);
    await check();
  });
});

/** the page module of a build, and the other chunks */
const chunks = (dir: string) => {
  const entry = /<script type="module"[^>]*src="\/([^"]+)"/.exec(readFileSync(join(dir, 'index.html'), 'utf8'))![1]!;
  const all = readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.js')).map((f) => `assets/${f}`);
  return { entry: readFileSync(join(dir, entry), 'utf8'), others: all.filter((f) => f !== entry).map((f) => readFileSync(join(dir, f), 'utf8')) };
};
// the entity table is the parser's largest part: where it is, the parser is
const PARSER = /AElig/;

test('with the parser lazy, the page module holds no parser; it loads in a chunk of its own', () => {
  const lazy = chunks(builds.lazy), eager = chunks(builds.eager);
  expect(lazy.entry).not.toMatch(PARSER);
  expect(lazy.others.filter((c) => PARSER.test(c))).toHaveLength(1);
  // loaded with the page, the parser is in the page's own bundle
  expect([eager.entry, ...eager.others].some((c) => PARSER.test(c))).toBe(true);
});

// Without `key` a resource is one object (sinter's docs/resources.md, "Single objects"): an upsert into
// the comments would replace the whole list with the one comment. The recipe's list is keyed.
test('the recipe keys its list of comments, so a comment added later joins the list', () => {
  expect(BODY).toMatch(/<sn-resource name="comments" src="[^"]+" key="id">/);
});
