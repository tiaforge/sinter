// <md-doc> renders a document from an API through a script (<md-view>, sinter/build.ts) unless a use fills a slot or
// passes `templates: true`, when it renders through the components (<md-tree>). The two must write the same DOM:
// here, in Chromium under the strict policy, every document below goes to two <md-doc>s on one page, one of each,
// and their markup must match, comments (the templates' anchors) apart. A document the build knows renders through
// the components, written into the page; the fast path ships only where it is used.
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import sinter from '@tiaforge-ui/sinter/vite';
import { app, page, PKG } from './app.js';
import { CSP, POST, COMMENTS } from './data.js';
import { parse } from '../sinter/parse.js';

const EVERY = `# One *em* **strong** ~~del~~ \`code\`

## Two [link](https://example.com "a title") ![img](/a.png "t") ![no title](/b.png)

### Three

#### Four

##### Five

###### Six

A hard  
break, <kbd>Ctrl</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <mark>marked</mark>, [unsafe](javascript:alert(1)), <https://auto.link>.

> quoted
>
> > nested with a [link](/x)

- tight
- list

1. one

   two
2. loose

3. from three
4. four

- [ ] open task
- [x] done task

\`\`\`ts
let x = 1 < 2 && 'a';
\`\`\`

\`\`\`
no lang
\`\`\`

| left | center | right | none |
| :--- | :----: | ----: | ---- |
| a *b* | c | d | e |
| f | g | h | i |

| only | head |
| ---- | ---- |

<details open><summary>Summary *em*</summary>

Inside **details**.

</details>

<details>

No summary.

</details>

---

Entities &amp; &copy; &#x27;.
`;

const DOCS: [string, string][] = [
  ['every node type', EVERY],
  ['fixtures/article.md', readFileSync(join(PKG, 'fixtures/article.md'), 'utf8')],
  ['the recipe\'s post', POST.body],
  ...COMMENTS.map((c): [string, string] => [`comment ${c.id}`, c.body]),
  ['empty', ''],
];
const trees = DOCS.map(([name, src]) => [name, JSON.stringify(parse(src, { html: 'allow' }))] as const);

