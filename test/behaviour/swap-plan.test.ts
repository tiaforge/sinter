// The swap's plan on parsed documents (docs/proposals/swap-navigation.md §3, §4): which elements are kept,
// which head nodes are the page's own, what only a load applies, and which URLs the build's list swaps to.
import { expect, test } from 'vitest';
import { fixed, owned, pairs } from '../../src/swap-run.js';
import { pageAt } from '../../src/swap.js';

const parse = (body: string, head = '') => new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, 'text/html');

test('kept elements: the names both page modules keep, once on each page, the same element', () => {
  const cur = parse('<aside data-sn-permanent="player">a</aside><nav data-sn-permanent="menu"></nav>');
  const next = parse('<aside data-sn-permanent="player">b</aside><div data-sn-permanent="menu"></div>');
  const got = pairs(cur, next, ['player', 'menu'], ['player', 'menu'])!;
  // `menu` is another element on the next page: not kept
  expect(got.map(([o, n]) => [o.textContent, n.textContent])).toEqual([['a', 'b']]);
  // a name only one page module keeps: not kept
  expect(pairs(cur, next, ['menu'], ['player', 'menu'])).toEqual([]);
});

test('a marker the page modules do not list keeps nothing (injected markup); a listed name twice is a load', () => {
  const cur = parse('<aside data-sn-permanent="player"></aside><div data-sn-permanent="evil"></div>');
  const next = parse('<aside data-sn-permanent="player"></aside><div data-sn-permanent="evil"></div>');
  expect(pairs(cur, next, ['player'], ['player'])!.map(([o]) => o.localName)).toEqual(['aside']);
  const twice = parse('<aside data-sn-permanent="player"></aside><aside data-sn-permanent="player"></aside>');
  expect(pairs(twice, next, ['player'], ['player'])).toBeNull();
  expect(pairs(cur, twice, ['player'], ['player'])).toBeNull();
  // listed by the next page's module but missing from its HTML: a load
  expect(pairs(cur, parse('<p></p>'), ['player'], ['player'])).toBeNull();
});

test('the head nodes that are the page\'s own: the title, bound nodes, anchors with what they rendered, templates, data', () => {
  const d = parse('', '<meta charset="utf-8"><title data-sn="0">x</title><meta name="description" data-sn="1"><!--sn 2--><meta name="robots"><!--sn 3--><b></b><!--/sn--><!--/sn--><link rel="icon" href="/i.png"><template id="sn-t-0"></template><script type="application/json" data-sn="4">{}</script><script type="application/json" data-sn-messages>{}</script><meta name="theme-color">');
  expect(owned(d.head).map((n) => (n.nodeType == 8 ? `<!--${(n as Comment).data}-->` : (n as Element).localName + ((n as Element).getAttribute('name') ? `[${(n as Element).getAttribute('name')}]` : '')))).toEqual([
    'title', 'meta[description]', '<!--sn 2-->', 'meta[robots]', '<!--sn 3-->', 'b', '<!--/sn-->', '<!--/sn-->', 'template', 'script', 'script',
  ]);
});

test('what only a load applies: a CSP <meta>, <base>, the language picker', () => {
  const base = new URL('http://localhost/');
  const plain = fixed(parse('', '<title>a</title>'), base);
  expect(fixed(parse('', '<title>b</title><meta name="x">'), base)).toBe(plain);
  expect(fixed(parse('', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'), base)).not.toBe(plain);
  expect(fixed(parse('', '<base href="/app/">'), base)).not.toBe(plain);
  expect(fixed(parse('<script data-sn-i18n="de"></script>'), base)).not.toBe(plain);
});

test('the build\'s list: a URL swaps only to a page that answers at its path', () => {
  const list = [{ m: ['/', '/index.html'] }, { m: ['/about/', '/about'], k: ['player'] }, { m: ['/post/:slug'] }];
  expect(pageAt(list, '/')?.m[0]).toBe('/');
  expect(pageAt(list, '/about')?.k).toEqual(['player']);
  expect(pageAt(list, '/post/hello')?.m[0]).toBe('/post/:slug');
  expect(pageAt(list, '/post/hello/comments')).toBeUndefined();
  expect(pageAt(list, '/logout')).toBeUndefined();
});
