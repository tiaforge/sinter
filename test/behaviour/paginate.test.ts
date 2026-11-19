import { describe, expect, test, vi } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { render, mockRequests, mockStream, type RecordedCall } from '../../src/testing/index.js';

const ALL = Array.from({ length: 7 }, (_, i) => ({ uid: i + 1, at: 100 - i }));

/** A keyset server over ALL, sorted by `at` descending. */
function keyset(call: RecordedCall) {
  const q = new URL(call.url, 'http://x').searchParams;
  const limit = Number(q.get('limit'));
  const dir = q.get('direction');
  const at = Number(q.get('at'));
  let page: typeof ALL;
  if (dir === 'first') page = ALL.slice(0, limit);
  else if (dir === 'last') page = ALL.slice(-limit);
  else if (dir === 'next') page = ALL.filter((m) => m.at < at).slice(0, limit);
  else page = ALL.filter((m) => m.at > at).slice(-limit);
  return { messages: page, total: ALL.length };
}

const PAGE = `
  <sn-resource name="messages" src="/api/m" items="messages" total="total" key="uid"
    paginate="{ keyset: {at}, size: 3 }" order="-at"></sn-resource>
  <span data-sn-text="\`\${$meta.messages.from}–\${$meta.messages.to} of \${$meta.messages.total} \${$meta.messages.pages}\`"></span>
  <b data-sn-text="[$meta.messages.hasPrev, $meta.messages.hasNext].join()"></b>
  <button id="first" data-sn-on-click="page('messages', 'first')"></button>
  <button id="prev" data-sn-on-click="page('messages', 'prev')"></button>
  <button id="next" data-sn-on-click="page('messages', 'next')"></button>
  <button id="last" data-sn-on-click="page('messages', 'last')"></button>
  <ul><template data-sn-for="m in messages"><li data-sn-text="m.uid"></li></template></ul>`;

test('keyset pagination moves with cursors and tracks positions', async () => {
  const requests = mockRequests({ 'GET /api/m': keyset });
  const { root, settle } = await render(PAGE, { requests });
  await settle();
  const state = () => [
    [...root.querySelectorAll('li')].map((l) => l.textContent).join(','),
    root.querySelector('span')!.textContent, root.querySelector('b')!.textContent,
  ];
  const go = async (id: string) => { root.querySelector<HTMLElement>(`#${id}`)!.click(); await settle(); };
  expect(state()).toEqual(['1,2,3', '1–3 of 7 3', 'false,true']);
  await go('next');
  expect(state()).toEqual(['4,5,6', '4–6 of 7 3', 'true,true']);
  expect(requests.calls.at(-1)!.url).toBe('/api/m?at=98&limit=3&direction=next');
  await go('next');
  expect(state()).toEqual(['7', '7–7 of 7 3', 'true,false']);
  await go('prev');
  expect(state()).toEqual(['4,5,6', '4–6 of 7 3', 'true,true']);
  await go('last');
  expect(state()).toEqual(['5,6,7', '5–7 of 7 3', 'true,false']);
  await go('first');
  expect(state()).toEqual(['1,2,3', '1–3 of 7 3', 'false,true']);
});

test('refetch repeats the current page exactly', async () => {
  const requests = mockRequests({ 'GET /api/m': keyset });
  const stream = mockStream();
  const { root, settle } = await render(PAGE.replace('<ul>', `
    <sn-sync src="/s"><sn-event name="r" resource="messages" op="refresh"></sn-event>
      <sn-event name="u" resource="messages" op="upsert"></sn-event></sn-sync><ul>`), { requests, streams: { '/s': stream } });
  await settle();
  root.querySelector<HTMLElement>('#next')!.click();
  await settle();
  const url = requests.calls.at(-1)!.url;
  stream.emit('r', {});
  await settle();
  expect(requests.calls.at(-1)!.url).toBe(url);
  // an upsert of a key not on this page becomes a refetch of this page
  const n = requests.calls.length;
  stream.emit('u', { uid: 99, at: 1000 });
  await settle();
  expect(requests.calls.length).toBe(n + 1);
  expect(requests.calls.at(-1)!.url).toBe(url);
});

