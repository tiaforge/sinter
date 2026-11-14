// `page-model="$url.page"` on an offset list: the URL is the single source. page() writes the
// parameter (a history entry) and the pager follows it; the first URL after mount restores it;
// a filter change starts at page 1 (a replace); Back and Forward load the URL's page.
import { describe, expect, test } from 'vitest';
import { mockRequests, render, type RouteResponse } from '../../src/testing/index.js';

const ALL = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, tag: i % 2 ? 'js' : 'go' }));
/** `/api/a?tag=…&page=…&limit=…`: the items of that page (`total` with `?total`), or a failure for `fail` */
const api = (o: { total?: boolean; fail?: Set<string>; wait?: boolean } = {}) => mockRequests({
  'GET /api/a': (call): RouteResponse => {
    const q = new URL(call.url, 'http://x').searchParams, page = Number(q.get('page')), n = Number(q.get('limit'));
    if (o.fail?.has(q.get('page')!)) return { status: 500 };
    const all = ALL.filter((x) => !q.get('tag') || x.tag == q.get('tag'));
    return { items: all.slice((page - 1) * n, page * n), ...(o.total === false ? {} : { total: all.length }) };
  },
});
const LIST = (extra = '', total = 'total="total"') => `
  <sn-resource name="a" src="/api/a?tag={$url.tag}" items="items" ${total} key="id" paginate="offset" page-size="2" page-model="$url.page" ${extra}></sn-resource>
  <span data-sn-text="[$meta.a.page, $url.page ?? '-', a.map((x) => x.id)].join(' ')"></span>
  <button id="next" data-sn-on-click="page('a', 'next')">›</button>
  <button id="prev" data-sn-on-click="page('a', 'prev')">‹</button>
  <button id="p3" data-sn-on-click="page('a', 3)">3</button>
  <button id="p9" data-sn-on-click="page('a', 9)">9</button>
  <button id="js" data-sn-on-click="$url.tag = 'js'">js</button>`;
const urls = (r: { calls: Array<{ url: string }> }) => r.calls.map((c) => c.url);

async function setup(url = 'http://localhost/', o: Parameters<typeof api>[0] = {}, html = LIST()) {
  const requests = api(o);
  const r = await render(html, { requests, url });
  await r.settle();
  const shown = () => r.root.querySelector('span')!.textContent;
  const click = async (id: string, settle = true) => { r.root.querySelector<HTMLElement>(`#${id}`)!.click(); settle ? await r.settle() : await r.flush(); };
  return { ...r, requests, shown, click };
}

test('the URL\'s page is restored at mount; page() writes it (a push) and the pager follows', async () => {
  const p = await setup('http://localhost/?page=2');
  expect(urls(p.requests)).toEqual(['/api/a?page=2&limit=2']);
  expect(p.shown()).toBe('2 2 3,4');
  await p.click('next');
  expect(p.url()).toBe('http://localhost/?page=3');
  expect(p.shown()).toBe('3 3 5,6');
  await p.click('prev');
  await p.click('prev');
  // page 1 deletes the parameter
  expect(p.history()).toEqual(['http://localhost/?page=2', 'http://localhost/?page=3', 'http://localhost/?page=2', 'http://localhost/']);
  expect(p.shown()).toBe('1 - 1,2');
  // past the start: nothing
  await p.click('prev');
  expect(p.history()).toHaveLength(4);
  expect(urls(p.requests)).toEqual(['/api/a?page=2&limit=2', '/api/a?page=3&limit=2', '/api/a?page=2&limit=2', '/api/a?page=1&limit=2']);
});

test('page() loads nothing itself: `$url.page` is the page asked for at once, `$meta.page` the page shown when it arrives', async () => {
  const p = await setup();
  await p.click('next', false);
  expect(p.url()).toBe('http://localhost/?page=2');
  expect(p.shown()).toBe('1 2 1,2');
  await p.settle();
  expect(p.shown()).toBe('2 2 3,4');
  expect(p.requests.calls).toHaveLength(2);
});

test('a handler or a field writing the parameter moves the list; a target past the last page is clamped; ?page=abc is page 1', async () => {
  const p = await setup('http://localhost/?page=abc', {}, LIST() + '<input id="f" data-sn-model="$url.page"><button id="w" data-sn-on-click="$url.page = 2">2</button>');
  expect(urls(p.requests)).toEqual(['/api/a?page=1&limit=2']);
  expect(p.url()).toBe('http://localhost/?page=abc');
  await p.click('w');
  expect(p.shown()).toBe('2 2 3,4');
  // typed: once the typing pauses
  const f = p.root.querySelector<HTMLInputElement>('#f')!;
  f.value = '3'; f.dispatchEvent(new Event('input', { bubbles: true }));
  await p.flush();
  await p.advance(100);
  expect(p.requests.calls).toHaveLength(2);
  await p.settle();
  expect(p.shown()).toBe('3 3 5,6');
  await p.click('p3');
  expect(p.requests.calls).toHaveLength(3);
  // 4 pages: 9 is clamped to the last, and `next` there does nothing
  await p.click('p9');
  expect(p.shown()).toBe('4 4 7');
  await p.click('next');
  expect(p.url()).toBe('http://localhost/?page=4');
  expect(p.requests.calls).toHaveLength(4);
});

