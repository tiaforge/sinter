// Same-page links (query-links.ts): a plain click on a link to this page that changes only query
// parameters the page reads stays in the page, as a new history entry; what follows is what loading
// the URL would show. Every other click is left to the browser.
import { expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { mockRequests, render, type RouteResponse } from '../../src/testing/index.js';

/**
 * A click as the browser dispatches it; returns whether sinter took it (prevented the default). A click
 * it leaves is stopped at the window, after recording that, so happy-dom does not follow the link.
 */
const click = (el: Element, init: MouseEventInit = {}) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  let took = false;
  const w = el.ownerDocument.defaultView!, stop = (x: Event) => { took = x.defaultPrevented; x.preventDefault(); };
  w.addEventListener('click', stop, { once: true });
  el.dispatchEvent(e);
  w.removeEventListener('click', stop);
  return took;
};

const ALL = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, tag: i % 2 ? 'js' : 'go' }));
const api = () => mockRequests({
  'GET /api/a': (call): RouteResponse => {
    const q = new URL(call.url, 'http://x').searchParams, page = Number(q.get('page')), all = ALL.filter((x) => !q.get('tag') || x.tag == q.get('tag'));
    return { items: all.slice((page - 1) * 2, page * 2), total: all.length };
  },
});
const LIST = `
  <sn-resource name="a" src="/api/a?tag={$url.tag}" items="items" total="total" key="id" paginate="offset" page-size="2" page-model="$url.page"></sn-resource>
  <span data-sn-text="[$meta.a.page, a.map((x) => x.id)].join(' ')"></span>
  <a id="p2" href="?page=2">2</a>
  <a id="js3" href="?tag=js&amp;page=3">js, 3</a>
  <a id="js" href="?tag=js">js</a>
  <a id="here" href="?page=2">here</a>
  <a id="lang" href="?lang=de">de</a>
  <a id="away" href="/other?page=2">other</a>
  <a id="new" href="?page=3" target="_blank">new tab</a>
  <a id="dl" href="?page=3" download>download</a>
  <a id="ext" href="?page=3" rel="external">external</a>
  <a id="hash" href="?page=3#list">3, list</a>
  <ol id="list"></ol>`;
async function setup(url = 'http://localhost/') {
  const requests = api();
  const r = await render(LIST, { requests, url });
  await r.settle();
  const shown = () => r.root.querySelector('span')!.textContent;
  const go = async (id: string, init?: MouseEventInit) => { const took = click(r.root.querySelector(`#${id}`)!, init); await r.settle(); return took; };
  return { ...r, requests, shown, go };
}

test('a link that changes only parameters the page reads stays in the page: one entry, the list follows', async () => {
  const p = await setup();
  expect(p.shown()).toBe('1 1,2');
  expect(await p.go('p2')).toBe(true);
  expect(p.url()).toBe('http://localhost/?page=2');
  expect(p.history()).toEqual(['http://localhost/', 'http://localhost/?page=2']);
  expect(p.shown()).toBe('2 3,4');
  expect(p.navigations).toEqual([]);
  // Back is the existing path: the URL's page
  await p.back();
  await p.settle();
  expect(p.shown()).toBe('1 1,2');
});

test('what loading the URL would show: a filter and a page show that page; a filter alone starts at 1', async () => {
  const p = await setup('http://localhost/?page=2');
  await p.go('js3');
  expect(p.url()).toBe('http://localhost/?tag=js&page=3');
  expect(p.shown()).toBe('3 ');
  await p.go('js');
  expect(p.url()).toBe('http://localhost/?tag=js');
  expect(p.shown()).toBe('1 2,4');
});

test('a link to the current URL changes nothing; a `#hash` is the browser\'s, in the new entry', async () => {
  const p = await setup('http://localhost/?page=2');
  expect(await p.go('here')).toBe(true);
  expect(p.history()).toHaveLength(1);
  expect(await p.go('hash')).toBe(true);
  expect(p.history()).toEqual(['http://localhost/?page=2', 'http://localhost/?page=3#list']);
  expect(p.shown()).toBe('3 5,6');
});