test('offset pagination jumps to page numbers', async () => {
  const requests = mockRequests({
    'GET /api/o': (c) => {
      const q = new URL(c.url, 'http://x').searchParams;
      const p = Number(q.get('page')), s = Number(q.get('limit'));
      return { items: ALL.slice((p - 1) * s, p * s), total: ALL.length };
    },
  });
  const { root, settle } = await render(`
    <sn-resource name="o" src="/api/o" items="items" total="total" key="uid" paginate="{ offset: true, size: 3 }"></sn-resource>
    <span data-sn-text="[$meta.o.page, $meta.o.pages, $meta.o.from, $meta.o.to, $meta.o.hasPrev, $meta.o.hasNext].join()"></span>
    <button data-sn-on-click="page('o', 3)"></button>`, { requests });
  await settle();
  expect(root.querySelector('span')!.textContent).toBe('1,3,1,3,false,true');
  root.querySelector('button')!.click();
  await settle();
  expect(root.querySelector('span')!.textContent).toBe('3,3,7,7,true,false');
});

test('append mode keeps loaded items and refetches them in one request', async () => {
  const requests = mockRequests({ 'GET /api/m': keyset });
  const stream = mockStream();
  const { root, settle } = await render(`
    <sn-resource name="messages" src="/api/m" items="messages" key="uid" paginate="{ append: {at}, size: 3 }" order="-at"></sn-resource>
    <sn-sync src="/s"><sn-event name="r" resource="messages" op="refresh"></sn-event></sn-sync>
    <button data-sn-on-click="page('messages', 'next')"></button>
    <ul><template data-sn-for="m in messages"><li data-sn-text="m.uid"></li></template></ul>`, { requests, streams: { '/s': stream } });
  await settle();
  root.querySelector('button')!.click();
  await settle();
  expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['1', '2', '3', '4', '5', '6']);
  stream.emit('r', {});
  await settle();
  expect(requests.calls.at(-1)!.url).toBe('/api/m?limit=6&direction=first');
});

test('directions: the server names the directions its own way', async () => {
  // Caley's mail API: `forward` (also the first page), `backward`, `last`
  const requests = mockRequests({
    'GET /api/m': (call) => {
      const q = new URL(call.url, 'http://x').searchParams;
      const dir = q.get('direction');
      const map: Record<string, string> = { forward: q.has('at') ? 'next' : 'first', backward: 'prev', last: 'last' };
      if (!(dir! in map)) return { status: 400, body: `unknown direction ${dir}` };
      q.set('direction', map[dir!]!);
      return keyset({ ...call, url: `/api/m?${q}` });
    },
  });
  const page = PAGE.replace('size: 3 }', `size: 3, directions: {first: 'forward', prev: 'backward', next: 'forward'} }`);
  const { root, settle } = await render(page, { requests });
  await settle();
  const go = async (id: string) => { root.querySelector<HTMLElement>(`#${id}`)!.click(); await settle(); };
  const items = () => [...root.querySelectorAll('li')].map((l) => l.textContent).join(',');
  expect(requests.calls.at(-1)!.url).toBe('/api/m?limit=3&direction=forward');
  await go('next');
  expect(requests.calls.at(-1)!.url).toBe('/api/m?at=98&limit=3&direction=forward');
  expect(items()).toBe('4,5,6');
  await go('prev');
  expect(requests.calls.at(-1)!.url).toBe('/api/m?at=97&limit=3&direction=backward');
  expect(items()).toBe('1,2,3');
  await go('last');
  expect(requests.calls.at(-1)!.url).toBe('/api/m?limit=3&direction=last');
  expect(items()).toBe('5,6,7');
});

