// @vitest-environment node
// The language axis's own rules (src/locales.ts, docs/proposals/axes.md §4): prefixes, the language of an output file,
// choosing a visitor's language, and the chooser page's script applying the same rule as the server layer.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { chain, checkFallbacks, chooseLanguage, chooserHtml, hreflangTags, inLanguage, inPoint, languageOfFile, manifestLocales, prefixPaths, requestLanguages, segmentOf, siteRoot } from '../src/locales.js';

const site = { base: 'en', list: ['en', 'de', 'pt-BR'] };

test('prefixPaths: under the language, after the base; a path outside the base as written', () => {
  expect(prefixPaths(['/', '/about/', '/article/:slug'], 'de')).toEqual(['/de/', '/de/about/', '/de/article/:slug']);
  expect(prefixPaths(['/docs/', '/docs/a/:id', '/other'], 'de', '/docs')).toEqual(['/docs/de/', '/docs/de/a/:id', '/other']);
  expect(prefixPaths(['/a'], 'de', './')).toEqual(['/de/a']);
  expect([siteRoot(undefined), siteRoot('./'), siteRoot('/x'), siteRoot('/x/')]).toEqual(['/', '/', '/x/', '/x/']);
});

test('languageOfFile: its first folder when that is a language', () => {
  expect([languageOfFile('de/about.html', site.list), languageOfFile('about.html', site.list), languageOfFile('dev/x.html', site.list)]).toEqual(['de', null, null]);
});

test('manifestLocales: the languages and the base they are under', () => {
  expect(manifestLocales(site, '/docs')).toEqual({ ...site, at: '/docs/' });
});

/** the cases every implementation of the rule runs (test/fixtures/choose-cases.json) */
const CASES: Array<{ base: string; list: string[]; tags: string[]; want: string }> = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/choose-cases.json'), 'utf8')).cases;

describe('choosing the visitor\'s language', () => {
  test('chooseLanguage: the shared cases', () => {
    for (const c of CASES) expect(chooseLanguage(c, c.tags), `${c.list} ${c.tags}`).toBe(c.want);
  });

  test('a request: the `locale` cookie first, then Accept-Language in its order', () => {
    expect(requestLanguages('a=1; locale=de; b=2', 'fr-FR,fr;q=0.9,en;q=0.8')).toEqual(['de', 'fr-FR', 'fr', 'en']);
    expect(chooseLanguage(site, requestLanguages('locale=xx', 'pt-BR,en'))).toBe('pt-BR');
    expect(chooseLanguage(site, requestLanguages(null, null))).toBe('en');
  });

  test('the chooser page\'s script applies the same rule, to the language\'s URL: the shared cases', () => {
    const go = (c: { base: string; list: string[] }, cookie: string, languages: string[]) => {
      const html = chooserHtml({ base: '/', locales: c, fallback: `/${c.base}/`, urls: Object.fromEntries(c.list.map((l) => [l, `/${l}/a/`])), hreflang: '', script: true });
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
      let to = '';
      runInNewContext(script, { document: { cookie }, navigator: { languages }, location: { search: '', hash: '', pathname: '/a/', replace: (u: string) => { to = u; } } });
      return to;
    };
    // (Accept-Language's `;q=` is a server's to read: the browser's list has none)
    for (const c of CASES.filter((x) => !x.tags.some((t) => t.includes(';')))) expect(go(c, '', c.tags), `${c.list} ${c.tags}`).toBe(`/${c.want}/a/`);
    expect(go(site, 'locale=de', ['pt-BR'])).toBe('/de/a/');
  });
});

test('inLanguage: a URL\'s start that names one of the site\'s pages, under the language; anything else as written', () => {
  const pages = ['/', '/index.html', '/about/', '/about.html', '/article/:slug', '/blog/:slug', '/u/:name/posts'];
  const at = (s: string, base?: string, ps = pages) => inLanguage(s, 'de', site, base, ps);
  expect(at('/article/')).toBe('/de/article/');
  expect(at('/article/x-')).toBe('/de/article/x-');
  expect(at('/u/')).toBe('/de/u/');
  expect(at('/u/x/posts?tab=')).toBe('/de/u/x/posts?tab=');
  expect(at('/about/?q=')).toBe('/de/about/?q=');
  expect(at('/abo')).toBe('/de/abo');
  // not a page: an API, a file, another folder; `/` alone; already in a language; another origin; query or hash only
  for (const s of ['/api/', '/img/x', '/other/', '/', '/de/article/', '//cdn.example.com/', 'https://x.org/', '?page=', '#top', '/article?x=']) expect(at(s), s).toBe(s);
  // under a base
  expect(at('/docs/article/', '/docs/', ['/docs/article/:slug'])).toBe('/docs/de/article/');
  expect(at('/article/', '/docs/', ['/docs/article/:slug'])).toBe('/article/');
});

