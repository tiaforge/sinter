// @vitest-environment node
// A page's dictionary in a file of its own (docs/messages.md#the-pages-dictionary): a build writes the entries of the
// messages a page's modules call into `assets/<language>-m-<hash>.js`, per page and language, which the page's entry chunk
// imports first; the page keeps in its head only the entries its head scripts read. Checked on built files, and in
// Chromium on the built site: a message called at a module's top level, the first paint with the page module held
// back, a swap to a page with other entries and Back, and a dictionary file that arrives late.
import { createServer as http, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { build, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-dictionary-file-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// thirty messages only the page module shows (a handler calls for them), one the head script shows (behind a stored
// choice), one called at a module's top level (the config module, which every page has), one only the second page's
// own module calls; the third page calls no helper, so its dictionary is the config module's two entries
const N = 30, fill = (i: number) => `fill_${String(i).padStart(2, '0')}`;
const messages = (lang: 'en' | 'de') => ({
  ...Object.fromEntries(Array.from({ length: N }, (_, i) => [fill(i), lang === 'en' ? `Text number ${i} of the page, long enough to count` : `Text Nummer ${i} der Seite, lang genug um zu zählen`])),
  early_label: lang === 'en' ? 'Shown early' : 'Früh gezeigt',
  top: lang === 'en' ? 'Called at the top' : 'Ganz oben gerufen',
  only_b: lang === 'en' ? 'Only on the second page' : 'Nur auf der zweiten Seite',
  price: 'for $& and $1',
});
const HELPERS = `import { m } from '@tiaforge-ui/sinter/messages';
export const early = (): string => m.early_label();
export const texts = (n: number): string => [${Array.from({ length: N }, (_, i) => `m.${fill(i)}()`).join(', ')}].slice(n).join('|');
export * as second from './lib/second.ts';
`;
const SECOND = `import { m } from '@tiaforge-ui/sinter/messages';
export const label = (n: number): string => m.only_b() + ' ' + n + ' ' + m.price();
`;
const CONFIG = `import { m } from '@tiaforge-ui/sinter/messages';
// a message called as the module is evaluated: the dictionary file has run by then
(globalThis as { __top?: string[] }).__top = [...((globalThis as { __top?: string[] }).__top ?? []), m.top(), m.fill_00()];
`;
const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head>${body}</html>\n`;
const FILES: Record<string, string> = {
  'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de'] }),
  'src/sinter.content.ts': `import { languages } from '@tiaforge-ui/sinter/content';\nimport { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';\nexport const locales = languages(({ root }) => inlangLocales('project.inlang', root));\nexport const messages = inlang();\n`,
  'messages/en.json': JSON.stringify(messages('en')),
  'messages/de.json': JSON.stringify(messages('de')),
  'src/sinter.helpers.ts': HELPERS,
  'src/lib/second.ts': SECOND,
  'src/sinter.config.ts': CONFIG,
  'index.html': page(`<body data-sn-state="{ n: 0, on: false, all: '' }"><input id="on" type="checkbox" data-sn-model="on" data-sn-persist="on"><button id="more" data-sn-on-click="all = texts(n); n = n + 1">more</button>
    <b id="e" data-sn-text="on ? early() : ''"></b><p id="all" data-sn-text="all"></p><a id="to-b" data-sn-href="/b">b</a></body>`),
  'b.html': page(`<body data-sn-state="{ n: 0, b: '', all: '' }"><button id="more" data-sn-on-click="b = second.label(n); all = texts(n); n = n + 1">more</button><p id="b" data-sn-text="b"></p><p id="all" data-sn-text="all"></p><a id="to-a" data-sn-href="/">a</a></body>`),
  'small.html': page(`<body data-sn-state="{ n: 0 }"><button id="more" data-sn-on-click="n = n + 1">more</button><p id="s" data-sn-text="'clicked ' + n"></p></body>`),
};

async function site(name: string, files: Record<string, string> = {}, options: Parameters<typeof sinter>[0] = {}, sourcemap = false, extra: Plugin[] = []) {
  const root = join(tmp, name), out = join(root, 'dist');
  for (const [f, text] of Object.entries({ ...FILES, ...files })) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, swap: true, site: 'https://example.com', ...options }), ...extra], build: { outDir: out, emptyOutDir: true, sourcemap, rollupOptions: { input: ['index.html', 'b.html', 'small.html'].map((f) => join(root, f)) } } });
  const read = (f: string) => readFileSync(join(out, f), 'utf8');
  const assets = readdirSync(join(out, 'assets'));
  /** a page's parts: its HTML, the entries its head keeps, its entry chunk, the dictionary file that chunk imports first */
  const of = (file: string) => {
    const html = read(file);
    const inline = /<script type="application\/json" data-sn-ns="m"[^>]*>(.*?)<\/script>/s.exec(html)?.[1];
    const entry = /<script type="module"[^>]*\ssrc="\/(assets\/[^"]+)"/.exec(html)?.[1] ?? '';
    const code = entry ? read(entry) : '';
    // (the first line of the chunk; with `compileHints`, the hint's comment is above it)
    const dict = /^(?:\/\/#[^\n]*\n)?import"\.\/([^"]+)";\n/.exec(code)?.[1] ?? null;
    return { html, inline: inline === undefined ? null : Object.keys(JSON.parse(inline) as object), entry, dict, text: dict && /(^|-)m-[\w-]{8}\.js$/.test(dict) ? read(`assets/${dict}`) : null };
  };
  return { root, out, read, assets, of };
}
type Site = Awaited<ReturnType<typeof site>>;

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
/** the built site over HTTP (a directory is its index.html) */
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

