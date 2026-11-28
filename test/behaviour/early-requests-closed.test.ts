// An early request whose `when` the state's initial values make false is not in the early file (docs/first-paint.md,
// "What an early file leaves out"): the early script would not send it. The page module requests it as before, when
// its state lets it. A `when` the early script may see differently (a stored value, the URL, a call) keeps the request
// early, where it is sent as soon as the head script runs and taken by the page module.
import { afterEach, expect, test } from 'vitest';
import { compile, earlyPage, type CompileOptions } from '../../src/compiler/index.js';
import { compileParts } from '../../src/compiler/compile.js';
import * as earlyExports from '../../src/early.js';
import { configured, requests, start } from '../../src/early.js';
import { setEnv, type Middleware } from '../../src/runtime/config.js';
import { defaultEnv } from '../../src/runtime/env.js';
import { memoryStorage, mockRequests, render, type MockRequests, type RecordedCall } from '../../src/testing/index.js';

const KEYS = ['sinter.prefetched', 'sinter.early.page'];
afterEach(() => {
  for (const k of KEYS) delete (globalThis as any)[Symbol.for(k)];
  setEnv(defaultEnv);
});

const OPTS: CompileOptions = { file: '/test/page.html', root: '/test', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null } };
const answer = (url: string) => ({ at: new URL(url, 'http://x').pathname + new URL(url, 'http://x').search });
/** the early file's requests of a page, as URL templates' literal starts */
const earlyRes = (html: string, opts: CompileOptions = OPTS) => (compileParts(html, opts).early?.ir.res ?? []).map((r) => r.src[0]);

/**
 * A page load: the page's early file (if it has one) starts its requests, answered and logged in `early`; then the
 * page module mounts, and what its request layer does not take from the early file reaches the mock (`calls`).
 */
async function load(html: string, o: { storage?: Storage; href?: string } = {}) {
  const parts = compileParts(html, OPTS).early;
  const early: string[] = [];
  const storage = o.storage ?? memoryStorage();
  setEnv({ ...defaultEnv, href: () => o.href ?? 'http://localhost/', storage: () => storage, fetch: async (r: Request) => { const u = new URL(r.url); early.push(u.pathname + u.search); return Response.json(answer(r.url)); } });
  if (parts) {
    const made = earlyPage(parts);
    // eslint-disable-next-line no-new-func -- the early file's function table and renderer
    const page = new Function('$k', ...made.uses, `"use strict"; const f = [${parts.fns.join(',\n')}]; return ${made.code};`)((x: unknown) => x, ...made.uses.map((u) => (earlyExports as Record<string, unknown>)[u]));
    start(() => page, parts.ir.res?.length ? requests(configured) : null);
  }
  const mock = mockRequests({ 'GET /api/d': (c: RecordedCall) => answer(c.url), 'GET /api/list': () => [] });
  const net = ((req: Request, next: Parameters<Middleware>[1]) => next(req).catch((e: Error) => (/unexpected network request/.test(e.message) ? mock(req, next) : Promise.reject(e)))) as unknown as MockRequests;
  for (const k of ['calls', 'errors', 'pending', 'deliver'] as const) Object.defineProperty(net, k, { get: () => (typeof mock[k] == 'function' ? (mock[k] as () => unknown).bind(mock) : mock[k]) });
  const r = await render(html, { storage, ...(o.href ? { url: o.href } : {}), requests: net });
  await r.settle();
  const go = async (id: string) => { r.root.querySelector<HTMLElement>(`#${id}`)!.click(); await r.settle(); };
  return { ...r, early, calls: () => mock.calls.map((c) => c.url), text: () => r.root.querySelector('#d')!.textContent, go };
}

const page = (state: string, when: string, more = '') => `<!doctype html><html><head></head><body data-sn-state="${state}">
  <sn-resource name="list" src="/api/list?u={$url.u}"></sn-resource>
  <sn-resource name="d" src="/api/d?id={sel.id}" when="${when}"></sn-resource>
  <button id="pick" data-sn-on-click="sel = { id: 7 }">pick</button>${more}
  <p id="d" data-sn-text="d?.at"></p>
</body></html>`;

test('a request whose `when` the initial state makes false: not in the early file, and made by the page module when the state lets it', async () => {
  const html = page('{ sel: null }', 'sel');
  // (the other request, whose URL the page URL decides, stays)
  expect(earlyRes(html)).toEqual(['/api/list?u=']);
  const p = await load(html);
  expect(p.early).toEqual(['/api/list']);
  expect(p.calls()).toEqual([]);
  expect(p.text()).toBe('');
  await p.go('pick');
  expect(p.calls()).toEqual(['/api/d?id=7']);
  expect(p.text()).toBe('/api/d?id=7');
});

test('a `when` the initial state makes true: requested early, once, and taken by the page module', async () => {
  const html = page('{ sel: { id: 3 } }', 'sel');
  expect(earlyRes(html)).toEqual(['/api/list?u=', '/api/d?id=']);
  const p = await load(html);
  expect(p.early).toEqual(['/api/list', '/api/d?id=3']);
  expect(p.calls()).toEqual([]);
  expect(p.text()).toBe('/api/d?id=3');
});