test('localSignIn: the API\'s sign-in page in the page\'s language, when it is one of the site\'s pages', async () => {
  const { localSignIn } = await import('../src/compiler/compile.js');
  const l = { name: 'de', urls: null, base: '/', list: ['en', 'de'], pages: ['/login', '/login.html'] };
  expect(localSignIn({ to: '/login', returnUrl: { allow: ['/'] } }, l)).toEqual({ to: '/de/login', returnUrl: { allow: ['/'] } });
  expect(localSignIn({ to: 'https://auth.example.com/' }, l).to).toBe('https://auth.example.com/');
  expect(localSignIn({ to: '/login' }, undefined).to).toBe('/login');
});

test('chain: the tag less its subtags where the site has them, then the base; `fallbacks` replaces the middle', () => {
  const l = { base: 'en', list: ['en', 'de', 'de-AT', 'de-CH', 'zh-Hant', 'zh-Hant-TW'] };
  expect(chain('de-AT', l)).toEqual(['de-AT', 'de', 'en']);
  expect(chain('zh-Hant-TW', l)).toEqual(['zh-Hant-TW', 'zh-Hant', 'en']);
  expect(chain('en', l)).toEqual(['en']);
  expect(chain('de-CH', { ...l, fallbacks: { 'de-CH': ['de-AT', 'de'] } })).toEqual(['de-CH', 'de-AT', 'de', 'en']);
  expect(checkFallbacks({ ...l, fallbacks: { 'de-CH': ['de-AT'] } })).toBeNull();
  expect(checkFallbacks({ ...l, fallbacks: { fr: ['de'] } })).toMatch(/names `fr`, which is not one of the site's languages/);
  expect(checkFallbacks({ ...l, fallbacks: { 'de-CH': ['it'] } })).toMatch(/names `it`/);
  expect(checkFallbacks({ ...l, fallbacks: { 'de-CH': ['de-AT'], 'de-AT': ['de-CH'] } })).toMatch(/name each other/);
});

test('a language\'s segment (`paths`) and its codes: the chooser\'s URLs and rule, hreflang, the prefixes', () => {
  const l = { base: 'en', list: ['en', 'de-AT', 'no'], paths: { 'de-AT': 'at' }, codes: { no: ['nb', 'nn'] } };
  expect(segmentOf('de-AT', l)).toBe('at');
  expect(segmentOf('no', l)).toBe('no');
  expect(languageOfFile('at/about.html', l.list, l.paths)).toBe('de-AT');
  expect(inLanguage('/about/', 'de-AT', l, '/', ['/about/'])).toBe('/at/about/');
  expect(inLanguage('/at/about/', 'de-AT', l, '/', ['/about/'])).toBe('/at/about/');
  // a page whose paths have parameters: the chooser goes to the same path under the segment
  const html = chooserHtml({ base: '/', locales: l, fallback: '/en/', urls: null, hreflang: '', script: true });
  expect(html).toContain('<a href="/at/" hreflang="de-AT">de-AT</a>');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const go = (languages: string[]) => { let to = ''; runInNewContext(script, { document: { cookie: '' }, navigator: { languages }, location: { search: '', hash: '', pathname: '/u/1', replace: (u: string) => { to = u; } } }); return to; };
  expect(go(['de-AT'])).toBe('/at/u/1');
  expect(go(['nb-NO'])).toBe('/no/u/1');
  expect(hreflangTags('https://x.org', { no: '/no/' }, '/', l.codes)).toBe('<link rel="alternate" hreflang="no" href="https://x.org/no/">\n  <link rel="alternate" hreflang="nb" href="https://x.org/no/">\n  <link rel="alternate" hreflang="nn" href="https://x.org/no/">\n  <link rel="alternate" hreflang="x-default" href="https://x.org/">');
  expect(manifestLocales(l, '/')).toEqual({ ...l, at: '/' });
});

test('a point\'s prefixes: a literal start under the most specific one whose pages it names (inPoint)', () => {
  const levels = [{ prefix: 'de/acme', pages: ['/about/', '/blog/:slug'] }, { prefix: 'de', pages: ['/faq/'] }];
  const at = (s: string) => levels.map((l) => inPoint(s, l.prefix, '/', l.pages)).find((r) => r !== s) ?? s;
  expect(at('/blog/')).toBe('/de/acme/blog/');
  expect(at('/faq/?q=')).toBe('/de/faq/?q=');
  for (const s of ['/api/x', '/de/acme/blog/', 'https://x.org/blog/']) expect(at(s), s).toBe(s);
});
