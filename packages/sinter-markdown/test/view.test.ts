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
