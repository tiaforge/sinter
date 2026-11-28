// @vitest-environment node
// The texts in the early script (docs/messages.md#messages-in-the-early-script): in a build, each early script's modules
// get the texts of the messages they call in the page's language, so the early script carries neither the entries nor
// the messages module; a message whose entry is not a plain text, or a reference left in the script, still reads the
// page's dictionary, which then keeps that entry in the page. Checked on built files, and in Chromium: the first paint
// (the page module held back) shows what the page module shows once it runs, in each language and its chain.
import { createServer as http, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Browser } from 'playwright';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-early-texts-'));
afterAll(() => { if (!process.env.SN_KEEP) rmSync(tmp, { recursive: true, force: true }); });

const N = 30, fill = (i: number) => `fill_${String(i).padStart(2, '0')}`;
const WEIRD = 'Quote " single \' back \\ nl \n tpl $&{n} `tick` </script> <!--     😀 שלום עולם $1 end';
const messages = (lang: 'en' | 'de' | 'de-AT') => lang === 'de-AT' ? { plain: 'Servus' } : ({
  ...Object.fromEntries(Array.from({ length: N }, (_, i) => [fill(i), lang === 'en' ? `Text number ${i} of the page, long enough to count` : `Text Nummer ${i} der Seite, lang genug um zu zählen`])),
  plain: lang === 'en' ? 'Plain' : 'Schlicht',
  hello: lang === 'en' ? 'Hello {name}!' : 'Hallo {name}!',
  two: lang === 'en' ? '{a} and {b}' : '{a} und {b}',
  weird: lang === 'en' ? WEIRD : `${WEIRD} (de)`,
  ...(lang === 'en' ? { only_en: 'Only in English' } : {}),
  things: [{ declarations: ['input count', 'local n = count: plural'], selectors: ['n'], match: lang === 'en' ? { 'n=one': '{count} thing', 'n=*': '{count} things' } : { 'n=one': '{count} Ding', 'n=*': '{count} Dinge' } }],
  ref: lang === 'en' ? 'Referenced' : 'Verwiesen',
});
const HELPERS = `import { m } from '@tiaforge-ui/sinter/messages';
const who = { toString: () => 'Ada' };
const params = { name: 'P' };
// every shape the early script may call
export const probe = (n: number): string => [
  m.plain(), m.hello({ name: who }), m.hello({ name: n }), m.hello(), m.hello({}), m.hello(params), m.hello(null),
  m.two({ a: n, b: who }), m.two({ a: 'x' }), m.weird({ n: '<' }), m.weird(), m.only_en(),
  m.hello\`tag\`,
].join('|');
export const count = (n: number): string => m.things({ count: n });
export const texts = (n: number): string => [${Array.from({ length: N }, (_, i) => `m.${fill(i)}()`).join(', ')}].slice(n).join('|');
`;
const REFS = `import { m } from '@tiaforge-ui/sinter/messages';
// a reference the early script keeps (it is read, not called): it stays the messages module's
const f = m.ref;
export const kept = (n: number): string => typeof f + ' ' + f() + ' ' + n + ' ' + [m.hello].map((g) => g({ name: 'mapped' }))[0];
`;
const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head>${body}</html>\n`;
// a page whose early script shows the probe (behind a stored choice: a build-time value would be folded into the HTML),
// and the same once the page module runs (a click)
const shows = (early: string, later: string) => page(`<body data-sn-state="{ n: 0, on: false, all: '', late: '' }"><input id="on" type="checkbox" data-sn-model="on" data-sn-persist="on"><button id="more" data-sn-on-click="late = ${later}">more</button><button id="fill" data-sn-on-click="all = texts(n); n = n + 1">fill</button>
    <b id="e" data-sn-text="on ? ${early} : ''"></b><p id="late" data-sn-text="late"></p><p id="all" data-sn-text="all"></p></body>`);
const FILES: Record<string, string> = {
  'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de', 'de-AT'] }),
  'src/sinter.content.ts': `import { languages } from '@tiaforge-ui/sinter/content';\nimport { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';\nexport const locales = languages(({ root }) => inlangLocales('project.inlang', root));\nexport const messages = inlang();\n`,
  'messages/en.json': JSON.stringify(messages('en')),
  'messages/de.json': JSON.stringify(messages('de')),
  'messages/de-AT.json': JSON.stringify(messages('de-AT')),
  'src/sinter.helpers.ts': `${HELPERS}export * as refs from './lib/refs.ts';\n`,
  'src/lib/refs.ts': REFS,
  'index.html': shows('probe(n)', 'probe(n)'),
  'count.html': shows("probe(n) + '|' + count(n + 1)", "probe(n) + '|' + count(n + 1)"),
  'refs.html': shows("probe(n) + '|' + refs.kept(n)", "probe(n) + '|' + refs.kept(n)"),
};

