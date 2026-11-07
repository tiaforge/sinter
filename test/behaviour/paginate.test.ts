import { describe, expect, test } from 'vitest';
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
    paginate="keyset" page-size="3" cursor="{at}" order="-at"></sn-resource>
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
    <sn-sync src="/s"><sn-event name="r" resource="messages" op="refetch"></sn-event>
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
    <sn-resource name="o" src="/api/o" items="items" total="total" key="uid" paginate="offset" page-size="3"></sn-resource>
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
    <sn-resource name="messages" src="/api/m" items="messages" key="uid" paginate="append" page-size="3" cursor="{at}" order="-at"></sn-resource>
    <sn-sync src="/s"><sn-event name="r" resource="messages" op="refetch"></sn-event></sn-sync>
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

test('direction-values: the server names the directions its own way', async () => {
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
  const page = PAGE.replace('cursor="{at}"', `cursor="{at}" direction-values="{first: 'forward', prev: 'backward', next: 'forward'}"`);
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

describe('direction-values diagnostics', () => {
  const diags = (attrs: string) => compile(`<sn-resource name="m" src="/api/m" key="uid" ${attrs}></sn-resource><p data-sn-text="m.length"></p>`, {
    file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  }).diagnostics.map((d) => `${d.code} ${d.message}`);
  const keyset = 'paginate="keyset" page-size="5" cursor="{uid}"';

  test('valid values compile without diagnostics', () => {
    expect(diags(`${keyset} direction-values="{prev: 'backward', 'next': 'forward'}"`)).toEqual([]);
  });
  test('an unknown direction, with a suggestion', () => {
    expect(diags(`${keyset} direction-values="{nxt: 'forward'}"`)).toEqual([
      'SN401 `nxt` is not a direction; directions are `first`, `prev`, `next` and `last`. Did you mean `next`?',
    ]);
    expect(diags(`${keyset} direction-values="{previous: 'backward'}"`)).toEqual([
      'SN401 `previous` is not a direction; directions are `first`, `prev`, `next` and `last`.',
    ]);
  });
  test('values are string literals; the whole value is one object literal', () => {
    expect(diags(`${keyset} direction-values="{prev: dir}"`)).toEqual(['SN401 the value for `prev` must be a string literal']);
    expect(diags(`${keyset} direction-values="['backward']"`)[0]).toMatch(/^SN401 `direction-values` is an object literal of strings/);
    expect(diags(`${keyset} direction-values="{prev: 'a'} + 1"`)[0]).toMatch(/^SN401 `direction-values` is an object literal of strings/);
  });
  test('offset mode has no directions; without paginate it is misplaced', () => {
    expect(diags(`paginate="offset" page-size="5" direction-values="{prev: 'b'}"`)[0]).toMatch(/^SN401 `direction-values` applies to `paginate="keyset"`/);
    expect(diags(`direction-values="{prev: 'b'}"`)).toEqual(['SN102 `direction-values` needs `paginate`']);
  });
});

test('offset-param: keyset pages jump with an offset, then continue by cursor', async () => {
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
  const page = PAGE.replace('cursor="{at}"', 'cursor="{at}" offset-param="offset"')
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

describe('offset-param diagnostics', () => {
  const diags = (attrs: string, body = '<p data-sn-text="m.length"></p>') => compile(`<sn-resource name="m" src="/api/m" key="uid" ${attrs}></sn-resource>${body}`, {
    file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  }).diagnostics.map((d) => `${d.code} ${d.message}`);
  const keyset = 'paginate="keyset" page-size="5" cursor="{uid}"';
  const jump = `<p data-sn-text="m.length + $meta.m.page"></p><button data-sn-on-click="page('m', 4)"></button>`;

  test('with offset-param, page(name, n) and $meta.<name>.page are allowed on keyset', () => {
    expect(diags(`${keyset} offset-param="offset"`, jump)).toEqual([]);
  });
  test('without it, both are errors that point to offset-param', () => {
    expect(diags(keyset, jump)).toEqual([
      'SN303 `$meta.m.page` exists only with `paginate="offset"`, or `paginate="keyset"` with `offset-param`',
      'SN304 keyset pagination cannot jump to a page number. Add `offset-param` if the server also accepts an offset, or use `paginate="offset"`',
    ]);
  });
  test('only keyset resources take offset-param', () => {
    expect(diags('paginate="append" page-size="5" cursor="{uid}" offset-param="offset"')).toEqual(['SN401 `offset-param` applies to `paginate="keyset"`; append mode only loads more']);
    expect(diags('paginate="offset" page-size="5" offset-param="offset"')).toEqual(['SN401 `offset-param` applies to `paginate="keyset"`; offset pages jump with `page-param`']);
    expect(diags('offset-param="offset"')).toEqual(['SN102 `offset-param` needs `paginate`']);
  });
});

test('cursor fields that are null are left out, like URL template parameters', async () => {
  const requests = mockRequests({ 'GET /api/n': { items: [{ id: 1, sent: null }, { id: 2, sent: null }] } });
  const { root, settle } = await render(`
    <sn-resource name="n" src="/api/n" items="items" key="id" paginate="keyset" page-size="2" cursor="{cursor_sent_at: sent, cursor_rowid: id}"></sn-resource>
    <button data-sn-on-click="page('n', 'next')"></button><p data-sn-text="n.length"></p>`, { requests });
  await settle();
  root.querySelector('button')!.click();
  await settle();
  expect(requests.calls.at(-1)!.url).toBe('/api/n?cursor_rowid=2&limit=2&direction=next');
});

test('an empty next page shows no positions; offset prev on page 1 and next on the last page do nothing', async () => {
  const requests = mockRequests({ 'GET /api/e': { items: [] } });
  const r = await render(`
    <sn-resource name="e" src="/api/e" key="id" items="items" paginate="keyset" page-size="2" cursor="{after: id}"></sn-resource>
    <button data-sn-on-click="page('e', 'next')">n</button>
    <p data-sn-text="[$meta.e.from, $meta.e.to, $meta.e.hasPrev, $meta.e.hasNext].join()"></p>`, { requests });
  await r.settle();
  expect(r.root.querySelector('p')!.textContent).toBe('0,0,false,false');
  r.root.querySelector('button')!.click();
  await r.settle();
  expect(r.root.querySelector('p')!.textContent).toBe('0,0,true,false');

  const offset = mockRequests({ 'GET /api/o': { items: [{ id: 1 }], total: 10 } });
  const o = await render(`
    <sn-resource name="o" src="/api/o" key="id" items="items" total="total" paginate="offset" page-size="10"></sn-resource>
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