const a = app({ 'index.html': page('<sn-resource name="doc" src="/api/doc" type="Root"></sn-resource><md-doc id="a" data-sn-with="{ doc, templates: true }"></md-doc><md-doc id="b" data-sn-with="{ doc }"></md-doc>', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`) });
const out = join(a.root, 'dist');
let server: Server, url = '', browser: Browser, current = '';

beforeAll(async () => {
  await build({ root: a.root, logLevel: 'silent', plugins: [sinter({ libraries: ['@tiaforge-ui/sinter-markdown'] })], build: { outDir: out, emptyOutDir: true } });
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/api/doc') { res.setHeader('Content-Type', 'application/json'); return res.end(current); }
    try {
      const body = readFileSync(join(out, path === '/' ? 'index.html' : path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); server?.close(); a.remove(); });

test('the script and the components write the same DOM for every document, under the strict policy', async () => {
  const p = await browser.newPage();
  const errors: string[] = [];
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    (window as never as { __v: string[] }).__v = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as never as { __v: string[] }).__v.push(`${e.violatedDirective} ${e.sample}`));
  });
  const read = () => p.evaluate(() => {
    const html = (id: string) => document.getElementById(id)!.innerHTML.replace(/<!--.*?-->/gs, '');
    const comments = (id: string) => { let c = 0; const w = document.createTreeWalker(document.getElementById(id)!, NodeFilter.SHOW_COMMENT); while (w.nextNode()) c++; return c; };
    return { a: html('a'), b: html('b'), n: document.querySelectorAll('#b *').length, ca: comments('a'), cb: comments('b') };
  });
  let elements = 0;
  for (const [name, tree] of trees) {
    current = tree;
    await p.goto(url);
    await expect.poll(async () => { const r = await read(); return r.a === r.b && (r.b.length > 0 || name === 'empty'); }, { message: name, timeout: 20_000 }).toBeTruthy().catch(() => {});
    const r = await read();
    expect(r.b, name).toBe(r.a);
    // #a renders through the components (their anchors are comments), #b through the script (none)
    if (r.n > 0) { expect(r.ca, name).toBeGreaterThan(0); expect(r.cb, name).toBe(0); }
    elements += r.n;
  }
  // the unsafe link is written without its href, as data-sn-attr writes it
  current = trees[0]![1];
  await p.goto(url);
  await p.waitForFunction(() => document.querySelectorAll('#b a').length > 2);
  expect(await p.$$eval('#b a', (as) => as.map((x) => x.getAttribute('href')))).toEqual(['https://example.com', null, 'https://auto.link', '/x']);
  expect(await p.$$eval('#b a', (as) => as.some((x) => (x.getAttribute('href') ?? '').startsWith('javascript')))).toBe(false);
  expect(elements).toBeGreaterThan(100);
  expect(await p.evaluate(() => (window as never as { __v: string[] }).__v)).toEqual([]);
  expect(errors).toEqual([]);
  await p.close();
}, 120_000);

// A document embedded in the page (`data-sn-resource`, what sinter-axum writes): <md-view>'s early renderer
// (md-view.early.ts) builds it before the first paint, and the page module's instance keeps those elements.
test('an embedded document renders in the first paint through the early renderer, and the page module adopts it', async () => {
  const tree = trees[1]![1];
  const head = (data: string) => `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script type="application/json" data-sn-resource="doc">${data}</script>`;
  const body = '<sn-resource name="doc" src="/api/doc" type="Root"></sn-resource><md-doc id="b" data-sn-with="{ doc }"></md-doc><p>after it</p>';
  const e = app({ 'index.html': page(body, head(tree.replace(/</g, '\\u003c'))), 'empty.html': page(body, head('')), 'other.html': page('<p>no document</p>') });
  const dir = join(e.root, 'dist');
  try {
    await build({ root: e.root, logLevel: 'silent', plugins: [sinter({ libraries: ['@tiaforge-ui/sinter-markdown'] })], build: { outDir: dir, emptyOutDir: true } });
    // the renderer is in this page's early file only
    const heads = (f: string) => [...readFileSync(join(dir, f), 'utf8').matchAll(/src="\/(assets\/[^"]+-head-[^"]+\.js)"/g)].map((m) => readFileSync(join(dir, m[1]!), 'utf8')).join('\n');
    expect(heads('index.html')).toContain('md-table');
    expect(heads('other.html')).not.toContain('md-table');
    const srv = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/api/doc') { res.setHeader('Content-Type', 'application/json'); return res.end(tree); }
      try {
        const b = readFileSync(join(dir, path.endsWith('/') ? path + 'index.html' : path));
        res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
        res.end(b);
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
    try {
      for (const [file, early] of [['', true], ['empty/', false]] as const) {
        const p = await browser.newPage();
        const errors: string[] = [];
        p.on('pageerror', (x) => errors.push(x.message));
        // what the first paint has: the document as the parse ends (the page module mounts after it; the early script
        // rendered the root when the parser closed it, as the paragraph after it began), and every change
        // to the root's children from then on
        await p.addInitScript(() => {
          const w = window as never as { __at: { n: number; first: Element | null } | null; __changes: number };
          w.__changes = 0;
          document.addEventListener('DOMContentLoaded', () => {
            const md = document.getElementById('b')!;
            w.__at = { n: md.children.length, first: md.firstElementChild };
            new MutationObserver((rs) => { w.__changes += rs.length; }).observe(md, { childList: true });
          });
        });
        await p.goto(base + file);
        await p.waitForFunction(() => document.querySelectorAll('#b > *').length > 5);
        // the page module has mounted, and its instance has connected
        await p.waitForTimeout(300);
        const r = await p.evaluate(() => {
          const w = window as never as { __at: { n: number; first: Element | null }; __changes: number };
          const md = document.getElementById('b')!;
          let comments = 0;
          const tw = document.createTreeWalker(md, NodeFilter.SHOW_COMMENT);
          while (tw.nextNode()) comments++;
          return { first: w.__at.n, same: w.__at.first === md.firstElementChild, changes: w.__changes, comments, n: md.children.length };
        });
        if (early) {
          // in the first paint, without anchors (the script's elements), and the same elements after the mount
          expect(r.first, 'first paint').toBe(r.n);
          expect(r.same, 'same elements').toBe(true);
          expect(r.changes, 'changes after the parse').toBe(0);
        } else {
          // a placeholder the server left empty: the page module requests the document and builds it
          expect(r.first, file).toBe(0);
          expect(r.changes, file).toBeGreaterThan(0);
        }
        expect(r.comments, file).toBe(0);
        expect(errors, file).toEqual([]);
        await p.close();
      }
    } finally { srv.close(); }
  } finally { e.remove(); }
}, 120_000);
