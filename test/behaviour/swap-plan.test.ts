// The swap's plan on parsed documents (docs/proposals/swap-navigation.md §3, §4): which elements are kept,
// which head nodes are the page's own, what only a load applies, and which URLs the build's list swaps to.
import { expect, test } from 'vitest';
import { fixed, fonts, heads, inline, owned, pairs } from '../../src/swap-run.js';
import type { SwapState } from '../../src/swap.js';
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
  const d = parse('', '<meta charset="utf-8"><title data-sn="0">x</title><meta name="description" data-sn="1"><!--sn 2--><meta name="robots"><!--sn 3--><b></b><!--/sn--><!--/sn--><link rel="icon" href="/i.png"><template id="sn-t-0"></template><script type="application/json" data-sn="4">{}</script><script type="application/json" data-sn-ns="m">{}</script><meta name="theme-color">');
  expect(owned(d.head).map((n) => (n.nodeType == 8 ? `<!--${(n as Comment).data}-->` : (n as Element).localName + ((n as Element).getAttribute('name') ? `[${(n as Element).getAttribute('name')}]` : '')))).toEqual([
    'title', 'meta[description]', '<!--sn 2-->', 'meta[robots]', '<!--sn 3-->', 'b', '<!--/sn-->', '<!--/sn-->', 'template', 'script', 'script',
  ]);
});

test('what only a load applies: a CSP <meta>, <base>, the page\'s language', () => {
  const base = new URL('http://localhost/');
  const plain = fixed(parse('', '<title>a</title>'), base);
  expect(fixed(parse('', '<title>b</title><meta name="x">'), base)).toBe(plain);
  expect(fixed(parse('', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'), base)).not.toBe(plain);
  expect(fixed(parse('', '<base href="/app/">'), base)).not.toBe(plain);
  // a page in another language (`localePrefix`: /en/ → /de/)
  const lang = (l: string) => { const d = parse(''); d.documentElement.lang = l; return fixed(d, base); };
  expect(lang('en')).not.toBe(lang('de'));
  expect(lang('en')).toBe(lang('EN'));
});

test('a page in one language: the content namespaces\' entries its modules call (data-sn-ns) join the dictionary', () => {
  const K = Symbol.for('sinter.i18n'), g = globalThis as unknown as Record<symbol, unknown>, was = g[K];
  g[K] = { locale: 'en', dicts: { en: { a: 'A' } } };
  try {
    inline(parse('', '<script type="application/json" data-sn-ns="m">{"b":"B"}</script>'));
    expect((g[K] as { dicts: unknown }).dicts).toEqual({ en: { a: 'A', b: 'B' } });
    // none, or unreadable: as it was
    inline(parse('', '<script type="application/json" data-sn-ns="m">{</script>'));
    expect((g[K] as { dicts: unknown }).dicts).toEqual({ en: { a: 'A', b: 'B' } });
  } finally { g[K] = was; }
});

test('the build\'s list: a URL swaps only to a page that answers at its path', () => {
  const list = [{ m: ['/', '/index.html'] }, { m: ['/about/', '/about'], k: ['player'] }, { m: ['/post/:slug'] }];
  expect(pageAt(list, '/')?.m[0]).toBe('/');
  expect(pageAt(list, '/about')?.k).toEqual(['player']);
  expect(pageAt(list, '/post/hello')?.m[0]).toBe('/post/:slug');
  expect(pageAt(list, '/post/hello/comments')).toBeUndefined();
  expect(pageAt(list, '/logout')).toBeUndefined();
});

test('the next page\'s stylesheets go in before the commit, applied only from it on; undone, they go', () => {
  const was = document.head.innerHTML;
  try {
    document.head.innerHTML = '<style>p { color: red }</style>';
    const s = { sheets: new Set(document.head.querySelectorAll('style')) } as unknown as SwapState;
    const next = parse('', '<style>p { color: red }</style><style>b { color: blue }</style><style media="print">i { color: blue }</style>');
    const h = heads(s, next, new URL(location.href))!;
    const media = () => [...document.head.querySelectorAll('style')].map((x) => x.getAttribute('media'));
    // the shared one stays as it is; the new ones are there (loading) but match nothing
    expect(media()).toEqual([null, 'not all', 'not all']);
    h.done();
    expect(media()).toEqual([null, null, 'print']);
    const again = heads({ sheets: new Set(document.head.querySelectorAll('style')) } as unknown as SwapState, parse('', '<style>i { color: green }</style>'), new URL(location.href))!;
    expect(document.head.querySelectorAll('style')).toHaveLength(4);
    again.undo();
    expect(document.head.querySelectorAll('style')).toHaveLength(3);
  } finally { document.head.innerHTML = was; }
});

test('the next page\'s fonts after `load` (<noscript data-sn-fonts>): a stylesheet of its head, unless the page shown has it', () => {
  const was = document.head.innerHTML, base = new URL('/next/', location.href);
  // happy-dom loads no stylesheet: a link it does not load counts as loaded, with no error printed
  const settings = (window as unknown as { happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM.settings, quiet = settings.handleDisabledFileLoadingAsSuccess;
  settings.handleDisabledFileLoadingAsSuccess = true;
  try {
    document.head.innerHTML = '';
    const next = () => parse('', '<link rel="stylesheet" href="/assets/app.css"><noscript data-sn-fonts><link rel="stylesheet" href="../assets/fonts-a.css"></noscript><noscript><link rel="stylesheet" href="/other.css"></noscript>');
    const d = next();
    fonts(d, base);
    expect([...d.head.children].map((x) => x.localName)).toEqual(['link', 'noscript', 'noscript', 'link']);
    expect(d.head.lastElementChild!.getAttribute('href')).toBe('../assets/fonts-a.css');
    // the page shown has it (its early file added it after its load): not again
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('../assets/fonts-a.css', base).href;
    document.head.append(l);
    const d2 = next();
    fonts(d2, base);
    expect(d2.head.querySelectorAll(':scope > link')).toHaveLength(1);
  } finally { document.head.innerHTML = was; settings.handleDisabledFileLoadingAsSuccess = quiet; }
});