describe('the build', () => {
  test('a file per page and language, with every entry the page\'s modules call; none for the page whose dictionary is small', () => {
    // (named after the language and the text: two pages with the same entries would share one)
    const files = main.assets.filter((f) => /(^|-)m-[\w-]{8}\.js$/.test(f)).map((f) => f.replace(/-[\w-]{8}\.js$/, '')).sort();
    expect(files).toEqual(['de-m', 'de-m', 'en-m', 'en-m']);
    const en = main.of('en/index.html'), de = main.of('de/index.html'), b = main.of('en/b/index.html');
    expect(en.dict).toMatch(/^en-m-[\w-]{8}\.js$/);
    expect(de.dict).toMatch(/^de-m-[\w-]{8}\.js$/);
    expect(b.dict).toMatch(/^en-m-[\w-]{8}\.js$/);
    expect(b.dict).not.toBe(en.dict);
    // the file: the entries by name, in the page's language, the head script's one too
    for (const k of [fill(0), fill(N - 1), 'early_label', 'top']) expect(en.text).toContain(`"${k}":`);
    expect(en.text).toContain('"Shown early"');
    expect(en.text).not.toContain('only_b');
    expect(en.text).toMatch(/^\{const s=globalThis\[Symbol\.for\("sinter\.i18n"\)\]/);
    expect(de.text).toContain('"Früh gezeigt"');
    expect(de.text).not.toContain('Shown early');
    expect(b.text).toContain('"only_b":"Only on the second page"');
    // (the second page's modules: the helpers', the config module's, and its own)
    expect(b.text).toContain(`"${fill(7)}":`);
  });

  test('the head scripts have their messages\' texts (docs/messages.md#messages-in-the-early-script): the page keeps no entry, and no dictionary element', () => {
    // the first page's head script shows one message (behind a stored choice): its text is in the script, in the page's
    // language, and the script has no messages module
    for (const [lang, text] of [['en', 'Shown early'], ['de', 'Früh gezeigt']] as const) {
      const p = main.of(`${lang}/index.html`), head = main.read(p.html.match(/<script src="\/(assets\/[\w-]*-head-[^"]+)"/g)!.map((t) => t.slice(14, -1)).find((f) => !f.includes('sinter-head'))!);
      expect(p.inline).toBeNull();
      expect(p.html).not.toContain('data-sn-ns');
      expect(head).toContain(text);
      expect(head).not.toContain('sinter.i18n');
      expect(head).not.toContain('fill_');
    }
    // the second page's head scripts read none
    expect(main.of('en/b/index.html').inline).toBeNull();
    expect(main.of('de/b/index.html').html).not.toContain('data-sn-ns');
  });

  test('a small dictionary (under 1,024 bytes of JSON) stays in the page, whole: no file, no import, no preload', () => {
    const s = main.of('en/small/index.html');
    expect(s.inline).toEqual(['fill_00', 'top']);
    expect(s.dict).toBeNull();
    expect(s.html).not.toMatch(/\/(en-)?m-[\w-]{8}\.js/);
  });

  test('the file is asked for with the page: a module preload right after the entry script, after the stylesheets, before the other preloads', () => {
    const { html, entry, dict } = main.of('en/index.html');
    const at = html.indexOf(`<link rel="modulepreload" crossorigin href="/assets/${dict}">`), script = html.indexOf(`src="/${entry}"`);
    expect(at).toBeGreaterThan(script);
    expect(html.slice(script, at)).not.toContain('<link');
    expect(html.indexOf('rel="stylesheet"')).toBeLessThan(script);
    // the head scripts and the entries they read come before all of it
    expect(html.indexOf('data-sn-ns="m"')).toBeLessThan(html.indexOf('<script src='));
    expect(html.indexOf('<script src=')).toBeLessThan(script);
  });

  test('a change of one text: the dictionary file and the entry chunk that imports it get new names, in that language alone', async () => {
    const en = { ...messages('en'), [fill(3)]: 'Another text for number three, as long as the others' };
    const next = await site('text', { 'messages/en.json': JSON.stringify(en) });
    for (const p of ['index.html', 'b/index.html']) {
      expect(next.of(`en/${p}`).dict).not.toBe(main.of(`en/${p}`).dict);
      expect(next.of(`en/${p}`).entry).not.toBe(main.of(`en/${p}`).entry);
      expect(next.of(`de/${p}`).dict).toBe(main.of(`de/${p}`).dict);
      expect(next.of(`de/${p}`).entry).toBe(main.of(`de/${p}`).entry);
    }
    // the page with the small dictionary: its HTML changes, its entry chunk does not
    expect(next.of('en/small/index.html').entry).toBe(main.of('en/small/index.html').entry);
    // and the same sources give the same names
    const again = await site('again');
    expect(again.of('en/index.html').entry).toBe(main.of('en/index.html').entry);
    expect(again.of('en/index.html').dict).toBe(main.of('en/index.html').dict);
  }, 120_000);

  test('a head script that reaches the messages in a way the build does not read (`t(key)`): the page keeps its whole dictionary', async () => {
    const helpers = HELPERS.replace("import { m } from '@tiaforge-ui/sinter/messages';", "import { m, t } from '@tiaforge-ui/sinter/messages';").replace('m.early_label()', "t('early_' + 'label')");
    const odd = await site('odd', { 'src/sinter.helpers.ts': helpers + 'export const keep = (): string => m.early_label();\n' });
    // (and it works: the head script finds the entry it names in its own way)
    expect(odd.of('en/index.html').html).toContain('"early_label":"Shown early"');
    const en = odd.of('en/index.html');
    expect(en.inline).toEqual(expect.arrayContaining([fill(0), fill(N - 1), 'early_label', 'top']));
    // (the file is still there, for the page module's graph; the second page's head scripts do not have that module)
    expect(en.dict).toMatch(/^en-m-/);
    expect(odd.of('en/b/index.html').inline).toBeNull();
  }, 120_000);

  test('without `localePrefix` (one language), the HTML left as written, source maps and compile hints on: the same, in the base language', async () => {
    // (what a plugin after sinter's sees of the entry chunk: its code and its source map in memory, as the .map file has it)
    const seen = new Map<string, { code: string; mappings: string | undefined }>();
    const after: Plugin = { name: 'after', enforce: 'post', generateBundle: { order: 'post', handler(_, b) { for (const c of Object.values(b)) if (c.type === 'chunk' && c.isEntry) seen.set(c.fileName, { code: c.code, mappings: c.map?.mappings }); } } };
    const one = await site('one', {}, { localePrefix: false, minifyHtml: false, compileHints: true }, true, [after]);
    const p = one.of('index.html');
    expect(p.dict).toMatch(/^en-m-[\w-]{8}\.js$/);
    expect(p.inline).toBeNull();
    expect(one.of('b/index.html').dict).toMatch(/^en-m-[\w-]{8}\.js$/);
    expect(one.of('b/index.html').dict).not.toBe(p.dict);
    expect(p.html).toContain(`<link rel="modulepreload" crossorigin href="/assets/${p.dict}">`);
    // the hint's comment, then the import, each a line of its own: the entry's source map starts two lines lower
    expect(one.read(p.entry)).toMatch(/^\/\/# allFunctionsCalledOnLoad\nimport"\.\/en-m-[\w-]{8}\.js";\n/);
    const map = JSON.parse(one.read(`${p.entry}.map`)) as { mappings: string; sources: string[] };
    expect(map.mappings.startsWith(';;')).toBe(true);
    expect(map.mappings.startsWith(';;;')).toBe(false);
    expect(seen.get(p.entry)?.code.startsWith('//# allFunctionsCalledOnLoad\nimport"./en-m-')).toBe(true);
    expect(seen.get(p.entry)?.mappings).toBe(map.mappings);
    // (a chunk without a dictionary file has the hint alone)
    const other = one.assets.filter((f) => f.endsWith('.js.map')).map((f) => (JSON.parse(one.read(`assets/${f}`)) as { mappings: string }).mappings);
    expect(other.some((m) => !m.startsWith(';;'))).toBe(true);
  }, 120_000);
});

describe.skipIf(!chromium)('in Chromium, on the built site', () => {
  let browser: Browser, context: BrowserContext, server: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
    server = await serve(main.out);
    browser = await chromium!.launch();
    context = await browser.newContext();
  }, 60_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  const fresh = async (stored: Record<string, string> = {}) => {
    const p = await context.newPage(), errors: string[] = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, stored);
    return { p, errors };
  };
  const text = (p: Awaited<ReturnType<typeof fresh>>['p'], id: string) => p.evaluate((i) => document.getElementById(i)?.textContent ?? null, id);
  const top = (p: Awaited<ReturnType<typeof fresh>>['p']) => p.evaluate(() => (globalThis as { __top?: string[] }).__top ?? null);

  test('a message called at a module\'s top level has its text, in each language; the page shows every message', async () => {
    for (const [lang, called, first] of [['en', 'Called at the top', 'Text number 0 of the page'], ['de', 'Ganz oben gerufen', 'Text Nummer 0 der Seite']] as const) {
      const { p, errors } = await fresh();
      await p.goto(`${server.origin}/${lang}/`, { waitUntil: 'networkidle' });
      expect(await top(p)).toEqual([called, expect.stringContaining(first)]);
      await p.click('#more');
      await p.waitForFunction(() => document.getElementById('all')?.textContent !== '');
      const all = (await text(p, 'all'))!.split('|');
      expect(all).toHaveLength(N);
      expect(all.every((t) => t.startsWith(first.slice(0, 11)))).toBe(true);
      expect(errors).toEqual([]);
      await p.close();
    }
  }, 60_000);

  test('the first paint, the page module and the dictionary file held back: the head script shows its message from the page', async () => {
    const { p, errors } = await fresh({ 'sn:on': 'true' });
    await p.route('**/assets/*.js', (r) => (/-head-/.test(r.request().url()) ? r.continue() : r.abort()));
    await p.goto(`${server.origin}/de/`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(300);
    expect(await text(p, 'e')).toBe('Früh gezeigt');
    expect(await top(p)).toBeNull();
    expect(errors.filter((e) => !/Failed to load resource|ERR_FAILED/.test(e))).toEqual([]);
    await p.close();
  }, 60_000);

  test('a swap to a page with other entries, Back, and Forward: each page\'s messages have their texts', async () => {
    const { p, errors } = await fresh({ 'sn:on': 'true' });
    const documents: string[] = [];
    p.on('request', (r) => { if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname); });
    await p.goto(`${server.origin}/en/`, { waitUntil: 'networkidle' });
    expect(await text(p, 'e')).toBe('Shown early');
    await p.click('#to-b');
    await p.waitForFunction(() => !!document.getElementById('b'));
    await p.click('#more');
    await p.waitForFunction(() => document.getElementById('b')?.textContent !== '');
    expect(await text(p, 'b')).toBe('Only on the second page 0 for $& and $1');
    expect((await text(p, 'all'))!.split('|')).toHaveLength(N);
    // (a swap: the document was requested once; the config module ran once)
    expect(documents).toEqual(['/en/']);
    expect(await top(p)).toHaveLength(2);
    await p.goBack();
    await p.waitForFunction(() => document.getElementById('e')?.textContent === 'Shown early' && !document.getElementById('b'));
    await p.click('#more');
    await p.waitForFunction(() => document.getElementById('all')?.textContent?.split('|').length === 30);
    expect((await text(p, 'all'))!.split('|')[0]).toContain('Text number 0');
    await p.goForward();
    await p.waitForFunction(() => !!document.getElementById('b'));
    await p.click('#more');
    await p.waitForFunction(() => document.getElementById('b')?.textContent?.startsWith('Only on the second page'));
    expect(documents).toEqual(['/en/']);
    expect(errors).toEqual([]);
    await p.close();
  }, 60_000);

  test('a page loaded first that has no dictionary file, then a swap to one that has: its texts are there', async () => {
    const { p, errors } = await fresh();
    await p.goto(`${server.origin}/en/small/`, { waitUntil: 'networkidle' });
    expect(await text(p, 's')).toBe('clicked 0');
    expect(await top(p)).toEqual(['Called at the top', expect.stringContaining('Text number 0')]);
    const documents: string[] = [];
    p.on('request', (r) => { if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname); });
    await p.evaluate(() => { const a = document.createElement('a'); a.href = '/en/b/'; a.id = 'go'; a.textContent = 'second'; document.body.append(a); });
    await p.click('#go');
    await p.waitForFunction(() => !!document.getElementById('b'));
    await p.click('#more');
    await p.waitForFunction(() => document.getElementById('b')?.textContent !== '');
    expect(await text(p, 'b')).toBe('Only on the second page 0 for $& and $1');
    expect((await text(p, 'all'))!.split('|').every((t) => t.startsWith('Text number'))).toBe(true);
    expect(documents).toEqual([]);
    expect(errors).toEqual([]);
    await p.close();
  }, 60_000);

  test('the dictionary file arrives a second late: the page module waits for it, the first paint stays as it is, and no message shows its key', async () => {
    const { p, errors } = await fresh({ 'sn:on': 'true' });
    let released = 0;
    await p.route(/\/en-m-[\w-]{8}\.js$/, async (r) => { await new Promise((ok) => setTimeout(ok, 1000)); released = Date.now(); await r.continue(); });
    await p.addInitScript(() => {
      const seen: Array<{ ran: boolean; e: string | null; all: string | null }> = [];
      (globalThis as { __seen?: typeof seen }).__seen = seen;
      const tick = () => { seen.push({ ran: !!(globalThis as { __top?: unknown }).__top, e: document.getElementById('e')?.textContent ?? null, all: document.getElementById('all')?.textContent ?? null }); if (seen.length < 40) setTimeout(tick, 50); else document.getElementById('more')!.click(); };
      tick();
    });
    const t0 = Date.now();
    await p.goto(`${server.origin}/en/`, { waitUntil: 'networkidle' });
    await p.waitForFunction(() => (globalThis as { __seen?: unknown[] }).__seen!.length >= 40 && document.getElementById('all')?.textContent !== '');
    const seen = await p.evaluate(() => (globalThis as { __seen?: Array<{ ran: boolean; e: string | null; all: string | null }> }).__seen!);
    expect(released - t0).toBeGreaterThanOrEqual(1000);
    // before the page module ran (the file not there yet): the head script's message is shown, from the page
    const before = seen.filter((x) => !x.ran && x.e !== null);
    expect(before.length).toBeGreaterThan(5);
    expect(new Set(before.map((x) => x.e))).toEqual(new Set(['Shown early']));
    // at no time a key, or an empty text where a message goes
    for (const x of seen) {
      if (x.e !== null) expect(x.e).toBe('Shown early');
      if (x.all) expect(x.all.split('|').every((t) => t.startsWith('Text number'))).toBe(true);
    }
    expect(await top(p)).toEqual(['Called at the top', expect.stringContaining('Text number 0')]);
    expect((await text(p, 'all'))!.split('|').every((t) => t.startsWith('Text number'))).toBe(true);
    // the page module ran only once the file was there
    const ranAt = seen.findIndex((x) => x.ran);
    expect(ranAt * 50).toBeGreaterThanOrEqual(900);
    expect(errors).toEqual([]);
    await p.close();
  }, 60_000);
});
