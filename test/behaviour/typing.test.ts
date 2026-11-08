// A resource whose URL reads what a text field writes waits for a pause in the typing (250 ms)
// before it requests; any other change to its URL or `when` is requested at once.
import { expect, test } from 'vitest';
import { render, mockRequests } from '../../src/testing/index.js';

const type = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const q = (calls: Array<{ url: string }>) => calls.map((c) => new URL(c.url, 'http://x').searchParams.get('q'));

test('keystrokes coalesce: the request goes out 250 ms after the last one; the shown data stays until then', async () => {
  const requests = mockRequests({ 'GET /api/s': (call) => ({ items: [{ id: new URL(call.url, 'http://x').searchParams.get('q') }] }) });
  const { root, flush, advance, settle } = await render(`
    <div data-sn-state="{ q: '' }">
      <sn-resource name="r" src="/api/s?q={q}" items="items" key="id"></sn-resource>
      <input type="search" data-sn-model="q">
      <ul><template data-sn-for="it in r"><li data-sn-text="it.id"></li></template></ul>
    </div>`, { requests });
  await settle();
  expect(q(requests.calls)).toEqual(['']);
  const input = root.querySelector('input')!;
  type(input, 'a'); await flush();
  await advance(200);
  type(input, 'ab'); await flush();
  await advance(249);
  expect(q(requests.calls)).toEqual(['']);
  expect(root.querySelector('li')!.textContent).toBe('');
  await advance(1);
  await settle();
  expect(q(requests.calls)).toEqual(['', 'ab']);
  expect(root.querySelector('li')!.textContent).toBe('ab');
  // typed back to the current URL within the pause: no request
  type(input, 'abc'); await flush();
  type(input, 'ab'); await flush();
  await settle();
  expect(q(requests.calls)).toEqual(['', 'ab']);
});

test('a change not from typing (a select, a handler, `when`) is requested at once, also while a typing pause is running', async () => {
  const requests = mockRequests({ 'GET /api/s': { items: [] } });
  const { root, flush, settle } = await render(`
    <div data-sn-state="{ q: '', sort: 'a', on: true }">
      <sn-resource name="r" src="/api/s?q={q}&sort={sort}" items="items" key="id" when="on"></sn-resource>
      <input data-sn-model="q">
      <select data-sn-model="sort"><option value="a">a</option><option value="b">b</option></select>
      <button data-sn-on-click="q = 'set'">set</button>
      <template data-sn-for="it in r"><li></li></template>
    </div>`, { requests });
  await settle();
  const urls = () => requests.calls.map((c) => c.url);
  expect(urls()).toEqual(['/api/s?q=&sort=a']);
  const select = root.querySelector('select')!;
  select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  expect(urls()).toEqual(['/api/s?q=&sort=a', '/api/s?q=&sort=b']);
  // typing starts a pause; the handler's write to the same field goes out at once and ends the pause
  type(root.querySelector('input')!, 'x'); await flush();
  expect(urls()).toHaveLength(2);
  root.querySelector('button')!.click(); await flush();
  expect(urls()).toEqual(['/api/s?q=&sort=a', '/api/s?q=&sort=b', '/api/s?q=set&sort=b']);
  await settle();
  expect(urls()).toHaveLength(3);
});

test('a textarea types too; a number field, checkbox or radio does not', async () => {
  const requests = mockRequests({ 'GET /api/s': { items: [] } });
  const { root, flush, settle } = await render(`
    <div data-sn-state="{ t: '', n: 1, c: false }">
      <sn-resource name="r" src="/api/s?t={t}&n={n}&c={c}" items="items" key="id"></sn-resource>
      <textarea data-sn-model="t"></textarea>
      <input type="number" data-sn-model="n">
      <input type="checkbox" data-sn-model="c">
      <template data-sn-for="it in r"><li></li></template>
    </div>`, { requests });
  await settle();
  const number = root.querySelector('input[type=number]')!;
  (number as HTMLInputElement).value = '2'; number.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  expect(requests.calls).toHaveLength(2);
  type(root.querySelector('textarea')! as unknown as HTMLInputElement, 'hi'); await flush();
  expect(requests.calls).toHaveLength(2);
  await settle();
  expect(requests.calls).toHaveLength(3);
});
