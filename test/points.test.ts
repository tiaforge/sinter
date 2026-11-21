// @vitest-environment node
// Points (src/points.ts, docs/proposals/axes.md §1): every source page in every language, a page per entry's entries
// in each language, where each is written, the translations, and the collisions.
import { expect, test } from 'vitest';
import { entryChooserPath, listPoints, pointRel, translationKey } from '../src/points.js';

const e = (key: string, path: string) => ({ key, path, value: { key } });
const posts = (l: string | null) => (l === 'de' ? [e('a', '/blog/hallo'), e('c', '/blog/nur-de')] : [e('a', '/blog/hello'), e('b', '/blog/recap')]);
const sources = [
  { source: '/r/index.html', rel: 'index.html', entries: null },
  { source: '/r/blog/post.html', rel: 'blog/post.html', entries: posts },
];

test('pointRel: under the language, at the entry\'s path or the source\'s file', () => {
  expect([pointRel('about.html', 'de', null), pointRel('about.html', null, null), pointRel('', 'de', 'blog/x'), pointRel('', null, 'blog/x')]).toEqual(['de/about.html', 'about.html', 'de/blog/x.html', 'blog/x.html']);
});

test('without languages: each page once, each entry at its path', () => {
  const { points, translations } = listPoints({ sources, locales: null, base: '/' });
  expect(points.map((p) => [p.rel, p.locale, p.entry?.key ?? null])).toEqual([['index.html', null, null], ['blog/hello.html', null, 'a'], ['blog/recap.html', null, 'b']]);
  expect(translations.size).toBe(0);
});

test('with languages: each page and each language\'s own entries under its prefix; entries with one key are translations', () => {
  const { points, translations } = listPoints({ sources, locales: ['en', 'de'], base: '/' });
  expect(points.map((p) => p.rel)).toEqual(['en/index.html', 'de/index.html', 'en/blog/hello.html', 'en/blog/recap.html', 'de/blog/hallo.html', 'de/blog/nur-de.html']);
  expect(Object.fromEntries(translations.get('/r/blog/post.html\0a')!)).toEqual({ en: '/blog/hello', de: '/blog/hallo' });
  // the chooser at an entry's unprefixed path: the base language's entry, else the first language that has it
  const k = (src: string, key: string) => translationKey(src, [], key);
  expect([entryChooserPath(translations, k('/r/blog/post.html', 'a'), 'en'), entryChooserPath(translations, k('/r/blog/post.html', 'c'), 'en'), entryChooserPath(translations, k('/r/x.html', 'a'), 'en')]).toEqual(['/blog/hello', '/blog/nur-de', null]);
});

test('under a base: an entry\'s file is its path after the base', () => {
  const { points } = listPoints({ sources, locales: null, base: '/docs/' });
  expect(points.map((p) => p.rel)).toEqual(['index.html', 'blog/hello.html', 'blog/recap.html']);
});

test('collisions: an entry where a plain page is, in any language, or where public/ has a file', () => {
  const clash = [{ source: '/r/blog/hello.html', rel: 'blog/hello.html', entries: null }, ...sources.slice(1)];
  expect(() => listPoints({ sources: clash, locales: ['en', 'de'], base: '/' })).toThrow('blog/post.html: the entry at `/en/blog/hello` would be written where `en/blog/hello.html` is');
  expect(() => listPoints({ sources, locales: null, base: '/', inPublic: (rel) => rel === 'blog/recap' })).toThrow('the entry at `/blog/recap` would be written where `public/blog/recap.html` is');
  const twice = [...sources, { source: '/r/blog/other.html', rel: 'blog/other.html', entries: () => [e('x', '/blog/hello')] }];
  expect(() => listPoints({ sources: twice, locales: null, base: '/' })).toThrow('blog/other.html: the entry at `/blog/hello` would be written where `blog/post.html (/blog/hello)` is');
});

test('axes: each variant under its segments, after the language\'s; its own entries; collisions across variants', () => {
  const tenants = [{ value: { key: 'acme' }, key: 'acme', segment: 'acme' }, { value: { key: 'globex' }, key: 'globex', segment: 'globex' }];
  const shop = { source: '/r/shop.html', rel: 'shop.html', variants: () => tenants.map((t) => ({ axes: [t], entries: null })) };
  const blog = { source: '/r/blog/post.html', rel: 'blog/post.html', variants: (l: string | null) => tenants.map((t) => ({ axes: [t], entries: [e(`${t.key}-1`, `/blog/${t.key}-${l}`)] })) };
  const { points, translations } = listPoints({ sources: [shop, blog], locales: ['en', 'de'], base: '/' });
  expect(points.map((p) => p.rel)).toEqual(['en/acme/shop.html', 'en/globex/shop.html', 'de/acme/shop.html', 'de/globex/shop.html',
    'en/acme/blog/acme-en.html', 'en/globex/blog/globex-en.html', 'de/acme/blog/acme-de.html', 'de/globex/blog/globex-de.html']);
  // translations pair one tenant's entries across languages, not across tenants
  expect(Object.fromEntries(translations.get(translationKey('/r/blog/post.html', [tenants[0]!], 'acme-1'))!)).toEqual({ en: '/blog/acme-en', de: '/blog/acme-de' });
  const clash = { source: '/r/x.html', rel: 'x.html', variants: () => [{ axes: [tenants[0]!], entries: [e('s', '/shop')] }] };
  expect(() => listPoints({ sources: [shop, clash], locales: null, base: '/' })).toThrow('x.html: the entry at `/acme/shop` would be written where `acme/shop.html` is');
});