describe('paginate diagnostics', () => {
  const diags = (attrs: string) => compile(`<sn-resource name="m" src="/api/m" key="uid" ${attrs}></sn-resource><p data-sn-text="m.length"></p>`, {
    file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  }).diagnostics.map((d) => `${d.code} ${d.message}`);
  const keyset = (more = '') => `paginate="{ keyset: {uid}, size: 5${more} }"`;

  test('directions: string values for known directions', () => {
    expect(diags(keyset(`, directions: {prev: 'backward', 'next': 'forward'}`))).toEqual([]);
    expect(diags(keyset(`, directions: {nxt: 'forward'}`))).toEqual(['SN401 `nxt` is not a key of `directions`; it takes `first`, `prev`, `next`, `last`. Did you mean `next`?']);
    expect(diags(keyset(', directions: {prev: dir}'))).toEqual(['SN401 `directions.prev` is a non-empty string literal']);
    expect(diags(keyset(", directions: ['backward']"))).toEqual(['SN401 `directions` is an object literal of strings']);
    expect(diags(`paginate="{ offset: true, size: 5, directions: {prev: 'b'} }"`)).toEqual(['SN401 `directions` is for `keyset` and `append` lists; an offset list sends page numbers']);
  });
  test('one object literal, one mode, a size; unknown keys with a suggestion', () => {
    expect(diags('paginate="{ keyset: {uid} }"')).toEqual(['SN401 `paginate` needs `size`, the number of items per page']);
    expect(diags('paginate="{ size: 5 }"')[0]).toMatch(/^SN401 `paginate` names one mode/);
    expect(diags('paginate="{ keyset: {uid}, offset: true, size: 5 }"')[0]).toMatch(/^SN401 `paginate` names one mode/);
    expect(diags('paginate="{ keyset: uid, size: 5 }"')).toEqual(['SN401 `keyset` is the cursor, an object literal read on the boundary item: `keyset: { before: id }`']);
    expect(diags('paginate="{ offset: true, size: 0 }"')).toEqual(['SN401 `size` is the number of items per page, a positive whole number']);
    expect(diags('paginate="{ offset: true, sise: 5 }"')).toEqual(['SN401 `sise` is not a key of `paginate`; it takes `keyset`, `append`, `offset`, `size`, `model`, `jump`, `params`, `directions`. Did you mean `size`?']);
    expect(diags(`paginate="{ offset: true, size: 5, params: { pge: 'p' } }"`)[0]).toMatch(/^SN401 `pge` is not a key of `params`; .*Did you mean `page`\?/);
    expect(diags(`paginate="{ offset: true, size: 5, params: { page: 'a b' } }"`)).toEqual(['SN401 `params.page` is a query parameter name']);
    expect(diags('paginate="offset: true"')[0]).toMatch(/^SN401 `paginate` is an object literal/);
  });
  test('the old attributes: the object they become', () => {
    expect(diags(`paginate="keyset" page-size="5" cursor="{uid}" offset-param="o" direction-values="{prev: 'b'}"`)).toEqual([
      "SN401 `paginate` is one object literal now: `paginate=\"{ keyset: {uid}, size: 5, jump: true, params: { offset: 'o' }, directions: {prev: 'b'} }\"`",
    ]);
    expect(diags('paginate="offset" page-size="10" page-model="$url.page"')).toEqual(['SN401 `paginate` is one object literal now: `paginate="{ offset: true, size: 10, model: $url.page }"`']);
    expect(diags(`${keyset()} page-size="5"`)).toEqual([expect.stringMatching(/^SN401 `page-size` is a key of `paginate` now/)]);
  });
});

