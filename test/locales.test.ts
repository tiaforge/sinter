// @vitest-environment node
// The language axis's own rules (src/locales.ts, docs/proposals/axes.md §4): prefixes, the language of an output file,
// choosing a visitor's language, and the chooser page's script applying the same rule as the server layer.
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { chooseLanguage, chooserHtml, inLanguage, languageOfFile, manifestLocales, prefixPaths, requestLanguages, siteRoot } from '../src/locales.js';

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

/** tags in order → the language: exact (any case), else the language part, else the base */
const CASES: Array<[string[], string]> = [
  [[], 'en'],
  [['de'], 'de'],
  [['DE'], 'de'],
  [['de-AT'], 'de'],
  [['pt-br'], 'pt-BR'],
  [['pt'], 'en'],
  [['fr', 'de'], 'de'],
  [['fr-FR', 'fr'], 'en'],
];

describe('choosing the visitor\'s language', () => {
  test('chooseLanguage', () => {
    for (const [tags, want] of CASES) expect(chooseLanguage(site, tags), tags.join()).toBe(want);
  });

  test('a request: the `locale` cookie first, then Accept-Language in its order', () => {
    expect(requestLanguages('a=1; locale=de; b=2', 'fr-FR,fr;q=0.9,en;q=0.8')).toEqual(['de', 'fr-FR', 'fr', 'en']);
    expect(chooseLanguage(site, requestLanguages('locale=xx', 'pt-BR,en'))).toBe('pt-BR');
    expect(chooseLanguage(site, requestLanguages(null, null))).toBe('en');
  });

  test('the chooser page\'s script applies the same rule, to the language\'s URL', () => {
    const html = chooserHtml({ base: '/', locales: site, fallback: '/en/', urls: { en: '/en/a/', de: '/de/a/', 'pt-BR': '/pt-BR/a/' }, hreflang: '', script: true });
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const go = (cookie: string, languages: string[]) => {
      let to = '';
      runInNewContext(script, { document: { cookie }, navigator: { languages }, location: { search: '', hash: '', pathname: '/a/', replace: (u: string) => { to = u; } } });
      return to;
    };
    for (const [tags, want] of CASES) expect(go('', tags), tags.join()).toBe(`/${want}/a/`);
    expect(go('locale=de', ['pt-BR'])).toBe('/de/a/');
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