async function site(name: string, files: Record<string, string> = {}, options: Parameters<typeof sinter>[0] = {}) {
  const root = join(tmp, name), out = join(root, 'dist');
  for (const [f, text] of Object.entries({ ...FILES, ...files })) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, site: 'https://example.com', ...options })], build: { outDir: out, emptyOutDir: true, rollupOptions: { input: ['index.html', 'count.html', 'refs.html'].map((f) => join(root, f)) } } });
  const read = (f: string) => readFileSync(join(out, f), 'utf8');
  const of = (file: string) => {
    const html = read(file);
    const inline = /<script type="application\/json" data-sn-ns="m"[^>]*>(.*?)<\/script>/s.exec(html)?.[1];
    const head = /<script src="\/(assets\/[^"]*-head-[^"]+)"/.exec(html.replace(/<script src="\/assets\/sinter-head-[^"]+"><\/script>/, ''))?.[1];
    return { html, inline: inline === undefined ? null : Object.keys(JSON.parse(inline) as object), head: head ? read(head) : '', shared: read(/<script src="\/(assets\/sinter-head-[^"]+)"/.exec(html)![1]!) };
  };
  return { root, out, read, of, assets: readdirSync(join(out, 'assets')) };
}
type Site = Awaited<ReturnType<typeof site>>;

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
function serve(dir: string): Promise<{ origin: string; close(): Promise<void> }> {
  const srv: Server = http((req, res) => {
    let file = join(dir, decodeURIComponent(new URL(req.url!, 'http://x').pathname));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ origin: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => new Promise((done) => srv.close(() => done())) })));
}

let main: Site;
beforeAll(async () => { main = await site('main'); }, 120_000);
const RUNTIME = /sinter\.i18n/;

describe('the build', () => {
  test('an early script whose messages are plain texts has the texts, in its page\'s language, and no messages module; the page no dictionary', () => {
    for (const [lang, plain] of [['en', 'Plain'], ['de', 'Schlicht'], ['de-AT', 'Servus']] as const) {
      const p = main.of(`${lang}/index.html`);
      expect(p.head).not.toMatch(RUNTIME);
      expect(p.head).not.toMatch(/data-sn-ns/);
      expect(p.head).toContain(plain);
      expect(p.inline).toBeNull();
    }
    // the chain: de-AT's own text, de's where it has none, the base language's where de has none
    expect(main.of('de-AT/index.html').head).toContain('Hallo ');
    expect(main.of('de-AT/index.html').head).toContain('Only in English');
    // (the same early source in two languages: two scripts)
    expect(main.of('en/index.html').head).not.toBe(main.of('de/index.html').head);
    expect(main.of('en/index.html').shared).not.toMatch(RUNTIME);
  });

  test('a plural in the early script: it reads the dictionary, and the page keeps that entry alone; the other texts are written in', () => {
    const p = main.of('en/count/index.html');
    expect(p.head).toMatch(RUNTIME);
    expect(p.inline).toEqual(['things']);
    expect(p.head).toContain('Plain');
    expect(p.head).not.toMatch(/\.plain\b/);
  });

  test('a message referenced in a way that stays in the early script: built again with every reference as written, its entry kept in the page', () => {
    const p = main.of('en/refs/index.html');
    expect(p.head).toMatch(RUNTIME);
    expect(p.inline).toEqual(['hello', 'ref']);
    // (calls are still texts)
    expect(p.head).toContain('Plain');
  });

  test('the shared head script (one for every page): texts only when every page has the same; else its messages read the dictionary', async () => {
    const early = `import { m } from '@tiaforge-ui/sinter/messages';\n(globalThis as { __early?: string }).__early = m.plain();\n`;
    const two = await site('shared', { 'src/sinter.early.ts': early });
    expect(two.of('en/index.html').shared).toMatch(RUNTIME);
    expect(two.of('en/index.html').inline).toEqual(['plain']);
    expect(two.of('de/index.html').inline).toEqual(['plain']);
    const one = await site('shared-one', { 'src/sinter.early.ts': early }, { localePrefix: false });
    expect(one.of('index.html').shared).not.toMatch(RUNTIME);
    expect(one.of('index.html').shared).toContain('__early=`Plain`');
    expect(one.of('index.html').inline).toBeNull();
  }, 120_000);

  test('without `localePrefix` (one language): the texts of the base language', async () => {
    const one = await site('one', {}, { localePrefix: false });
    const p = one.of('index.html');
    expect(p.head).not.toMatch(RUNTIME);
    expect(p.head).toContain('Plain');
    expect(p.inline).toBeNull();
  }, 120_000);
});