test('fast `next`: from the page last requested; with no total known, ignored while a page loads', async () => {
  const known = await setup();
  await known.click('next', false);
  await known.click('next', false);
  await known.settle();
  expect(known.shown()).toBe('3 3 5,6');
  const unknown = await setup('http://localhost/', { total: false }, LIST('', ''));
  await unknown.click('next', false);
  await unknown.click('next', false);
  await unknown.settle();
  expect(unknown.shown()).toBe('2 2 3,4');
});

test('a failed page: `$meta.page` stays, `next` counts from it, and asking for the failed page again reloads it', async () => {
  const fail = new Set(['2']);
  const p = await setup('http://localhost/', { fail }, LIST() + '<i data-sn-on-sn-error="$event.preventDefault()"></i>');
  p.root.addEventListener('sn-error', (e) => e.preventDefault());
  await p.click('next').catch(() => {});
  expect(p.shown()).toBe('1 2 1,2');
  fail.clear();
  await p.click('next');
  expect(p.shown()).toBe('2 2 3,4');
  expect(urls(p.requests)).toEqual(['/api/a?page=1&limit=2', '/api/a?page=2&limit=2', '/api/a?page=2&limit=2']);
  expect(p.history()).toEqual(['http://localhost/', 'http://localhost/?page=2']);
});

test('a filter change starts at page 1 and deletes the parameter (a replace): Back restores the page with the old filter', async () => {
  const p = await setup('http://localhost/?page=3');
  await p.click('js');
  expect(p.url()).toBe('http://localhost/?tag=js');
  expect(p.shown()).toBe('1 - 2,4');
  expect(p.history()).toEqual(['http://localhost/?page=3', 'http://localhost/?tag=js']);
  await p.back();
  await p.settle();
  expect(p.url()).toBe('http://localhost/?page=3');
  expect(p.shown()).toBe('3 3 5,6');
  // Back wrote nothing
  expect(p.history()).toEqual(['http://localhost/?page=3', 'http://localhost/?tag=js']);
  await p.forward();
  await p.settle();
  expect(p.shown()).toBe('1 - 2,4');
  expect(urls(p.requests)).toEqual(['/api/a?page=3&limit=2', '/api/a?tag=js&page=1&limit=2', '/api/a?page=3&limit=2', '/api/a?tag=js&page=1&limit=2']);
});

test('Back and Forward between pages load the URL\'s page; a refetch asks for it again', async () => {
  const p = await setup();
  await p.click('next');
  await p.click('next');
  await p.back();
  await p.settle();
  expect(p.shown()).toBe('2 2 3,4');
  expect(p.history()).toHaveLength(3);
  await p.window('online');
  await p.settle();
  expect(urls(p.requests).at(-1)).toBe('/api/a?page=2&limit=2');
});

describe('`when`', () => {
  const html = LIST('when="$url.on"') + '<button id="on" data-sn-on-click="$url.on = 1">on</button><button id="off" data-sn-on-click="$url.on = null">off</button>';

  test('a late `when` restores the URL\'s page (its first URL after mount); page() while it is false does nothing; turning false writes nothing', async () => {
    const p = await setup('http://localhost/?page=3', {}, html);
    expect(p.requests.calls).toHaveLength(0);
    await p.click('next');
    expect(p.history()).toHaveLength(1);
    await p.click('on');
    expect(p.shown()).toBe('3 3 5,6');
    expect(p.url()).toBe('http://localhost/?page=3&on=1');
    await p.click('off');
    expect(p.url()).toBe('http://localhost/?page=3');
    // a later `when` turning true is a change: page 1
    await p.click('on');
    expect(p.url()).toBe('http://localhost/?on=1');
    expect(p.shown()).toBe('1 - 1,2');
  });
});

test('lists bound to the same parameter page together, and reset together', async () => {
  const html = LIST() + '<sn-resource name="b" src="/api/a" items="items" total="total" key="id" paginate="offset" page-size="2" page-model="$url.page"></sn-resource><b data-sn-text="b.map((x) => x.id).join()"></b>';
  const p = await setup('http://localhost/', {}, html);
  await p.click('next');
  expect(p.root.querySelector('b')!.textContent).toBe('3,4');
  await p.click('js');
  expect(p.url()).toBe('http://localhost/?tag=js');
  expect(p.root.querySelector('b')!.textContent).toBe('1,2');
});

test('typing a filter on page 3: the reset to page 1 folds into the typing commit, one entry', async () => {
  const html = LIST().replace('src="/api/a?tag={$url.tag}"', 'src="/api/a?tag={$url.q}"') + '<input id="q" type="search" data-sn-model="$url.q">';
  const p = await setup('http://localhost/?page=3', {}, html);
  const f = p.root.querySelector<HTMLInputElement>('#q')!;
  for (const v of ['j', 'js']) { f.value = v; f.dispatchEvent(new Event('input', { bubbles: true })); await p.flush(); await p.advance(100); }
  await p.settle();
  expect(p.history()).toEqual(['http://localhost/?page=3', 'http://localhost/?q=js']);
  expect(p.shown()).toBe('1 - 2,4');
  await p.back();
  await p.settle();
  expect(p.shown()).toBe('3 3 5,6');
});
