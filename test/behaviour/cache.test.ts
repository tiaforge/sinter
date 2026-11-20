// `cache` on <sn-resource>: the page-load cache in sessionStorage.
import { expect, test, vi } from 'vitest';
import { clearStored } from '../../src/index.js';
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
  expect(r.app.page.$meta.contacts.loadedAt).toEqual(new Date('2026-01-01T09:00:00Z'));
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
    <sn-sync src="/api/events"><sn-event name="contact_updated" resource="contacts" op="upsert" value="$event.contact"></sn-event></sn-sync>
    <button data-sn-delete="/api/contacts/1" data-sn-optimistic="remove(contacts[0])">delete</button>`;
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

test('clearStored() removes the cache too', async () => {
  const session = memoryStorage();
  await visit(session);
  clearStored();
  expect(cacheKeys(session)).toEqual([]);
});

test('embedded data wins over the cache and is cached itself', async () => {
  const session = memoryStorage();
  await visit(session);
  const requests = mockRequests({});
  const r = await render(`<html><head><script type="application/json" data-sn-resource="contacts">{"contacts":[{"id":9,"name":"Edsger"}]}</script></head><body>${LIST()}</body></html>`, { session, requests });
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
  const html = `<sn-resource name="rows" src="/api/rows" items="rows" total="total" key="id" paginate="{ numbered: true, size: 2 }" cache></sn-resource>
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
  expect(ok.module).toContain("import sn$cache from '@tiaforge-ui/sinter/runtime/cache'");
  expect(ok.module).toContain('"cache":7200000');
  expect(compile(LIST(''), opts).module).not.toContain('sinter/cache');
  const bad = compile(LIST('cache="soon"'), opts);
  expect(bad.diagnostics.map((d) => d.code)).toEqual(['SN401']);
  expect(bad.diagnostics[0]!.message).toContain('a duration such as `300ms`, `2s`, `10m`, `2h` or `1d`');
  // one duration grammar: `1d`, and `500ms`
  expect(compile(LIST('cache="1d"'), opts).module).toContain('"cache":86400000');
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

test('a resource turned off by `when` does not replace its cache entry with nothing', async () => {
  const session = memoryStorage();
  const html = `<div data-sn-state="{ on: true }">
    <sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" when="on" cache></sn-resource>
    <button data-sn-on-click="on = false">off</button>
    <ul><template data-sn-for="c in contacts"><li data-sn-text="c.name"></li></template></ul></div>`;
  const first = await visit(session, html);
  first.root.querySelector('button')!.click();
  await first.flush();
  expect(names(first.root)).toEqual([]);
  await first.window('pagehide');
  const second = await render(html, { session, requests: mockRequests({ 'GET /api/contacts': { contacts: [] } }) });
  expect(names(second.root)).toEqual(['Ada', 'Grace']);
});

// Back and Forward: a page reached by a history traversal (no back/forward cache) shows what it showed as it was
// left, with or without `cache`, then revalidates
test('Back to a page restores its resources as they were left, without `cache`, then revalidates', async () => {
  const session = memoryStorage();
  const stream = mockStream();
  const html = `${LIST('')}<sn-sync src="/api/events"><sn-event name="added" resource="contacts" op="upsert" value="$event.contact"></sn-event></sn-sync>`;
  const r = await render(html, { session, streams: { '/api/events': stream }, requests: mockRequests({ 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }] } }) });
  await r.settle();
  // nothing written while the page is shown
  expect(cacheKeys(session)).toEqual([]);
  stream.emit('added', { contact: { id: 2, name: 'Grace' } });
  await r.settle();
  await r.window('pagehide');
  expect(cacheKeys(session)).toHaveLength(1);

  const requests = mockRequests({ 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }, { id: 3, name: 'Linus' }] } });
  const back = await render(html, { session, traverse: true, streams: { '/api/events': mockStream() }, requests });
  expect(names(back.root)).toEqual(['Ada', 'Grace']);
  expect(back.app.page.$meta.contacts.loadedAt).toBeNull();
  await back.settle();
  expect(names(back.root)).toEqual(['Ada', 'Linus']);

  // a link to the page (not Back) does not read it
  const again = await render(LIST(''), { session, requests: mockRequests({ 'GET /api/contacts': { contacts: [] } }) });
  expect(names(again.root)).toEqual([]);
  await again.settle();
});

test('Back ignores `cache`\'s age; a paginated list comes back at its page; a POST resource is not kept', async () => {
  const session = memoryStorage();
  const page = `<sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" cache="1m"></sn-resource>
    <sn-resource name="feed" src="/api/feed" items="feed" key="id" paginate="{ numbered: true, size: 1, model: $url.page }"></sn-resource>
    <sn-resource name="hits" src="/api/hits" method="POST" body="{ q: 1 }" items="hits" key="id"></sn-resource>
    <ul><template data-sn-for="c in contacts"><li data-sn-text="c.name"></li></template></ul>
    <ol><template data-sn-for="f in feed"><li data-sn-text="f.t"></li></template></ol>
    <i data-sn-text="hits.length"></i>`;
  const routes = { 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }] }, 'GET /api/feed': { feed: [{ id: 2, t: 'second' }] }, 'POST /api/hits': { hits: [{ id: 1 }] } };
  const r = await render(page, { session, url: '/?page=2', requests: mockRequests(routes) });
  await r.settle();
  await r.window('pagehide');
  const keys = cacheKeys(session);
  expect(keys).toHaveLength(2);
  expect(keys.some((k) => k.includes('/api/feed?page=2&limit=1'))).toBe(true);
  // an hour later: `cache="1m"` does not show it on a load; Back does
  const later = Date.parse('2026-01-01T10:00:00Z'), none = { 'GET /api/contacts': { contacts: [] }, 'GET /api/feed': { feed: [] }, 'POST /api/hits': { hits: [] } };
  const back = await render(page, { session, now: later, url: '/?page=2', traverse: true, requests: mockRequests(none) });
  expect(names(back.root)).toEqual(['Ada', 'second']);
  expect(back.app.page.$meta.feed.page).toBe(2);
  expect(back.root.querySelector('i')!.textContent).toBe('0');
  await back.settle();
  const load = await render(page, { session, now: later + 1000, url: '/?page=2', requests: mockRequests(none) });
  expect(names(load.root)).toEqual([]);
  await load.settle();
});

test('what Back restores is gone after a 401 and after clearStored()', async () => {
  const session = memoryStorage();
  const r = await visit(session, LIST(''));
  await r.window('pagehide');
  expect(cacheKeys(session)).toHaveLength(1);
  clearStored();
  expect(cacheKeys(session)).toEqual([]);
  const again = await visit(session, LIST(''));
  await again.window('pagehide');
  const failed = await render(`${LIST('')}<sn-resource name="me" src="/api/me"></sn-resource><b data-sn-text="me?.n"></b>`, { session, requests: mockRequests({ 'GET /api/contacts': { contacts: [] }, 'GET /api/me': { status: 401 } }) });
  await failed.settle().catch(() => {});
  expect(cacheKeys(session)).toEqual([]);
});

test('an entry over 256 KB is not written as the page is left', async () => {
  const session = memoryStorage();
  const big = Array.from({ length: 3000 }, (_, i) => ({ id: i, name: 'x'.repeat(100) }));
  const r = await visit(session, LIST(''), { contacts: big });
  await r.window('pagehide');
  expect(cacheKeys(session)).toEqual([]);
});
