// `$url` writes and the browser history: a user's event pushes an entry, anything else replaces;
// one write per flush pass, the strongest kind winning; values as a reload reads them.
import { describe, expect, test } from 'vitest';
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

describe('models on $url', () => {
  const page = `
    <sn-resource name="r" src="/api/s?q={$url.q}&sort={$url.sort}" items="items" key="id"></sn-resource>
    <input type="search" data-sn-model="$url.q">
    <select data-sn-model="$url.sort"><option value="">-</option><option value="new">new</option></select>
    <button data-sn-on-click="$url.tag = 'go'">tag</button>`;
  const setup = async (url = 'http://localhost/') => {
    const requests = mockRequests({ 'GET /api/s': { items: [] } });
    const r = await render(page, { requests, url });
    await r.settle();
    return { ...r, requests, field: r.root.querySelector('input')! };
  };

  test('the field is filled from the URL; typing writes once per pause: the first commit pushes, later ones replace', async () => {
    const { field, flush, advance, url, history, requests } = await setup('http://localhost/?q=a');
    expect(field.value).toBe('a');
    for (const v of ['as', 'asi', 'asin']) { input(field, v); await flush(); await advance(100); }
    expect(url()).toBe('http://localhost/?q=a');
    await advance(150);
    expect(history()).toEqual(['http://localhost/?q=a', 'http://localhost/?q=asin']);
    input(field, 'asin ter'); await flush();
    await advance(250);
    expect(history()).toEqual(['http://localhost/?q=a', 'http://localhost/?q=asin+ter']);
    // the request waited for the same pauses
    expect(requests.calls.map((c) => new URL(c.url, 'http://x').searchParams.get('q'))).toEqual(['a', 'asin', 'asin ter']);
  });

  test('`change` (Enter, leaving the field) commits at once and ends the run', async () => {
    const { field, flush, advance, history } = await setup();
    input(field, 'foo'); await flush();
    field.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    expect(history()).toEqual(['http://localhost/', 'http://localhost/?q=foo']);
    input(field, 'foobar'); await flush();
    await advance(250);
    expect(history()).toEqual(['http://localhost/', 'http://localhost/?q=foo', 'http://localhost/?q=foobar']);
    // a change with nothing pending only ends the run
    field.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    expect(history()).toHaveLength(3);
  });

  test('a select pushes at once; a push takes what typing waits to commit with it', async () => {
    const { root, field, flush, advance, history } = await setup();
    const sel = root.querySelector('select')!;
    sel.value = 'new'; sel.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    expect(history()).toEqual(['http://localhost/', 'http://localhost/?sort=new']);
    input(field, 'x'); await flush();
    click(root, 'button'); await flush();
    expect(history()).toEqual(['http://localhost/', 'http://localhost/?sort=new', 'http://localhost/?sort=new&q=x&tag=go']);
    await advance(300);
    expect(history()).toHaveLength(3);
  });

  test('Back while a commit waits: the commit is dropped, the field shows the URL', async () => {
    const { root, field, flush, advance, history, back, url } = await setup();
    click(root, 'button'); await flush();
    input(field, 'x'); await flush();
    await back();
    await advance(300);
    expect(url()).toBe('http://localhost/');
    expect(history()).toEqual(['http://localhost/', 'http://localhost/?tag=go']);
    expect(field.value).toBe('');
  });

  test('a number model on $url (written on `change`, a push) keeps `1.0` as typed', async () => {
    const { root, flush, history } = await render('<input type="number" data-sn-model="$url.n">', { url: 'http://localhost/?n=2' });
    const f = root.querySelector('input')!;
    expect(f.value).toBe('2');
    f.value = '1.0'; f.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    expect(history()).toEqual(['http://localhost/?n=2', 'http://localhost/?n=1']);
    expect(f.value).toBe('1.0');
  });
});

test('a component model on $url pushes, even when its change is not from a user event', async () => {
  const PICK = `<template data-sn-component="{ value: string }" data-sn-emits="{ change: string }"><b data-sn-text="value"></b></template>`;
  const { root, flush, history } = await render('<x-pick data-sn-model="$url.p"></x-pick>', { components: { 'x-pick': PICK } });
  root.querySelector('b')!.dispatchEvent(new CustomEvent('change', { detail: 'a' }));
  await flush();
  expect(history()).toEqual(['http://localhost/', 'http://localhost/?p=a']);
  expect(root.querySelector('b')!.textContent).toBe('a');
});

test('first paint: a model on $url is filled before the page module', async () => {
  let early = '';
  await render('<input type="search" data-sn-model="$url.q">', { url: 'http://localhost/?q=hi', firstPaint: { afterEarly: () => { early = document.querySelector('input')!.value; } } });
  expect(early).toBe('hi');
});

describe('array parameters', () => {
  test('a <select multiple> or a checkbox group: a list, written as repeated keys, absent as []', async () => {
    const requests = mockRequests({ 'GET /api/a': { items: [] } });
    const { root, flush, settle, url, history } = await render(`
      <sn-resource name="r" src="/api/a?tag={$url.tag}" items="items" key="id"></sn-resource>
      <select multiple data-sn-model="$url.tag"><option>go</option><option>js</option><option>rs</option></select>
      <input type="checkbox" value="go" data-sn-model="$url.tag"><input type="checkbox" value="rs" data-sn-model="$url.tag">
      <p data-sn-text="JSON.stringify($url.tag) + $url.tag.length"></p>
      <button id="one" data-sn-on-click="$url.tag = 'js'">one</button>
      <button id="none" data-sn-on-click="$url.tag = null">none</button>`, { requests, url: 'http://localhost/?x=1' });
    await settle();
    const p = () => root.querySelector('p')!.textContent;
    expect(p()).toBe('[]0');
    const boxes = root.querySelectorAll<HTMLInputElement>('input');
    boxes[1]!.checked = true; boxes[1]!.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    boxes[0]!.checked = true; boxes[0]!.dispatchEvent(new Event('change', { bubbles: true })); await settle();
    expect(url()).toBe('http://localhost/?x=1&tag=rs&tag=go');
    expect(p()).toBe('["rs","go"]2');
    expect([...root.querySelector('select')!.selectedOptions].map((o) => o.value)).toEqual(['go', 'rs']);
    expect(history()).toHaveLength(3);
    expect(requests.calls.map((c) => c.url)).toEqual(['/api/a', '/api/a?tag=rs', '/api/a?tag=rs&tag=go']);
    // one value written to an array parameter is wrapped; none is an empty list
    click(root, '#one'); await flush();
    expect(p()).toBe('["js"]1');
    expect(url()).toBe('http://localhost/?x=1&tag=js');
    click(root, '#none'); await flush();
    expect(p()).toBe('[]0');
    expect(url()).toBe('http://localhost/?x=1');
  });

  test('read from the URL at mount and on Back', async () => {
    const { root, flush, back } = await render(`
      <select multiple data-sn-model="$url.tag"><option>go</option><option>js</option></select>
      <p data-sn-text="$url.tag.join()"></p><button data-sn-on-click="$url.tag = ['js']">js</button>`, { url: 'http://localhost/?tag=go&tag=js' });
    expect(root.querySelector('p')!.textContent).toBe('go,js');
    click(root, 'button'); await flush();
    expect(root.querySelector('p')!.textContent).toBe('js');
    await back();
    expect(root.querySelector('p')!.textContent).toBe('go,js');
    expect([...root.querySelector('select')!.selectedOptions].map((o) => o.value)).toEqual(['go', 'js']);
  });
});
