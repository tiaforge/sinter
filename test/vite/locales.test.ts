// @vitest-environment node
// Languages in the URL (`sinter({ localePrefix: true })`, docs/static-pages.md#languages): each page once per
// language under its prefix, its text in the HTML; a chooser at each unprefixed URL; hreflang; the rules.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build, createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { viteProject } from '../../src/project.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-locales-'));
const out = join(root, 'dist');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const head = '<meta charset="utf-8"><title data-sn-text="m.title()">x</title><meta name="description" data-sn-attr="{ content: m.desc() }">';
const switcher = '<nav><a hreflang="en" data-sn-attr="{ href: localeUrl(\'en\') }">English</a> <a hreflang="de" data-sn-attr="{ href: localeUrl(\'de\') }">Deutsch</a> <a href="/index.html">Home</a> <a href="/article/hello">Article</a></nav>';
const files: Record<string, string> = {
  'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de'] }),
  'messages/en.json': JSON.stringify({ title: 'About', desc: 'Who we are', hello: 'Hello' }),
  'messages/de.json': JSON.stringify({ title: 'Über uns', desc: 'Wer wir sind', hello: 'Hallo' }),
  'index.html': `<!doctype html><html lang="en"><head>${head}</head><body>${switcher}<p data-sn-text="m.hello()"></p><img src="img/logo.svg" alt=""></body></html>`,
  'about.html': `<!doctype html><html lang="en"><head>${head}</head><body>${switcher}<h1 data-sn-text="m.title()"></h1></body></html>`,
  'article.html': `<!doctype html><html lang="en" data-sn-path="/article/:slug"><head>${head}</head><body>${switcher}<h1 data-sn-text="$url.slug"></h1><p data-sn-text="greet()"></p><p data-sn-text="$url.slug ? m.title() : \'\'"></p></body></html>`,
  // an app module that calls a message
  'src/sinter.helpers.js': "import { m } from '@tiaforge-ui/sinter/messages';\nexport const greet = () => m.hello();\n",
  'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
};
beforeAll(async () => {
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, site: 'https://example.com' })], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0, rollupOptions: { input: ['index.html', 'about.html', 'article.html'].map((f) => join(root, f)) } } });
}, 60_000);
const read = (f: string) => readFileSync(join(out, f), 'utf8');

describe('each page in each language', () => {
  test('the files: under each prefix, and a chooser at each unprefixed URL', () => {
    for (const f of ['en/index.html', 'de/index.html', 'en/about/index.html', 'de/about/index.html', 'en/article.html', 'de/article.html', 'index.html', 'about/index.html', 'article.html', 'about.html']) expect(existsSync(join(out, f)), f).toBe(true);
  });

  test('the language\'s text in the HTML, in text and attributes; <html lang>; no JavaScript on a page with nothing to run', () => {
    const de = read('de/about/index.html');
    expect(de).toMatch(/^<!DOCTYPE html><html lang="de">/);
    expect(de).toContain('<title>Über uns</title>');
    expect(de).toContain('<meta name="description" content="Wer wir sind">');
    expect(de).toContain('<h1>Über uns</h1>');
    expect(de).not.toMatch(/<script(?! type="speculationrules")/);
    expect(read('en/about/index.html')).toContain('<h1>About</h1>');
  });

  test('links stay in the language; the switcher\'s links name the other language; relative URLs follow the page', () => {
    const de = read('de/about/index.html');
    expect(de).toContain('<a hreflang="en" href="/en/about/">English</a> <a hreflang="de" href="/de/about/">Deutsch</a> <a href="/de/">Home</a>');
    expect(read('de/index.html')).toMatch(/<img src="\/assets\/logo-[\w-]+\.svg" alt="">/);
  });

  test('hreflang: each language\'s URL and x-default for the chooser, absolute; the canonical link', () => {
    const de = read('de/about/index.html');
    expect(de).toContain('<link rel="alternate" hreflang="en" href="https://example.com/en/about/">');
    expect(de).toContain('<link rel="alternate" hreflang="de" href="https://example.com/de/about/">');
    expect(de).toContain('<link rel="alternate" hreflang="x-default" href="https://example.com/about/">');
    expect(de).toContain('<link rel="canonical" href="https://example.com/de/about/">');
  });

  test('a page whose path is a pattern: its pattern under the prefix', () => {
    const de = read('de/article.html');
    expect(de).toMatch(/^<!DOCTYPE html><html lang="de">/);
    expect(de).toContain('<script');
  });

  test('a page that runs: its messages compiled in, the app modules\' in the page; no picker, no language file', () => {
    const de = read('de/article.html');
    expect(de).not.toContain('data-sn-i18n');
    expect(de).toContain('<script type="application/json" data-sn-messages>{"hello":"Hallo"}</script>');
    expect(readdirSync(join(out, 'assets')).filter((f) => /-(en|de)-[\w-]+\.js$/.test(f))).toEqual([]);
    const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => read(`assets/${f}`)).join('\n');
    expect(js).toContain('Über uns');
    expect(js).not.toContain('Wer wir sind');
  });
});

