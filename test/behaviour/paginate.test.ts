import { expect, test } from 'vitest';
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