describe.skipIf(!chromium)('in Chromium, on the built site', () => {
  let browser: Browser, server: Awaited<ReturnType<typeof serve>>, spelled: Site, spellServer: Awaited<ReturnType<typeof serve>>;
  // a helper module that imports the messages module under another spelling as well (its file's path), which neither
  // the keys' reading nor the texts' sees: the page keeps its whole dictionary, and the first paint has the text
  const SPELLED = `${HELPERS}export * as refs from './lib/refs.ts';\nimport { m as m2 } from ${JSON.stringify(`${src}/messages.ts`)};\nexport const spelled = (): string => m2.plain();\n`;
  beforeAll(async () => {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
    server = await serve(main.out);
    spelled = await site('spelled', { 'src/sinter.helpers.ts': SPELLED, 'index.html': shows("probe(n) + '|' + spelled()", "probe(n) + '|' + spelled()") });
    spellServer = await serve(spelled.out);
    browser = await chromium!.launch();
  }, 120_000);
  afterAll(async () => { await browser?.close(); await server?.close(); await spellServer?.close(); });

  const cases: Array<[string, () => string]> = ['en/', 'de/', 'de-AT/', 'en/count/', 'de/count/', 'en/refs/', 'de/refs/'].map((p) => [p, () => server.origin]);
  cases.push(['en/', () => spellServer.origin], ['de/', () => spellServer.origin]);
  for (const [path, origin] of cases) {
    test(`/${path}${cases.indexOf(cases.find((c) => c[0] === path && c[1] === origin)!) > 6 ? ' (a module that imports the messages under another spelling)' : ''}: the first paint, the page module held back, shows what the page module shows`, async () => {
      const server = { origin: origin() };
      if (server.origin === spellServer.origin) {
        expect(spelled.of(`${path}index.html`).head).toMatch(RUNTIME);
        expect(spelled.of(`${path}index.html`).inline).toEqual(expect.arrayContaining(['plain', 'hello', fill(0)]));
      }
      const context = await browser.newContext();
      await context.addInitScript(() => localStorage.setItem('sn:on', 'true'));
      const held = await context.newPage(), errors: string[] = [];
      for (const p of [held]) { p.on('pageerror', (e) => errors.push(String(e))); }
      await held.route('**/assets/*.js', (r) => (/-head-/.test(r.request().url()) ? r.continue() : r.abort()));
      await held.goto(`${server.origin}/${path}`, { waitUntil: 'domcontentloaded' });
      await held.waitForFunction(() => !!document.getElementById('e')?.textContent);
      const early = await held.evaluate(() => document.getElementById('e')!.textContent);
      const live = await context.newPage();
      live.on('pageerror', (e) => errors.push(String(e)));
      await live.goto(`${server.origin}/${path}`, { waitUntil: 'networkidle' });
      await live.click('#more');
      await live.waitForFunction(() => !!document.getElementById('late')?.textContent);
      const later = await live.evaluate(() => document.getElementById('late')!.textContent);
      expect(early).toBe(later);
      expect(early).toContain(path.startsWith('en') ? 'Hello Ada!' : 'Hallo Ada!');
      expect(early).toContain('</script>');
      expect(early).toContain(' ');
      expect(early).not.toMatch(/\b(plain|hello|weird|things)\b/);
      if (path.includes('count')) expect(early).toContain(path.startsWith('en') ? '1 thing' : '1 Ding');
      if (path.includes('refs')) expect(early).toContain(path.startsWith('en') ? 'function Referenced 0' : 'function Verwiesen 0');
      expect(await live.evaluate(() => document.getElementById('e')!.textContent)).toBe(early);
      expect(errors).toEqual([]);
      await context.close();
    }, 60_000);
  }
});