describe('the unprefixed URLs and the rules', () => {
  test('a chooser: the base language without scripts, the visitor\'s with them; noindex; hreflang', () => {
    const c = read('about/index.html');
    expect(c).toContain('<meta http-equiv="refresh" content="0; url=/en/about/">');
    expect(c).toContain('<meta name="robots" content="noindex">');
    expect(c).toContain('<link rel="alternate" hreflang="de" href="https://example.com/de/about/">');
    // the article page ships JavaScript, so the site records the language: the choosers follow it
    expect(c).toContain('locale=([^;]*)');
    expect(read('article.html')).toContain('<meta http-equiv="refresh" content="0; url=/en/">');
    // the old file URL is the chooser too: one hop to a language, which it names directly
    expect(read('about.html')).toContain('<meta http-equiv="refresh" content="0; url=/en/about/">');
    expect(read('about.html')).toContain('location.replace({"en":"/en/about/","de":"/de/about/"}[l]');
  });

  test('_redirects: each language\'s rules, then the choosers\'', () => {
    expect(read('_redirects').split('\n').filter((l) => l && !l.startsWith('#'))).toEqual([
      '/en/about.html  /en/about/  301',
      '/de/about.html  /de/about/  301',
      '/about.html  /about/  200',
      '/en/article/:slug  /en/article  200',
      '/de/article/:slug  /de/article  200',
      '/article/:slug  /article  200',
    ]);
  });
});

test('the dev server: a page in a language at its URL, a chooser at an unprefixed one', async () => {
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, site: 'https://example.com' })], server: { port: 0 } });
  await server.listen();
  try {
    const base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    const de = await (await fetch(`${base}/de/about/`)).text();
    expect(de).toContain('<h1>Über uns</h1>');
    expect(de).toContain('<html lang="de">');
    const art = await (await fetch(`${base}/de/article/hello`)).text();
    expect(art).toContain('<html lang="de">');
    const r = await fetch(`${base}/de/about`, { redirect: 'manual' });
    expect([r.status, r.headers.get('location')]).toEqual([301, '/de/about/']);
    expect(await (await fetch(`${base}/about/`)).text()).toContain('url=/en/about/');
  } finally {
    await server.close();
  }
}, 60_000);

test('sinter check: the pages from the Vite config are the sources, once each, not each page per language', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinter-locales-check-'));
  try {
    for (const f of ['project.inlang/settings.json', 'messages/en.json', 'messages/de.json', 'index.html', 'about.html']) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), files[f]!); }
    writeFileSync(join(dir, 'vite.config.js'), `import sinter from ${JSON.stringify(join(src, 'vite.ts'))};\nexport default { plugins: [sinter({ localePrefix: true })], build: { rollupOptions: { input: ['index.html', 'about.html'] } } };\n`);
    const { pages } = await viteProject(dir);
    expect(pages.sort()).toEqual([join(dir, 'about.html'), join(dir, 'index.html')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
