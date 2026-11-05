// `cache` on <sn-resource>: the page-load cache in sessionStorage.
import { expect, test, vi } from 'vitest';
import { clearPersisted } from '../../src/index.js';
import { compile } from '../../src/compiler/index.js';
import { memoryStorage, mockRequests, mockStream, render, type RouteResponse } from '../../src/testing/index.js';

const LIST = (attrs = 'cache') => `
  <sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" order="name" ${attrs}></sn-resource>
  <p data-sn-text="$meta.contacts.loading ? 'loading' : 'idle'"></p>
  <ul><template data-sn-for="c in contacts"><li data-sn-text="c.name"></li></template></ul>`;

const names = (root: HTMLElement) => [...root.querySelectorAll('li')].map((l) => l.textContent);
const status = (root: HTMLElement) => root.querySelector('p')!.textContent;
const cacheKeys = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i)!).filter((k) => k.startsWith('sn:c:'));

/** the first page: loads and caches */
async function visit(session: Storage, html = LIST(), body: RouteResponse = { contacts: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }] }) {
  const r = await render(html, { session, requests: mockRequests({ 'GET /api/contacts': body }) });
  await r.settle();
  return r;
}

test('the next page shows the cached data at once, then revalidates', async () => {
  const session = memoryStorage();
  await visit(session);
  const requests = mockRequests({ 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }, { id: 3, name: 'Linus' }] } });
  const r = await render(LIST(), { session, requests });
  // before any response: the cached list, and the revalidation running
  expect(names(r.root)).toEqual(['Ada', 'Grace']);
  expect(status(r.root)).toBe('loading');
  // not loaded from the server on this page yet
  expect(r.app.page.$meta.contacts.loadedAt).toBeNull();
  await r.settle();
  expect(names(r.root)).toEqual(['Ada', 'Linus']);
  expect(status(r.root)).toBe('idle');
  expect(r.app.page.$meta.contacts.loadedAt).toBe(Date.parse('2026-01-01T09:00:00Z'));
  expect(requests.calls).toHaveLength(1);
});

test('without `cache` nothing is stored', async () => {
  const session = memoryStorage();
  await visit(session, LIST(''));
  expect(cacheKeys(session)).toEqual([]);
});

test('a failed revalidation keeps the cached data and sets the error', async () => {
  const session = memoryStorage();
  await visit(session);
  const r = await render(LIST() + '<i data-sn-text="$meta.contacts.error?.status"></i>', { session, requests: mockRequests({ 'GET /api/contacts': { status: 500 } }) });
  await r.settle().catch(() => {});
  expect(names(r.root)).toEqual(['Ada', 'Grace']);
  expect(r.root.querySelector('i')!.textContent).toBe('500');
});

test('confirmed changes are written on pagehide; optimistic ones are not', async () => {
  const session = memoryStorage();
  const stream = mockStream();
  const html = `${LIST()}
    <sn-sync src="/api/events"><sn-event name="contact_updated" resource="contacts" op="upsert" item="contact"></sn-event></sn-sync>
    <button data-sn-delete="/api/contacts/1" data-sn-optimistic="remove('contacts', contacts[0])">delete</button>`;
  const requests = mockRequests({ 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }] }, 'DELETE /api/contacts/1': null });
  const r = await render(html, { session, requests, streams: { '/api/events': stream } });
  await r.settle();
  stream.emit('contact_updated', { contact: { id: 2, name: 'Grace' } });
  r.root.querySelector('button')!.click();
  await r.flush();
  expect(names(r.root)).toEqual(['Grace']);   // Ada is optimistically removed, the DELETE is still waiting
  await r.window('pagehide');

  const next = await render(LIST(), { session, requests: mockRequests({ 'GET /api/contacts': { contacts: [] } }) });
  expect(names(next.root)).toEqual(['Ada', 'Grace']);
});

test('`cache="10m"` ignores older entries', async () => {
  const session = memoryStorage();
  await visit(session, LIST('cache="10m"'));
  const later = Date.parse('2026-01-01T09:11:00Z');
  const r = await render(LIST('cache="10m"'), { session, now: later, requests: mockRequests({ 'GET /api/contacts': { contacts: [] } }) });
  expect(names(r.root)).toEqual([]);
  const sooner = await render(LIST('cache="10m"'), { session, now: Date.parse('2026-01-01T09:09:00Z'), requests: mockRequests({ 'GET /api/contacts': { contacts: [] } }) });
  expect(names(sooner.root)).toEqual(['Ada', 'Grace']);
});

test('any 401 removes every cache entry', async () => {
  const session = memoryStorage();
  await visit(session);
  session.setItem('sn:return', '/inbox');
  const r = await render(LIST(), { session, requests: mockRequests({ 'GET /api/contacts': { status: 401 } }) });
  await r.settle().catch(() => {});
  expect(cacheKeys(session)).toEqual([]);
  expect(session.getItem('sn:return')).toBe('/inbox');
});

test('clearPersisted() removes the cache too', async () => {
  const session = memoryStorage();
  await visit(session);
  clearPersisted();
  expect(cacheKeys(session)).toEqual([]);
});

