// A list's empty state: `<template data-sn-else>` directly after a `<template data-sn-for>` (docs/proposals/empty-state.md).
// It renders while the list is empty and every resource the list may come from has loaded, is not loading and has
// no error; over a list that is no resource's, while the list is empty.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { firstPaint, mockRequests, render, type RecordedCall } from '../../src/testing/index.js';
import type { CallContext } from '../../src/index.js';

const LIST = (res: string, list = 'c', around = '') => `
  ${res}
  <div ${around}><ul><template data-sn-for="x in ${list}"><li data-sn-text="x.name"></li></template><template data-sn-else><li id="none">None</li></template></ul></div>`;
const none = (root: HTMLElement) => !!root.querySelector('#none');
const rows = (root: HTMLElement) => [...root.querySelectorAll('li:not(#none)')].map((l) => l.textContent);

describe('over a fetched resource', () => {
  test('not while the first load runs; once it answers empty; not beside rows', async () => {
    let answer: unknown[] = [];
    const requests = mockRequests({ 'GET /api/c': () => ({ c: answer }) });
    const r = await render(LIST('<sn-resource name="c" src="/api/c" items="c" key="id"></sn-resource><button data-sn-on-click="refresh(c)"></button>'), { requests });
    await r.flush();
    expect(none(r.root)).toBe(false);
    await r.settle();
    expect(none(r.root)).toBe(true);
    // a reload: loading, so not empty yet (the "Loading…" of `$meta.c.loading && !c.length` shows instead)
    answer = [{ id: 1, name: 'Ada' }];
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(none(r.root)).toBe(false);
    await r.settle();
    expect(none(r.root)).toBe(false);
    expect(rows(r.root)).toEqual(['Ada']);
  });

  test('a failed load: never beside its error, also after an empty success', async () => {
    let fail = true;
    const requests = mockRequests({ 'GET /api/c': () => (fail ? { status: 500, body: 'no' } : { c: [] }) });
    const r = await render(LIST('<sn-resource name="c" src="/api/c" items="c" key="id"></sn-resource><button data-sn-on-click="refresh(c)"></button><p data-sn-text="$meta.c.error ? \'failed\' : \'\'"></p>'), { requests });
    await r.settle();
    expect(r.root.querySelector('p')!.textContent).toBe('failed');
    expect(none(r.root)).toBe(false);
    fail = false;
    r.root.querySelector('button')!.click();
    await r.settle();
    expect(none(r.root)).toBe(true);
    fail = true;
    r.root.querySelector('button')!.click();
    await r.settle();
    expect(r.root.querySelector('p')!.textContent).toBe('failed');
    expect(none(r.root)).toBe(false);
  });

  test('a filter that leaves nothing, while the resource has rows: empty', async () => {
    const requests = mockRequests({ 'GET /api/c': { c: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Bob' }] } });
    const r = await render(`<sn-resource name="c" src="/api/c" items="c" key="id"></sn-resource><div data-sn-state="{ q: '' }"><input data-sn-model="q">
      <ul><template data-sn-for="x in c.filter((p) => p.name.includes(q))"><li data-sn-text="x.name"></li></template><template data-sn-else><li id="none">None</li></template></ul></div>`, { requests });
    await r.settle();
    expect(rows(r.root)).toEqual(['Ada', 'Bob']);
    expect(none(r.root)).toBe(false);
    const input = r.root.querySelector('input')!;
    input.value = 'Zed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await r.settle();
    expect(rows(r.root)).toEqual([]);
    expect(none(r.root)).toBe(true);
  });

  test('`when` falsy: never loaded, so not empty (a search with nothing typed); typed, then cleared, the same', async () => {
    const requests = mockRequests({ 'GET /api/s': () => ({ c: [] }) });
    const r = await render(`<div data-sn-state="{ q: '' }"><select data-sn-model="q"><option value=""></option><option value="zz">zz</option></select>
      <sn-resource name="c" src="/api/s?q={q}" when="q" items="c" key="id"></sn-resource>
      <ul><template data-sn-for="x in c"><li data-sn-text="x.name"></li></template><template data-sn-else><li id="none">No results</li></template></ul>
      <i data-sn-text="$meta.c.loadedAt ? 'loaded' : 'not loaded'"></i></div>`, { requests });
    await r.settle();
    expect(requests.calls).toEqual([]);
    expect(none(r.root)).toBe(false);
    const select = r.root.querySelector('select')!;
    select.value = 'zz';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await r.settle();
    expect(none(r.root)).toBe(true);
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await r.settle();
    expect(r.root.querySelector('i')!.textContent).toBe('not loaded');
    expect(none(r.root)).toBe(false);
  });

  test('a choice between resources (`?:` in a let) waits for the one shown', async () => {
    const requests = mockRequests({ 'GET /api/recent': { c: [] }, 'GET /api/s': { c: [] } });
    const r = await render(`<div data-sn-state="{ q: '' }" data-sn-let="{ shown: q ? results : recent }">
      <select data-sn-model="q"><option value=""></option><option value="zz">zz</option></select>
      <sn-resource name="recent" src="/api/recent" items="c" key="id"></sn-resource>
      <sn-resource name="results" src="/api/s?q={q}" when="q" items="c" key="id"></sn-resource>
      <ul><template data-sn-for="x in shown"><li data-sn-text="x.name"></li></template><template data-sn-else><li id="none">None</li></template></ul></div>`, { requests });
    await r.settle();
    // `results` never loads while nothing is chosen: the empty state is `recent`'s
    expect(none(r.root)).toBe(true);
  });

  test('cached data shown early does not claim to be empty: the server has not answered', async () => {
    const session = sessionStorage;
    session.setItem('sn:c:["http://localhost/api/c","c",null]', JSON.stringify({ t: Date.now(), items: [], total: null }));
    const requests = mockRequests({ 'GET /api/c': { c: [] } });
    const r = await render(LIST('<sn-resource name="c" src="/api/c" items="c" key="id" cache></sn-resource>'), { requests, session });
    await r.flush();
    expect(none(r.root)).toBe(false);
    await r.settle();
    expect(none(r.root)).toBe(true);
    session.clear();
  });

  test('a background `refresh`: silent, so the empty state stays', async () => {
    const requests = mockRequests({ 'GET /api/c': { c: [] } });
    const r = await render(LIST('<sn-resource name="c" src="/api/c" items="c" key="id" refresh="10s"></sn-resource>'), { requests });
    await r.settle();
    expect(none(r.root)).toBe(true);
    const before = requests.calls.length;
    await r.advance(11_000);
    await r.flush();
    expect(requests.calls.length).toBe(before + 1);
    expect(none(r.root)).toBe(true);
    await r.settle();
    expect(none(r.root)).toBe(true);
  });

  test('paginated: not while `page()` loads; a page with nothing on it is empty', async () => {
    const requests = mockRequests({ 'GET /api/m': (call: RecordedCall) => (new URL(call.url, 'http://x').searchParams.get('page') === '2' ? { m: [], total: 0 } : { m: [{ id: 1, name: 'Ada' }], total: 1 }) });
    const r = await render(LIST('<sn-resource name="c" src="/api/m" items="m" total="total" key="id" paginate="{ numbered: true, size: 1 }"></sn-resource><button data-sn-on-click="page(c, 2)"></button>'), { requests });
    await r.settle();
    expect(none(r.root)).toBe(false);
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(none(r.root)).toBe(false);
    await r.settle();
    expect(rows(r.root)).toEqual([]);
    expect(none(r.root)).toBe(true);
  });

  test('a `for` fan-out: once every source answered, and once its list is known to be empty', async () => {
    let accounts = [{ id: 1 }];
    const requests = mockRequests({ 'GET /api/accounts': () => accounts, 'GET /api/boxes': { b: [] } });
    const r = await render(LIST(`<sn-resource name="accounts" src="/api/accounts" key="id"></sn-resource>
      <sn-resource name="c" for="a in accounts" src="/api/boxes?a={a.id}" items="b" key="id"></sn-resource><button data-sn-on-click="refresh(accounts)"></button>`), { requests });
    await r.flush();
    expect(none(r.root)).toBe(false);
    await r.settle();
    expect(none(r.root)).toBe(true);
    accounts = [];
    r.root.querySelector('button')!.click();
    await r.settle();
    expect(none(r.root)).toBe(true);
  });

  test('a `call` resource: once the call returned', async () => {
    let done!: (v: unknown) => void;
    const actions = { list: (_ctx: CallContext) => new Promise((ok) => { done = ok; }) };
    const r = await render(LIST('<sn-resource name="c" call="list()" key="id"></sn-resource>'), { actions });
    await r.flush();
    expect(none(r.root)).toBe(false);
    done([]);
    await r.settle();
    expect(none(r.root)).toBe(true);
  });

  test('a helper given one resource, and a nested list of a row (which came with it)', async () => {
    const requests = mockRequests({ 'GET /api/a': [{ id: 1, name: 'A', tags: [] }, { id: 2, name: 'B', tags: [{ id: 9, name: 't' }] }] });
    const r = await render(`<sn-resource name="arts" src="/api/a" key="id"></sn-resource>
      <ul><template data-sn-for="a in sorted(arts)"><li><b data-sn-text="a.name"></b><template data-sn-for="t in a.tags"><i data-sn-text="t.name"></i></template><template data-sn-else><i class="no">no tags</i></template></li></template><template data-sn-else><li id="none">None</li></template></ul>`,
      { requests, helpers: { sorted: (xs: unknown[]) => [...xs] } });
    await r.flush();
    expect(none(r.root)).toBe(false);
    await r.settle();
    expect(none(r.root)).toBe(false);
    expect([...r.root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['Ano tags', 'Bt']);
  });
});

describe('over a list that is no resource\'s', () => {
  test('state: while it is empty, from the first render', async () => {
    const r = await render(`<div data-sn-state="{ xs: [] }"><button data-sn-on-click="xs = [...xs, { name: 'a' }]"></button>
      <ul><template data-sn-for="x in xs"><li data-sn-text="x.name"></li></template><template data-sn-else><li id="none">None</li></template></ul></div>`);
    await r.flush();
    expect(none(r.root)).toBe(true);
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(none(r.root)).toBe(false);
    expect(rows(r.root)).toEqual(['a']);
  });

  test('a Set: emptiness of any iterable', async () => {
    const r = await render(`<div data-sn-state="{ xs: new Set() }"><button data-sn-on-click="xs = new Set(['a'])"></button>
      <ul><template data-sn-for="x in xs"><li data-sn-text="x"></li></template><template data-sn-else><li id="none">None</li></template></ul></div>`);
    await r.flush();
    expect(none(r.root)).toBe(true);
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(none(r.root)).toBe(false);
  });

  test('a prop of a component: the caller\'s resource, waited for', async () => {
    const requests = mockRequests({ 'GET /api/c': { c: [] } });
    const r = await render(`<sn-resource name="c" src="/api/c" items="c" key="id"></sn-resource><x-list data-sn-with="{ items: c }"></x-list>`, {
      requests,
      components: { 'x-list': '<template data-sn-props="{ items: { name: string }[] }"><ul><template data-sn-for="x in items"><li data-sn-text="x.name"></li></template><template data-sn-else><li id="none">None</li></template></ul></template>' },
    });
    await r.flush();
    expect(none(r.root)).toBe(false);
    await r.settle();
    expect(none(r.root)).toBe(true);
  });
});

const build = (body: string, more: Record<string, string> = {}) => compile(`<!doctype html><html lang="en"><head></head><body>${body}</body></html>`, {
  file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, prerender: true,
  readFile: (f) => { const t = more[f.replace(/^\/p\//, '')]; if (t === undefined) throw new Error(`no such file: ${f}`); return t; },
  listFiles: (dir) => Object.keys(more).map((f) => `/p/${f}`).filter((f) => f.startsWith(dir.replace(/\/$/, '') + '/')),
});
const codes = (out: ReturnType<typeof build>) => out.diagnostics.map((d) => `${d.code} ${d.message}`);

test('in a candidate of `<sn-component use>` (a shared definition), over constants: the build decides it too (fuzz seed 33)', async () => {
  const components = {
    'c-plain': '<template data-sn-props="{ x: any }"><b data-sn-text="x.t"></b></template>',
    'c-empty': '<template data-sn-props="{ x: any }"><ol><template data-sn-for="y in x.c"><li data-sn-text="y.t"></li></template><template data-sn-else><li>none</li></template></ol></template>',
    'c-choice': '<template data-sn-props="{ x: any }"><sn-component use="{ p: \'c-plain\', e: \'c-empty\' }[x.k]" data-sn-with="{ x }"></sn-component></template>',
  };
  const r = await render('<div data-sn-state="{ d: [{ k: \'e\', c: [], t: \'a\' }, { k: \'e\', c: [{ t: \'b\' }], t: \'c\' }] }"><template data-sn-for="x in d"><c-choice data-sn-with="{ x }"></c-choice></template></div>', { components });
  await r.settle();
  expect([...r.root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['none', 'b']);
});

describe('at build time', () => {
  test('a `file:` list that is empty: the empty state is page markup; one with entries: no empty state', () => {
    const empty = build('<sn-resource name="posts" src="file:/data/p.json" key="id"></sn-resource><ul><template data-sn-for="p in posts"><li data-sn-text="p.t"></li></template><template data-sn-else><li>No posts yet</li></template></ul>', { 'data/p.json': '[]' });
    expect(codes(empty)).toEqual([]);
    expect(empty.html).toContain('<ul><li>No posts yet</li></ul>');
    expect(empty.html).not.toContain('<template');
    const full = build('<sn-resource name="posts" src="file:/data/p.json" key="id"></sn-resource><ul><template data-sn-for="p in posts"><li data-sn-text="p.t"></li></template><template data-sn-else><li>No posts yet</li></template></ul>', { 'data/p.json': '[{"id":1,"t":"One"}]' });
    expect(full.html).toContain('<ul><li>One</li></ul>');
    expect(full.html).not.toContain('No posts yet');
  });

  test('an else-if after a list: refused, with the form that chooses inside the empty state', () => {
    const out = build('<div data-sn-state="{ xs: [], q: 1 }"><button data-sn-on-click="xs = []; q = 2"></button><template data-sn-for="x in xs"><b></b></template><template data-sn-else data-sn-if="q"><i></i></template></div>');
    expect(codes(out)).toEqual([expect.stringMatching(/^SN102 the `data-sn-else` after a `data-sn-for` is the list's empty state, which takes no condition/)]);
  });

  test('a second else after the empty state, and an else after nothing: SN102', () => {
    const out = build('<div data-sn-state="{ xs: [] }"><button data-sn-on-click="xs = []"></button><template data-sn-for="x in xs"><b></b></template><template data-sn-else><i></i></template><template data-sn-else><u></u></template></div>');
    expect(codes(out)).toEqual([expect.stringMatching(/^SN102 `data-sn-else` must be on a `<template>` directly after a `data-sn-if` template, or after a `data-sn-for`/)]);
  });

  test('a list with its empty state is no component root', () => {
    const out = compile('<!doctype html><html><head></head><body><x-l></x-l></body></html>', {
      file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, componentNames: ['x-l'],
      readFile: (f) => { if (f.endsWith('components/x-l.html')) return '<template data-sn-props="{}"><template data-sn-for="x in [1]"><b></b></template><template data-sn-else><i></i></template></template>'; throw new Error(f); },
    });
    expect(out.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([expect.stringMatching(/^SN312 .*`<template data-sn-for>` and its `data-sn-else` cannot be the root/)]);
  });
});

describe('first paint', () => {
  // the early requests: never answered here
  beforeEach(() => { vi.stubGlobal('fetch', () => new Promise(() => {})); });
  afterEach(() => { vi.unstubAllGlobals(); });

  test('never while data is on its way: the early file paints the loading branch, not the empty state', async () => {
    const page = `<!doctype html><html><head></head><body>
      <sn-resource name="c" src="/api/c" items="c" key="id"></sn-resource>
      <template data-sn-if="$meta.c.loading && !c.length"><p id="loading">Loading…</p></template>
      <ul><template data-sn-for="x in c"><li data-sn-text="x.name"></li></template><template data-sn-else><li id="none">None</li></template></ul></body></html>`;
    await firstPaint(page);
    expect(document.getElementById('loading')).not.toBeNull();
    expect(document.getElementById('none')).toBeNull();
    const r = await render(page, { requests: mockRequests({ 'GET /api/c': { c: [] } }), firstPaint: true });
    await r.settle();
    expect(document.getElementById('loading')).toBeNull();
    expect(none(r.root)).toBe(true);
  });

  test('over state the early file knows: painted early, and adopted', async () => {
    const page = `<!doctype html><html><head></head><body data-sn-state="{ xs: [] }"><button data-sn-on-click="xs = [{ n: 'a' }]"></button>
      <ul><template data-sn-for="x in xs"><li data-sn-text="x.n"></li></template><template data-sn-else><li id="none">None</li></template></ul></body></html>`;
    await firstPaint(page);
    expect(document.getElementById('none')).not.toBeNull();
    let early: Element | null = null;
    const r = await render(page, { firstPaint: { afterEarly: () => { early = document.getElementById('none'); } } });
    expect(early).not.toBeNull();
    expect(document.getElementById('none')).toBe(early);
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(none(r.root)).toBe(false);
  });
});
