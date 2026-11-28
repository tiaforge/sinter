// @vitest-environment node
// The page's dictionary file (docs/messages.md#the-pages-dictionary) and a swap to a page whose early file shares a
// helper module (docs/first-paint.md#own-copies): the swap fetches the module's own copy beside the page module, and
// the copy must not run before the next page's dictionary file, or a message it calls at its top level has no text.
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-dictionary-swap-shared-'));
afterAll(() => { if (!process.env.SN_KEEP) rmSync(tmp, { recursive: true, force: true }); });

const N = 30, key = (i: number) => `line_${String(i).padStart(2, '0')}`;
const texts = (lang: string) => ({
  ...Object.fromEntries(Array.from({ length: N }, (_, i) => [key(i), `${lang === 'en' ? 'Line' : 'Zeile'} ${i}, long enough that the dictionary needs a file`])),
  big_label: lang === 'en' ? 'Big label' : 'Großes Etikett',
  hello: lang === 'en' ? 'Hello' : 'Hallo',
});
const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>\n`;
const FILES: Record<string, string> = {
  'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de'] }),
  'src/sinter.content.ts': `import { languages } from '@tiaforge-ui/sinter/content';\nimport { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';\nexport const locales = languages(({ root }) => inlangLocales('project.inlang', root));\nexport const messages = inlang();\n`,
  'messages/en.json': JSON.stringify(texts('en')),
  'messages/de.json': JSON.stringify(texts('de')),
  // a helper module an early binding calls, which calls a message as it runs (its own copy reads the page's dictionary)
  'src/big.ts': `import { m } from '@tiaforge-ui/sinter/messages';\nconst label = m.big_label();\nexport function shout(s: string | null | undefined): string { return label + ':' + (s ?? ''); }\n`,
  'src/lots.ts': `import { m } from '@tiaforge-ui/sinter/messages';\nexport const all = (): string => [${Array.from({ length: N }, (_, i) => `m.${key(i)}()`).join(', ')}].join('|');\nexport const hi = (): string => m.hello();\n`,
  'src/sinter.helpers.ts': `export * as big from './big.ts';\nexport * as lots from './lots.ts';\n`,
  // the first page calls a message from its page module (a click): the messages module has started when the swap comes
  'a.html': page(`<main data-sn-state="{ s: '' }"><button id="hi" data-sn-on-click="s = lots.hi()">hi</button><p id="s" data-sn-text="s"></p><a id="go" href="/en/b/?q=x">b</a></main>`),
  'b.html': page(`<main data-sn-state="{ s: '' }"><p id="b" data-sn-text="big.shout($url.q)"></p><button id="all" data-sn-on-click="s = lots.all()">all</button><p id="s" data-sn-text="s"></p></main>`),
};

let out = '';
beforeAll(async () => {
  const root = join(tmp, 'site');
  out = join(root, 'dist');
  for (const [f, text] of Object.entries(FILES)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, swap: true, site: 'https://example.com', typecheck: false })], build: { outDir: out, emptyOutDir: true, rollupOptions: { input: ['a.html', 'b.html'].map((f) => join(root, f)) } } });
}, 120_000);

test('the built pages: the second page names the helper\'s own copy for a swap, and its entry chunk imports a dictionary file', () => {
  const html = readFileSync(join(out, 'en/b/index.html'), 'utf8');
  expect(html).toMatch(/<link data-sn-shared href="\/assets\/[^"]+">/);
  const entry = /<script type="module"[^>]*\ssrc="\/(assets\/[^"]+)"/.exec(html)![1]!;
  expect(readFileSync(join(out, entry), 'utf8')).toMatch(/^import"\.\/en-m-[\w-]{8}\.js";/);
});

test.skipIf(!chromium)('a swap to it, its dictionary file late: the own copy runs after the file, and its message has its text', async () => {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server: Server = createServer((req, res) => {
    let file = join(out, decodeURIComponent(new URL(req.url!, 'http://x').pathname));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium!.launch();
  try {
    const p = await browser.newPage(), errors: string[] = [], docs: string[] = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('request', (r) => { if (r.resourceType() === 'document') docs.push(r.url()); });
    await p.goto(`${origin}/en/a/`);
    await p.click('#hi');
    await p.waitForFunction(() => document.getElementById('s')?.textContent === 'Hello');
    // (the next page's dictionary file, and only that, arrives late)
    await p.route(/\/assets\/en-m-[\w-]{8}\.js$/, async (r) => { await new Promise((ok) => setTimeout(ok, 800)); await r.continue(); });
    await p.click('#go');
    await p.waitForFunction(() => document.getElementById('b')?.textContent?.endsWith(':x'), null, { timeout: 10_000 });
    expect(docs).toHaveLength(1);
    expect(await p.textContent('#b')).toBe('Big label:x');
    await p.click('#all');
    expect((await p.textContent('#s'))!.split('|')).toHaveLength(N);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}, 60_000);