test('jump: keyset pages jump with an offset, then continue by cursor', async () => {
  // Caley's mail API: cursor paging, plus `offset` to jump; `first` and an offset send no cursor
  const requests = mockRequests({
    'GET /api/m': (call) => {
      const q = new URL(call.url, 'http://x').searchParams;
      if (q.has('offset')) {
        const off = Number(q.get('offset')), limit = Number(q.get('limit'));
        expect(q.get('direction')).toBe('first');
        expect(q.has('at')).toBe(false);
        return { messages: ALL.slice(off, off + limit), total: ALL.length };
      }
      return keyset(call);
    },
  });
  const page = PAGE.replace('size: 3 }', 'size: 3, jump: true }')
    .replace('<ul>', `<i data-sn-text="$meta.messages.page"></i>
      <button id="p3" data-sn-on-click="page('messages', 3)"></button>
      <button id="p9" data-sn-on-click="page('messages', 9)"></button><ul>`);
  const { root, settle } = await render(page, { requests });
  await settle();
  const state = () => [
    [...root.querySelectorAll('li')].map((l) => l.textContent).join(','),
    root.querySelector('span')!.textContent, root.querySelector('b')!.textContent, root.querySelector('i')!.textContent,
  ];
  const go = async (id: string) => { root.querySelector<HTMLElement>(`#${id}`)!.click(); await settle(); };
  expect(state()).toEqual(['1,2,3', '1–3 of 7 3', 'false,true', '1']);
  await go('p3');
  expect(requests.calls.at(-1)!.url).toBe('/api/m?offset=6&limit=3&direction=first');
  expect(state()).toEqual(['7', '7–7 of 7 3', 'true,false', '3']);
  await go('prev');
  expect(requests.calls.at(-1)!.url).toBe('/api/m?at=94&limit=3&direction=prev');
  expect(state()).toEqual(['4,5,6', '4–6 of 7 3', 'true,true', '2']);
  await go('p9'); // past the end: the last page, known from the total
  expect(requests.calls.at(-1)!.url).toBe('/api/m?offset=6&limit=3&direction=first');
  expect(state()[3]).toBe('3');
  await go('first');
  expect(state()).toEqual(['1,2,3', '1–3 of 7 3', 'false,true', '1']);
  await go('last');
  expect(state()).toEqual(['5,6,7', '5–7 of 7 3', 'true,false', '3']);
});

test('page() with a computed direction; a page number or other value where it cannot go is refused, with no request', async () => {
  // Caley's keyset list: one handler for both directions
  const requests = mockRequests({ 'GET /api/m': keyset });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { root, settle } = await render(`<main data-sn-state="{ to: 2 }" data-sn-on-sn-error="$event.preventDefault()">${PAGE}
    <button id="move" data-sn-on-click="page('messages', $event.shiftKey ? 'prev' : 'next')"></button>
    <button id="number" data-sn-on-click="page('messages', to)"></button>
    <button id="word" data-sn-on-click="page('messages', 'nex' + 't!')"></button>
    <p data-sn-text="$meta.messages.error ? $meta.messages.error.message : 'ok'"></p></main>`, { requests });
  await settle();
  const list = () => [...root.querySelectorAll('li')].map((l) => l.textContent).join(',');
  const click = async (id: string, shiftKey = false) => { root.querySelector(`#${id}`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey })); await settle(); };
  await click('move');
  expect(list()).toBe('4,5,6');
  await click('move', true);
  expect(list()).toBe('1,2,3');
  const loads = requests.calls.length;
  await click('number');
  expect(requests.calls.length).toBe(loads);
  expect(list()).toBe('1,2,3');
  expect(root.querySelector('p')!.textContent).toBe(`page('messages', 2): keyset pagination cannot jump to a page number; add \`jump: true\` to paginate`);
  expect(warn).toHaveBeenCalledWith(`sinter: page('messages', 2): keyset pagination cannot jump to a page number; add \`jump: true\` to paginate`);
  await click('word');
  expect(requests.calls.length).toBe(loads);
  expect(root.querySelector('p')!.textContent).toBe(`page('messages', "next!"): not a direction`);
  // the next load clears the error
  await click('move');
  expect(root.querySelector('p')!.textContent).toBe('ok');
  warn.mockRestore();
});