test('every other click is the browser\'s', async () => {
  const p = await setup();
  // a parameter the page does not read, another path, a new tab, a download, rel="external"
  for (const id of ['lang', 'away', 'new', 'dl', 'ext']) expect(await p.go(id), id).toBe(false);
  // modifier keys and other buttons
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) expect(await p.go('p2', init)).toBe(false);
  expect(p.history()).toHaveLength(1);
});

test('a handler that prevents the default keeps the click', async () => {
  const { root, settle, history } = await render(`<span data-sn-text="$url.page ?? '-'"></span><a href="?page=2" data-sn-on-click="$event.preventDefault()">2</a>`);
  click(root.querySelector('a')!);
  await settle();
  expect(history()).toHaveLength(1);
  expect(root.querySelector('span')!.textContent).toBe('-');
});

test('the build loads the module on a page with a link it sees goes to the page itself', () => {
  const opts = (file = '/p/index.html') => ({ file, root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); } });
  const features = (html: string, file?: string) => compileParts(html, opts(file)).features;
  // a static query link, a bound one on the page's pattern, a layout-like link to the page's own path
  expect(features('<p data-sn-text="$url.q"></p><a href="?q=a">a</a>')).toContain('query-links');
  expect(features(`<html data-sn-path="/ /tag/:tag"><body><p data-sn-text="$url.page"></p>
    <a data-sn-attr="{ href: ($url.tag ? '/tag/' + encodeURIComponent($url.tag) : '/') + '?page=' + 2 }">2</a></body></html>`)).toContain('query-links');
  expect(features('<p data-sn-text="$url.feed"></p><a href="/about/?feed=x">x</a>', '/p/about.html')).toContain('query-links');
  // another page's link, a page reading no parameter, a link the build cannot see, `$url` read whole
  expect(features('<p data-sn-text="$url.q"></p><a href="/other/?q=a">a</a>')).not.toContain('query-links');
  expect(features('<a href="?q=a">a</a>')).not.toContain('query-links');
  expect(features('<p data-sn-state="{ u: \'?q=a\' }" data-sn-text="$url.q"><a data-sn-attr="{ href: u }">a</a></p>')).not.toContain('query-links');
  expect(features('<p data-sn-text="JSON.stringify($url)"></p><a href="?q=a">a</a>')).not.toContain('query-links');
});

test('SN519: a static query-only href that drops parameters the page reads', () => {
  const d = compileParts('<p data-sn-text="$url.tag + $url.page"></p><a href="?page=2">2</a><a href="?tag=go&amp;page=2">ok</a>', { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '' }).diagnostics;
  expect(d.map((x) => [x.code, x.message])).toEqual([['SN519', '`?page=2` keeps only its own query: `tag`, which this page reads, is dropped when it is followed']]);
});

test('typing waits to commit, then a link: the typed query gets its own entry first', async () => {
  const requests = mockRequests({ 'GET /api/s': { items: [] } });
  const r = await render(`<sn-resource name="s" src="/api/s?q={$url.q}&sort={$url.sort}" items="items"></sn-resource>
    <input data-sn-model="$url.q"><a href="?sort=new">new</a>`, { requests });
  await r.settle();
  const field = r.root.querySelector('input')!;
  field.value = 'sin'; field.dispatchEvent(new Event('input', { bubbles: true }));
  await r.flush();
  // the link keeps no `q`: following it is what loading `?sort=new` shows
  click(r.root.querySelector('a')!);
  await r.settle();
  expect(r.history()).toEqual(['http://localhost/', 'http://localhost/?q=sin', 'http://localhost/?sort=new']);
  expect(field.value).toBe('');
});

test('hovering a same-page link prefetches nothing: the click stays in the page', async () => {
  const { HOVER } = await import('../../src/prefetch.js');
  const { memoryStorage } = await import('../../src/testing/index.js');
  const requests = mockRequests({ 'GET /api/s': { items: [] } });
  const html = `<sn-resource name="s" src="/api/s?tag={$url.tag}" items="items"></sn-resource><a href="?tag=go">go</a>`;
  // next-page data knows this page as `/`: without the module it would request `?tag=go`'s data
  const r = await render(html, { requests, session: memoryStorage(), pages: { 'index.html': html } });
  await r.settle();
  const before = requests.calls.length;
  r.root.querySelector('a')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  await r.advance(HOVER);
  await r.settle();
  expect(requests.calls.length).toBe(before);
});
