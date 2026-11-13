// `$url` writes and the browser history: a user's event pushes an entry, anything else replaces;
// one write per flush pass, the strongest kind winning; values as a reload reads them.
import { expect, test } from 'vitest';
import { render, mockRequests } from '../../src/testing/index.js';

const click = (root: HTMLElement, sel: string) => root.querySelector<HTMLElement>(sel)!.click();
const input = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

test('a click handler pushes; Back and Forward restore $url and write nothing', async () => {
  const { root, flush, url, history, back, forward } = await render(`
    <p data-sn-text="$url.tab ?? '-'"></p>
    <button id="a" data-sn-on-click="$url.tab = 'a'">a</button>
    <button id="b" data-sn-on-click="$url.tab = 'b'">b</button>`, { url: 'http://localhost/page' });
  click(root, '#a'); await flush();
  click(root, '#b'); await flush();
  expect(history()).toEqual(['http://localhost/page', 'http://localhost/page?tab=a', 'http://localhost/page?tab=b']);
  await back();
  expect(url()).toBe('http://localhost/page?tab=a');
  expect(root.querySelector('p')!.textContent).toBe('a');
  await back();
  expect(root.querySelector('p')!.textContent).toBe('-');
  await forward();
  expect(root.querySelector('p')!.textContent).toBe('a');
  expect(history()).toHaveLength(3);
  // a push from the middle drops the forward entries
  click(root, '#b'); await flush();
  expect(history()).toEqual(['http://localhost/page', 'http://localhost/page?tab=a', 'http://localhost/page?tab=b']);
});

test('the no-op rule: a write of the current query adds no entry', async () => {
  const { root, flush, history } = await render(`<button data-sn-on-click="$url.tab = 'a'">a</button>`, { url: 'http://localhost/?tab=a' });
  click(root, 'button'); await flush();
  expect(history()).toHaveLength(1);
});

test('values are normalized as a reload reads them; order is kept; path parameters stay in the path', async () => {
  const { root, flush, url } = await render(`<html data-sn-path="/a/:slug"><body>
    <p data-sn-text="JSON.stringify($url)"></p>
    <button id="n" data-sn-on-click="$url.page = 0; $url.on = true; $url.off = false; $url.e = ''; $url.z = 'x'; $url.got = typeof $url.page">n</button>
    <button id="i" data-sn-on-click="$url.page++">i</button>
    <button id="d" data-sn-on-click="delete $url.z; $url.on = null">d</button></body></html>`, { url: 'http://localhost/a/s?z=1&off=1&e=x&b=2' });
  click(root, '#n'); await flush();
  expect(url()).toBe('http://localhost/a/s?z=x&b=2&page=0&on=1&got=string');
  expect(JSON.parse(root.querySelector('p')!.textContent!)).toEqual({ z: 'x', b: '2', slug: 's', page: '0', on: '1', got: 'string' });
  click(root, '#i'); await flush();
  expect(url()).toBe('http://localhost/a/s?z=x&b=2&page=1&on=1&got=string');
  click(root, '#d'); await flush();
  expect(url()).toBe('http://localhost/a/s?b=2&page=1&got=string');
});

test('a handler on `input` in a text field replaces at once', async () => {
  const { root, flush, url, history } = await render(`<input data-sn-on-input="$url.q = $el.value">`);
  input(root.querySelector('input')!, 'a'); await flush();
  input(root.querySelector('input')!, 'ab'); await flush();
  expect(url()).toBe('http://localhost/?q=ab');
  expect(history()).toHaveLength(1);
});

test("an action's `then` started by a click pushes; a resource's `then` replaces", async () => {
  const requests = mockRequests({ 'POST /api/x': { id: 7 }, 'GET /api/r': { id: 1 } });
  const { root, settle, url, history } = await render(`
    <sn-resource name="r" src="/api/r" then="$url.r = $result.id"></sn-resource>
    <button data-sn-post="/api/x" data-sn-then="$url.id = $result.id">x</button>`, { requests });
  await settle();
  expect(url()).toBe('http://localhost/?r=1');
  expect(history()).toHaveLength(1);
  click(root, 'button'); await settle();
  expect(history()).toEqual(['http://localhost/?r=1', 'http://localhost/?r=1&id=7']);
});

test('`emit` from a click pushes; `run()` from a resource `then`, and the `sn-error` of its failure, replace', async () => {
  const requests = mockRequests({ 'GET /api/s': { id: 1 }, 'POST /api/x': { ok: 1 }, 'POST /api/f': { status: 500 } });
  const { root, settle, flush, history, url } = await render(`
    <section data-sn-on-sn-error="$url.err = $event.detail.element.id; $event.preventDefault()" data-sn-on-picked="$url.p = $event.detail">
      <sn-resource name="s" src="/api/s" then="run('go'); run('f')"></sn-resource>
      <button id="go" data-sn-post="/api/x" data-sn-then="$url.ran = 1">go</button>
      <button id="f" data-sn-post="/api/f">f</button>
      <button id="g" data-sn-post="/api/f">g</button>
      <button id="e" data-sn-on-click="emit('picked', 'b')">e</button>
    </section>`, { requests });
  await settle();
  expect(url()).toBe('http://localhost/?ran=1&err=f');
  expect(history()).toHaveLength(1);
  click(root, '#e'); await flush();
  expect(history()).toEqual(['http://localhost/?ran=1&err=f', 'http://localhost/?ran=1&err=f&p=b']);
  // the failure of an action a click started: its `sn-error` handler pushes
  click(root, '#g'); await settle();
  expect(history()).toHaveLength(3);
  expect(url()).toBe('http://localhost/?ran=1&err=g&p=b');
});

test('a history call the browser refuses: a warning, $url keeps the value', async () => {
  const { root, flush, app, url } = await render(`<p data-sn-text="$url.tab"></p><button data-sn-on-click="$url.tab = 'a'">a</button>`);
  const warned: unknown[] = [];
  app.warn = (code) => { warned.push(code); };
  (app.env as { pushState(u: string): void }).pushState = () => { throw new Error('SecurityError'); };
  click(root, 'button'); await flush();
  expect(warned).toEqual([26]);
  expect(url()).toBe('http://localhost/');
  expect(root.querySelector('p')!.textContent).toBe('a');
});