test('embedded data wins over the cache and is cached itself', async () => {
  const session = memoryStorage();
  await visit(session);
  const requests = mockRequests({});
  const r = await render(`<html><head><script type="application/json" data-sn-data="contacts">{"contacts":[{"id":9,"name":"Edsger"}]}</script></head><body>${LIST()}</body></html>`, { session, requests });
  await r.settle();
  expect(names(r.root)).toEqual(['Edsger']);
  expect(requests.calls).toHaveLength(0);
  const next = await render(LIST(), { session, requests: mockRequests({ 'GET /api/contacts': { contacts: [] } }) });
  expect(names(next.root)).toEqual(['Edsger']);
});

test('two pages that load the same thing share the entry, whatever they call it', async () => {
  const session = memoryStorage();
  await visit(session);
  const r = await render(LIST().replace(/contacts(?=[" .\]])/g, 'people').replace('/api/people', '/api/contacts').replace('items="people"', 'items="contacts"'),
    { session, requests: mockRequests({ 'GET /api/contacts': { contacts: [] } }) });
  expect(names(r.root)).toEqual(['Ada', 'Grace']);
});

test('offset pages are cached per page', async () => {
  const session = memoryStorage();
  const html = `<sn-resource name="rows" src="/api/rows" items="rows" total="total" key="id" paginate="offset" page-size="2" cache></sn-resource>
    <ul><template data-sn-for="x in rows"><li data-sn-text="x.name"></li></template></ul><b data-sn-text="$meta.rows.pages"></b>`;
  const route = (c: { url: string }) => (new URL(c.url, 'http://x').searchParams.get('offset') === '2'
    ? { rows: [{ id: 3, name: 'c' }], total: 3 } : { rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], total: 3 });
  const r = await render(html, { session, requests: mockRequests({ 'GET /api/rows': route }) });
  await r.settle();
  const next = await render(html, { session, requests: mockRequests({ 'GET /api/rows': { rows: [], total: 0 } }) });
  expect(names(next.root)).toEqual(['a', 'b']);
  expect(next.root.querySelector('b')!.textContent).toBe('2');
  expect(cacheKeys(session)).toHaveLength(1);
});

test('an entry over 256 KB is not written, with a dev warning', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const session = memoryStorage();
  const big = { contacts: Array.from({ length: 3000 }, (_, i) => ({ id: i, name: 'x'.repeat(100) })) };
  await visit(session, LIST(), big);
  expect(cacheKeys(session)).toEqual([]);
  expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('over the page-load cache limit'))).toBe(true);
  warn.mockRestore();
});

test('a full storage drops the oldest entries and retries', async () => {
  const inner = memoryStorage();
  let limit = 2;
  const session: Storage = {
    get length() { return inner.length; },
    key: (i) => inner.key(i),
    getItem: (k) => inner.getItem(k),
    removeItem: (k) => inner.removeItem(k),
    clear: () => inner.clear(),
    setItem(k, v) {
      if (!inner.getItem(k) && cacheKeys(inner).length >= limit) throw new DOMException('full', 'QuotaExceededError');
      inner.setItem(k, v);
    },
  };
  for (const [i, path] of ['/api/a', '/api/b', '/api/c'].entries()) {
    const html = `<sn-resource name="r" src="${path}" key="id" cache></sn-resource><p data-sn-text="r.length"></p>`;
    const r = await render(html, { session, now: Date.parse('2026-01-01T09:00:00Z') + i * 1000, requests: mockRequests({ [`GET ${path}`]: [{ id: i }] }) });
    await r.settle();
  }
  expect(cacheKeys(session).map((k) => JSON.parse(k.slice(5))[0])).toEqual(['/api/b', '/api/c']);
  limit = 0;
});

test('the compiler checks `cache` and adds the feature only where it is used', () => {
  const opts = { file: '/x/i.html', root: '/x', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '' };
  const ok = compile(LIST('cache="2h"'), opts);
  expect(ok.diagnostics).toEqual([]);
  expect(ok.module).toContain("import cache from '@tiaforge/sinter/cache'");
  expect(ok.module).toContain('"cache":7200000');
  expect(compile(LIST(''), opts).module).not.toContain('sinter/cache');
  const bad = compile(LIST('cache="soon"'), opts);
  expect(bad.diagnostics.map((d) => d.code)).toEqual(['SN401']);
  expect(bad.diagnostics[0]!.message).toContain('`30s`, `10m`, `2h` or `1d`');
});

test('a guard on loadedAt does not act on cached data', async () => {
  // RealWorld's pattern: redirect when the server says there is no user
  const html = `<sn-resource name="user" src="/api/user" items="user" cache></sn-resource>
    <b data-sn-show="$meta.user.loadedAt && !user">signed out</b>`;
  const session = memoryStorage();
  const first = await render(html, { session, requests: mockRequests({ 'GET /api/user': { user: null } }) });
  await first.settle();
  const r = await render(html, { session, requests: mockRequests({ 'GET /api/user': { user: { name: 'Ada' } } }) });
  expect(r.root.querySelector('b')!.hidden).toBe(true);   // cached `user: null`, not yet confirmed
  await r.settle();
  expect(r.root.querySelector('b')!.hidden).toBe(true);
});