test('what the early script may see differently keeps the request early: a stored value, the URL, a call', async () => {
  // a persisted model's field: the stored value opens it before the page module runs
  const stored = page('{ sel: null, on: false }', 'on && sel', '<input id="on" type="checkbox" data-sn-model="on" data-sn-persist="on">');
  expect(earlyRes(stored)).toEqual(['/api/list?u=', '/api/d?id=']);
  expect(earlyRes(page('{ sel: null }', 'sel || $url.open'))).toEqual(['/api/list?u=', '/api/d?id=']);
  expect(earlyRes(page('{ sel: null, open: !!$url.open }', 'open && sel'))).toEqual(['/api/list?u=', '/api/d?id=']);
  expect(earlyRes(page('{ sel: null, ids: [] }', 'ids.includes(1)'))).toEqual(['/api/list?u=', '/api/d?id=']);
  expect(earlyRes(page('{ sel: null }', 'on(sel)'), { ...OPTS, helpers: { module: '/h.js', names: ['on'], namespaces: {} } })).toEqual(['/api/list?u=', '/api/d?id=']);
  // a persisted state
  const persisted = `<!doctype html><html><head></head><body><div data-sn-state="{ sel: null }" data-sn-persist="ui">
    <sn-resource name="d" src="/api/d?id={sel.id}" when="sel"></sn-resource><p id="d" data-sn-text="d?.at"></p></div></body></html>`;
  expect(earlyRes(persisted)).toEqual(['/api/d?id=']);
  const storage = memoryStorage();
  storage.setItem('sn:ui', '{"sel":{"id":5}}');
  const p = await load(persisted, { storage });
  expect(p.early).toEqual(['/api/d?id=5']);
  expect(p.calls()).toEqual([]);
  expect(p.text()).toBe('/api/d?id=5');
});

test('a page whose only early work was such a request keeps an early file, with nothing in it, and loads as before', async () => {
  const html = `<!doctype html><html><head></head><body data-sn-state="{ sel: null }">
    <sn-resource name="d" src="/api/d?id={sel.id}" when="sel"></sn-resource>
    <button id="pick" data-sn-on-click="sel = { id: 9 }">pick</button><p id="d" data-sn-text="d?.at"></p></body></html>`;
  const early = compile(html, OPTS).early!;
  expect(early).toContain('scopes: () => [], render: () => {} }');
  expect(early).not.toContain('requests');
  const p = await load(html);
  expect(p.early).toEqual([]);
  await p.go('pick');
  expect(p.calls()).toEqual(['/api/d?id=9']);
});

// The review's case (round 1 of the branch): the `when` reads a member of an object, and a persisted model writes it
// through a child state's copy of that object. With a stored value the early script's `when` is true, and the request
// leaves from the head script. A `when` that reads below a field is not read by the rule.
const COPY = `<!doctype html><html><head></head><body data-sn-state="{ sel: { id: 0 } }">
  <div data-sn-state="{ s: sel }"><input type="number" data-sn-model="s.id" data-sn-persist="picked"></div>
  <sn-resource name="d" src="/api/d?id={sel.id}" when="sel.id"></sn-resource>
  <p id="d" data-sn-text="d?.at"></p>
</body></html>`;

test('a selection persisted through a child state\'s copy of the object: nothing stored, no request; stored, its detail is requested from the head script', async () => {
  expect(earlyRes(COPY)).toEqual(['/api/d?id=']);
  const none = await load(COPY);
  expect(none.early).toEqual([]);
  expect(none.calls()).toEqual([]);
  const storage = memoryStorage();
  storage.setItem('sn:picked', '7');
  const p = await load(COPY, { storage });
  expect(p.text()).toBe('/api/d?id=7');
  expect(p.early, 'the request leaves from the head script').toEqual(['/api/d?id=7']);
  expect(p.calls(), 'the page module sends none of its own').toEqual([]);
});

test('one guard each, for a `when`: a member below a field, a persisted model below a field elsewhere on the page, an initializer that is no literal', () => {
  const both = ['/api/list?u=', '/api/d?id='];
  // the reference: left out
  expect(earlyRes(page('{ sel: null, n: 0 }', 'n > 0', '<button data-sn-on-click="n = 2">n</button>'))).toEqual(['/api/list?u=']);
  expect(earlyRes(page('{ sel: { id: 0 } }', 'sel.id'))).toEqual(both);
  expect(earlyRes(page('{ sel: null, prefs: { dense: false } }', 'sel', '<input type="checkbox" data-sn-model="prefs.dense" data-sn-persist="dense">'))).toEqual(both);
  expect(earlyRes(page('{ sel: null, n: 1 - 1 }', 'n > 0', '<button data-sn-on-click="n = 2">n</button>'))).toEqual(both);
});