describe('jump diagnostics', () => {
  const diags = (attrs: string, body = '<p data-sn-text="m.length"></p>') => compile(`<sn-resource name="m" src="/api/m" key="uid" ${attrs}></sn-resource>${body}`, {
    file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  }).diagnostics.map((d) => `${d.code} ${d.message}`);
  const keyset = 'paginate="{ keyset: {uid}, size: 5 }"';
  const jump = `<p data-sn-text="m.length + $meta.m.page"></p><button data-sn-on-click="page('m', 4)"></button>`;

  test('with jump, page(name, n) and $meta.<name>.page are allowed on keyset', () => {
    expect(diags('paginate="{ keyset: {uid}, size: 5, jump: true }"', jump)).toEqual([]);
  });
  test('without it, both are errors that point to jump', () => {
    expect(diags(keyset, jump)).toEqual([
      'SN303 `$meta.m.page` exists only on an offset list (`paginate="{ offset: true, … }"`), or a keyset list with `jump: true`',
      'SN304 keyset pagination cannot jump to a page number. Add `jump: true` to `paginate` if the server also accepts an offset, or use `offset: true`',
    ]);
  });
  test('a computed target compiles (sinter check types it); a literal page number does not', () => {
    const body = (to: string) => `<div data-sn-state="{ n: 2, dir: 'next' }"><p data-sn-text="m.length + n + dir"></p><button data-sn-on-click="page('m', ${to})"></button></div>`;
    for (const to of [`$event.shiftKey ? 'prev' : 'next'`, 'dir', 'n', 'n + 1']) expect(diags(keyset, body(to)), to).toEqual([]);
    for (const to of ['7', '-1', '']) expect(diags(keyset, body(to)), to).toEqual([expect.stringMatching(/^SN304 keyset pagination cannot jump to a page number/)]);
    expect(diags(keyset, body(`'nxt'`))).toEqual([expect.stringMatching(/^SN401 `page\(\)` targets are/)]);
    // append only loads more: nothing to compute
    expect(diags('paginate="{ append: {uid}, size: 5 }"', body('dir'))).toEqual(["SN304 `append` pagination only supports `page(…, 'next')`"]);
  });
  test('params.offset: an offset list sends the items to skip instead of the page; `jump` is for keyset lists; the old attribute names the new key', () => {
    expect(diags(`paginate="{ offset: true, size: 5, params: { offset: 'offset' } }"`)).toEqual([]);
    // a server's name, as the API gives it: an append list does not send it
    expect(diags(`paginate="{ append: {uid}, size: 5, params: { offset: 'offset' } }"`)).toEqual([]);
    expect(diags('paginate="{ append: {uid}, size: 5, jump: true }"')).toEqual(['SN401 `jump` is for `keyset` lists; append lists only load more']);
    expect(diags('paginate="{ offset: true, size: 5, jump: true }"')).toEqual(['SN401 `jump` is for `keyset` lists; an offset list jumps already']);
    expect(diags('offset-param="offset"')).toEqual([expect.stringMatching(/^SN401 `offset-param` is a key of `paginate` now, one object literal/)]);
  });
});

test('cursor fields that are null are left out, like URL template parameters', async () => {
  const requests = mockRequests({ 'GET /api/n': { items: [{ id: 1, sent: null }, { id: 2, sent: null }] } });
  const { root, settle } = await render(`
    <sn-resource name="n" src="/api/n" items="items" key="id" paginate="{ keyset: {cursor_sent_at: sent, cursor_rowid: id}, size: 2 }"></sn-resource>
    <button data-sn-on-click="page('n', 'next')"></button><p data-sn-text="n.length"></p>`, { requests });
  await settle();
  root.querySelector('button')!.click();
  await settle();
  expect(requests.calls.at(-1)!.url).toBe('/api/n?cursor_rowid=2&limit=2&direction=next');
});

test('an empty next page shows no positions; offset prev on page 1 and next on the last page do nothing', async () => {
  // a full first page, then nothing after it
  const requests = mockRequests({ 'GET /api/e': (call) => ({ items: call.url.includes('after=') ? [] : [{ id: 1 }, { id: 2 }] }) });
  const r = await render(`
    <sn-resource name="e" src="/api/e" key="id" items="items" paginate="{ keyset: {after: id}, size: 2 }"></sn-resource>
    <button data-sn-on-click="page('e', 'next')">n</button>
    <p data-sn-text="[$meta.e.from, $meta.e.to, $meta.e.hasPrev, $meta.e.hasNext].join()"></p>`, { requests });
  await r.settle();
  expect(r.root.querySelector('p')!.textContent).toBe('1,2,false,true');
  r.root.querySelector('button')!.click();
  await r.settle();
  expect(r.root.querySelector('p')!.textContent).toBe('0,0,true,false');
  expect(requests.calls.length).toBe(2);

  const offset = mockRequests({ 'GET /api/o': { items: [{ id: 1 }], total: 10 } });
  const o = await render(`
    <sn-resource name="o" src="/api/o" key="id" items="items" total="total" paginate="{ offset: true, size: 10 }"></sn-resource>
    <button id="p" data-sn-on-click="page('o', 'prev')">p</button><button id="n" data-sn-on-click="page('o', 'next')">n</button>
    <p data-sn-text="$meta.o.page"></p>`, { requests: offset });
  await o.settle();
  expect(offset.calls.length).toBe(1);
  o.root.querySelector<HTMLElement>('#p')!.click();
  await o.settle();
  o.root.querySelector<HTMLElement>('#n')!.click();   // pages = 1: nothing after this page
  await o.settle();
  expect(offset.calls.length).toBe(1);
  expect(o.root.querySelector('p')!.textContent).toBe('1');
});

