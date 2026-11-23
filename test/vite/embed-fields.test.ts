// @vitest-environment node
// What a built page embeds of its build-time data (docs/proposals/redesign-notes/embed-fields.md), in a build and in
// Chromium: a page per entry whose live part reads the entry's slug carries the slug in its code and embeds nothing
// (the benchmark's case, bench/astro), a value read past a small primitive is embedded with only what is read, and a
// value that escapes whole stays whole; each page shows in the browser what its code reads.
import { createServer as http, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?([\w-]+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];

const dir = mkdtempSync(join(tmpdir(), 'sinter-embed-fields-'));
const root = join(dir, 'app'), out = join(dir, 'dist');
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
const long = 'a long text '.repeat(20);
const author = { name: 'Ada', bio: long, links: { site: '/ada', mail: 'ada@example.com' } };
const data = { title: 'Data', slug: 'data', body: long, author, tags: ['x', 'y'], secret: 'internal' };

const page = (body: string, head = '') => `<!doctype html>
<html lang="en"${head}>
<head><meta charset="utf-8"><title>t</title></head>
<body>
${body}
</body>
</html>
`;
/** something live (a counter), so what reads `expr` runs in the browser */
const live = (expr: string) => `<div data-sn-state="{ n: 0 }"><button id="inc" data-sn-on-click="n++">+</button><p id="out" data-sn-text="n + '|' + (${expr})"></p></div>`;
const pages: Record<string, string> = {
  // the benchmark's case: the entry's slug in a live resource's URL
  'blog/post.html': page(`<sn-resource name="posts" src="file:/content/posts/*.md" type="any"></sn-resource>
<h1 data-sn-text="post.title"></h1>
<section data-sn-state="{ open: false }">
  <sn-resource name="comments" src="/api/comments?post={post.slug}" select="comments" key="id" type="any"></sn-resource>
  <button id="open" data-sn-on-click="open = !open" data-sn-text="open ? 'Hide' : 'Show'"></button>
  <ul data-sn-show="open"><template data-sn-for="c in comments"><li data-sn-text="c.body"></li></template></ul>
</section>
<a id="next" href="/blog/post-2">next</a>`, ' data-sn-path="/blog/:slug" data-sn-for="post in posts"'),
  // pruned: an object read whole, a long string, and a field folded
  'pruned.html': page(`<sn-resource name="d" src="file:/data.json" type="any"></sn-resource>${live("JSON.stringify(d.author.links) + d.body.length + d.slug")}`),
  // escapes: whole (`state`: held in state, an alias, read through it)
  'spread.html': page(`<sn-resource name="d" src="file:/data.json" type="any"></sn-resource>${live('JSON.stringify({ ...d })')}`),
  'keys.html': page(`<sn-resource name="d" src="file:/data.json" type="any"></sn-resource>${live("Object.keys(d).join()")}`),
  'computed.html': page(`<sn-resource name="d" src="file:/data.json" type="any"></sn-resource>${live("d.author[n % 2 ? 'name' : 'bio'].length")}`),
  'state.html': page(`<sn-resource name="d" src="file:/data.json" type="any"></sn-resource><div data-sn-state="{ p: null, n: 0 }"><button id="inc" data-sn-on-click="p = d; n++">+</button><p id="out" data-sn-text="n + '|' + (p ? p.secret : '')"></p></div>`),
  'body.html': page(`<sn-resource name="d" src="file:/data.json" type="any"></sn-resource><button id="send" data-sn-post="/api/echo" data-sn-body="d">send</button><p id="out">0|</p>`),
};

const comments: string[] = [];
const posted: unknown[] = [];

beforeAll(async () => {
  for (const [f, s] of Object.entries(pages)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); }
  mkdirSync(join(root, 'content/posts'), { recursive: true });
  for (const i of [1, 2]) writeFileSync(join(root, `content/posts/post-${i}.md`), `---\ntitle: Post ${i}\n---\n${'The text of the post, rendered at build time. '.repeat(30)}\n`);
  writeFileSync(join(root, 'data.json'), JSON.stringify(data));
  await build({
    root, resolve: { alias }, logLevel: 'silent', build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input: Object.fromEntries(Object.keys(pages).map((p) => [p.replace(/\W/g, '-'), join(root, p)])) } },
    plugins: [sinter()],
  });
}, 120_000);
afterAll(() => { if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true }); else console.log(dir); });

// (a page at a fixed path is `<name>/index.html`, its old file a redirect to it)
const html = (f: string) => readFileSync(join(out, f.startsWith('blog/') ? f : f.replace(/\.html$/, '/index.html')), 'utf8');
const json = (f: string) => [...html(f).matchAll(/<script type="application\/json" data-sn="\d+">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!.replace(/\\u003c/g, '<')));

test('the built pages embed what their code reads: nothing for the entry, the read paths, or the whole value where it escapes', () => {
  for (const f of ['blog/post-1.html', 'blog/post-2.html']) {
    expect(json(f)).toEqual([]);
    expect(html(f)).not.toContain('data-sn-for');
  }
  const mod = readdirSync(join(out, 'assets/blog')).find((f) => /^post-1-.*\.js$/.test(f))!;
  expect(readFileSync(join(out, 'assets/blog', mod), 'utf8')).toMatch(/"\/api\/comments" \+ \$hq\(\[\["post", \(*"post-1"\)*\]\]\)/);
  expect(json('pruned.html')).toEqual([{ body: long, author: { links: author.links } }]);
  for (const f of ['spread.html', 'keys.html', 'state.html', 'body.html']) expect(json(f), f).toEqual([data]);
  expect(json('computed.html')).toEqual([{ author }]);
});

test.runIf(!!chromium)('in Chromium: the comments request names the entry, and each page shows what its code reads', async () => {
  const site = http((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/api/comments') { comments.push(req.url!); res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ comments: [{ id: 1, body: `on ${new URL(req.url!, 'http://x').searchParams.get('post')}` }] })); }
    if (path === '/api/echo') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { posted.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{}'); }); return; }
    const file = path.endsWith('/') ? `${path}index.html` : /\.\w+$/.test(path) ? path : `${path}.html`;
    try {
      const body = readFileSync(join(out, file));
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  const port = await listen(site);
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    tab.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const at = `http://127.0.0.1:${port}`;
    await tab.goto(`${at}/blog/post-1`);
    await tab.click('#open');
    await tab.waitForFunction(() => document.querySelector('li')?.textContent === 'on post-1');
    expect(comments).toEqual(['/api/comments?post=post-1']);
    // the next entry's page, by a link: its own code, its own slug
    await tab.click('#next');
    await tab.waitForFunction(() => document.querySelector('h1')?.textContent === 'Post 2');
    await tab.click('#open');
    await tab.waitForFunction(() => document.querySelector('li')?.textContent === 'on post-2');
    expect(comments).toEqual(['/api/comments?post=post-1', '/api/comments?post=post-2']);
    const shows = async (p: string, want: string) => {
      await tab.goto(`${at}/${p}/`);
      await tab.click('#inc');
      try { await tab.waitForFunction((w) => document.querySelector('#out')?.textContent === w, want, { timeout: 5000 }); } catch { expect([await tab.textContent('#out'), ...errors], p).toEqual([want]); }
    };
    await shows('pruned', `1|${JSON.stringify(author.links)}${long.length}data`);
    await shows('spread', `1|${JSON.stringify(data)}`);
    await shows('keys', `1|${Object.keys(data).join()}`);
    await shows('computed', `1|${author.name.length}`);
    await shows('state', '1|internal');
    await tab.goto(`${at}/body/`);
    await tab.click('#send');
    for (let i = 0; i < 40 && !posted.length; i++) await new Promise((r) => setTimeout(r, 50));
    expect(posted).toEqual([data]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    site.close();
  }
}, 60_000);