test('page() does nothing past the ends: prev without hasPrev, next without hasNext, in every mode; first and last always load', async () => {
  const flags = (n: string) => `<b id="${n}-f" data-sn-text="[$meta.${n}.hasPrev, $meta.${n}.hasNext].join()"></b>`;
  const requests = mockRequests({ 'GET /api/m': keyset, 'GET /api/a': keyset, 'GET /api/o': { items: [{ id: 1 }], total: 1 } });
  const r = await render(`
    <sn-resource name="messages" src="/api/m" items="messages" total="total" key="uid" paginate="{ keyset: {at}, size: 3 }"></sn-resource>
    <sn-resource name="feed" src="/api/a" items="messages" key="uid" paginate="{ append: {at}, size: 4 }"></sn-resource>
    <sn-resource name="o" src="/api/o" items="items" total="total" key="id" paginate="{ offset: true, size: 10 }"></sn-resource>
    ${flags('messages')}${flags('feed')}${flags('o')}
    <div data-sn-state="{ to: 'prev' }">
      <button id="k-dir" data-sn-on-click="page('messages', to)"></button>
      <button id="k-next" data-sn-on-click="page('messages', 'next')"></button>
      <button id="k-first" data-sn-on-click="page('messages', 'first')"></button>
      <button id="k-last" data-sn-on-click="page('messages', 'last')"></button>
      <button id="a-next" data-sn-on-click="page('feed', 'next')"></button>
      <button id="o-dir" data-sn-on-click="page('o', to); to = 'next'"></button>
      <button id="o-first" data-sn-on-click="page('o', 'first')"></button>
    </div>
    <p data-sn-text="messages.length + feed.length + o.length"></p>`, { requests });
  await r.settle();
  const urls = () => requests.calls.map((c) => c.url.replace(/^\/api\//, ''));
  const go = async (id: string) => { r.root.querySelector<HTMLElement>(`#${id}`)!.click(); await r.settle(); };
  const f = (n: string) => r.root.querySelector(`#${n}-f`)!.textContent;
  expect(urls()).toEqual(['m?limit=3&direction=first', 'a?limit=4&direction=first', 'o?page=1&limit=10']);
  // keyset: a computed prev on the first page sends nothing
  await go('k-dir');
  expect(urls()).toHaveLength(3);
  // keyset: next until the short page, then nothing
  await go('k-next');
  await go('k-next');
  expect(f('messages')).toBe('true,false');
  await go('k-next');
  expect(urls()).toHaveLength(5);
  // first and last load whatever the flags say
  await go('k-last');
  await go('k-last');
  await go('k-first');
  expect(urls().slice(5)).toEqual(['m?limit=3&direction=last', 'm?limit=3&direction=last', 'm?limit=3&direction=first']);
  // append: next past the last page sends nothing
  await go('a-next');
  expect(f('feed')).toBe('false,false');
  await go('a-next');
  expect(urls().filter((u) => u.startsWith('a?'))).toEqual(['a?limit=4&direction=first', 'a?at=97&limit=4&direction=next']);
  // offset, one page: prev and next do nothing, first loads
  await go('o-dir');
  await go('o-dir');
  expect(f('o')).toBe('false,false');
  await go('o-first');
  expect(urls().filter((u) => u.startsWith('o?'))).toEqual(['o?page=1&limit=10', 'o?page=1&limit=10']);
});

test('page() before the first load has come back does nothing for prev and next', async () => {
  const requests = mockRequests({ 'GET /api/m': keyset });
  const r = await render(`
    <sn-resource name="messages" src="/api/m" items="messages" key="uid" paginate="{ keyset: {at}, size: 3 }"></sn-resource>
    <button data-sn-on-click="page('messages', 'next')"></button>
    <ul><template data-sn-for="m in messages"><li data-sn-text="m.uid"></li></template></ul>`, { requests });
  r.root.querySelector('button')!.click();
  await r.settle();
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/m?limit=3&direction=first']);
  expect([...r.root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['1', '2', '3']);
});

test('embedded data is the first page: positions, total and the next cursor come from it, with no request', async () => {
  // what a server writes for the first page (the request firstParams describes: limit=3&direction=first)
  const first = JSON.stringify({ messages: ALL.slice(0, 3), total: ALL.length });
  const requests = mockRequests({ 'GET /api/m': keyset });
  const { root, settle } = await render(`<html><head><script type="application/json" data-sn-data="messages">${first}</script></head><body>${PAGE}</body></html>`, { requests });
  await settle();
  const state = () => [[...root.querySelectorAll('li')].map((l) => l.textContent).join(','), root.querySelector('span')!.textContent, root.querySelector('b')!.textContent];
  expect(state()).toEqual(['1,2,3', '1–3 of 7 3', 'false,true']);
  expect(requests.calls).toHaveLength(0);
  root.querySelector<HTMLElement>('#next')!.click();
  await settle();
  expect(state()).toEqual(['4,5,6', '4–6 of 7 3', 'true,true']);
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/m?at=98&limit=3&direction=next']);
});

test('offset mode: embedded data is page 1, and page(3) asks for page 3', async () => {
  const requests = mockRequests({ 'GET /api/o': (call) => {
    const q = new URL(call.url, 'http://x').searchParams, p = Number(q.get('page')), n = Number(q.get('limit'));
    return { items: ALL.slice((p - 1) * n, p * n), total: ALL.length };
  } });
  const first = JSON.stringify({ items: ALL.slice(0, 3), total: ALL.length });
  const { root, settle } = await render(`<html><head><script type="application/json" data-sn-data="o">${first}</script></head><body>
    <sn-resource name="o" src="/api/o" items="items" total="total" key="uid" paginate="{ offset: true, size: 3 }"></sn-resource>
    <span data-sn-text="[$meta.o.page, $meta.o.pages, $meta.o.from, $meta.o.to, $meta.o.hasPrev, $meta.o.hasNext].join()"></span>
    <button data-sn-on-click="page('o', 3)"></button></body></html>`, { requests });
  await settle();
  expect(root.querySelector('span')!.textContent).toBe('1,3,1,3,false,true');
  expect(requests.calls).toHaveLength(0);
  root.querySelector('button')!.click();
  await settle();
  expect(root.querySelector('span')!.textContent).toBe('3,3,7,7,true,false');
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/o?page=3&limit=3']);
});

test('page-model with embedded data: the data is the URL\'s page (here 3 of 3), and paging goes on from it with the items to skip', async () => {
  const requests = mockRequests({ 'GET /api/o': (call) => {
    const q = new URL(call.url, 'http://x').searchParams, o = Number(q.get('skip')), n = Number(q.get('limit'));
    return { items: ALL.slice(o, o + n), total: ALL.length };
  } });
  // what a server writes for /?page=3: the request ?skip=6&limit=3
  const third = JSON.stringify({ items: ALL.slice(6, 9), total: ALL.length });
  const { root, settle } = await render(`<html><head><script type="application/json" data-sn-data="o">${third}</script></head><body>
    <sn-resource name="o" src="/api/o" items="items" total="total" key="uid" paginate="{ offset: true, size: 3, model: $url.page, params: { offset: 'skip' } }"></sn-resource>
    <span data-sn-text="[$meta.o.page, $meta.o.pages, $meta.o.from, $meta.o.to, $meta.o.hasPrev, $meta.o.hasNext].join()"></span>
    <button data-sn-on-click="page('o', 'prev')"></button></body></html>`, { requests, url: 'http://localhost/?page=3' });
  await settle();
  expect(root.querySelector('span')!.textContent).toBe('3,3,7,7,true,false');
  expect(requests.calls).toHaveLength(0);
  root.querySelector('button')!.click();
  await settle();
  expect(root.querySelector('span')!.textContent).toBe('2,3,4,6,true,true');
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/o?skip=3&limit=3']);
});
