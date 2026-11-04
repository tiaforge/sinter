import { afterEach, expect, test } from 'vitest';
import { configure, loginRedirect, onUnauthorized } from '../../src/index.js';
import { render, mockRequests, mockStream } from '../../src/testing/index.js';

afterEach(() => configure({ request: [], onError: null, sessionProbe: null }));

const PAGE = `
  <sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" order="name"></sn-resource>
  <sn-sync src="/api/events/stream">
    <sn-event name="contact_updated" resource="contacts" op="upsert" item="contact" fallback="refetch"></sn-event>
    <sn-event name="contact_patched" resource="contacts" op="patch" set="{name}"></sn-event>
    <sn-event name="contact_removed" resource="contacts" op="remove"></sn-event>
    <sn-event name="contacts_refetch" resource="contacts" op="refetch"></sn-event>
  </sn-sync>
  <ul><template data-sn-for="c in contacts"><li data-sn-text="c.name"></li></template></ul>`;

const names = (root: HTMLElement) => [...root.querySelectorAll('li')].map((l) => l.textContent);

async function setup(contacts = [{ id: 1, name: 'Ada' }]) {
  let data = contacts;
  const requests = mockRequests({ 'GET /api/contacts': () => ({ contacts: data }), 'GET /api/user': { id: 'me' } });
  const stream = mockStream();
  const r = await render(PAGE, { requests, streams: { '/api/events/stream': stream } });
  await r.settle();
  return { ...r, requests, stream, set: (d: typeof contacts) => { data = d; } };
}

test('server events upsert, patch and remove', async () => {
  const { root, stream, flush } = await setup();
  expect(stream.connected).toBe(true);
  stream.emit('contact_updated', { contact: { id: 2, name: 'Bob' } });
  await flush();
  expect(names(root)).toEqual(['Ada', 'Bob']);
  stream.emit('contact_patched', { id: 1, name: 'Zed' });
  await flush();
  expect(names(root)).toEqual(['Bob', 'Zed']);
  stream.emit('contact_removed', { id: 2 });
  await flush();
  expect(names(root)).toEqual(['Zed']);
});

test('fallback refetch when the event has no body; refetches coalesce', async () => {
  const { root, stream, settle, requests, set } = await setup();
  set([{ id: 1, name: 'Ada' }, { id: 3, name: 'Cy' }]);
  stream.emit('contact_updated', { contact: null });
  stream.emit('contacts_refetch', {});
  stream.emit('contacts_refetch', {});
  await settle();
  expect(names(root)).toEqual(['Ada', 'Cy']);
  expect(requests.calls.filter((c) => c.path === '/api/contacts')).toHaveLength(2);
});

test('islands receive every server event, mapped or not', async () => {
  const { stream, app } = await setup();
  const got: unknown[] = [];
  app.on('new_email', (p) => got.push(p));
  stream.emit('new_email', { id: 9 });
  expect(got).toEqual([{ id: 9 }]);
});

test('reconnect goes through the session probe and refetches once', async () => {
  configure({ sessionProbe: '/api/user' });
  const { stream, settle, requests, advance } = await setup();
  stream.drop();
  await settle();
  expect(requests.calls.map((c) => c.path)).toEqual(['/api/contacts', '/api/user', '/api/contacts']);
  expect(stream.connected).toBe(true);
  void advance;
});

test('network errors back off and probe again; offline is not logged out', async () => {
  configure({ sessionProbe: '/api/user' });
  let up = false;
  const requests = mockRequests({
    'GET /api/contacts': { contacts: [] },
    'GET /api/user': () => { if (!up) throw new TypeError('offline'); return { id: 'me' }; },
  });
  const stream = mockStream();
  const { settle, advance, navigations } = await render(PAGE, { requests, streams: { '/api/events/stream': stream } });
  await settle();
  stream.drop();
  await settle();
  expect(stream.connected).toBe(false);
  const probes = () => requests.calls.filter((c) => c.path === '/api/user').length;
  const before = probes();
  up = true;
  await advance(2000);
  await settle();
  expect(probes()).toBeGreaterThan(before);
  expect(stream.connected).toBe(true);
  expect(navigations).toEqual([]);
});

test('a 401 from the probe leads to login and no reconnect', async () => {
  configure({ sessionProbe: '/api/user', request: [onUnauthorized(loginRedirect({ to: '/login' }))] });
  const requests = mockRequests({ 'GET /api/contacts': { contacts: [] }, 'GET /api/user': { status: 401 } });
  const stream = mockStream();
  const { settle, navigations } = await render(PAGE, { requests, streams: { '/api/events/stream': stream } });
  await settle();
  stream.drop();
  await settle().catch(() => {});
  expect(navigations).toEqual(['/login']);
  expect(stream.connected).toBe(false);
});

test('pagehide closes the stream; pageshow probes and reconnects', async () => {
  configure({ sessionProbe: '/api/user' });
  const { stream, window, settle } = await setup();
  await window('pagehide');
  expect(stream.connected).toBe(false);
  await window('pageshow');
  await settle();
  expect(stream.connected).toBe(true);
});

test('optimistic layers: overlapping actions and server events mid-flight', async () => {
  const requests = mockRequests({
    'GET /api/m': { m: [{ id: 1, read: false, flagged: false, subject: 'hi' }] },
    'PATCH /api/read': { status: 500 },
    'PATCH /api/flag': null,
  });
  const stream = mockStream();
  const { root, flush, settle } = await render(`
    <sn-resource name="m" src="/api/m" items="m" key="id"></sn-resource>
    <sn-sync src="/s"><sn-event name="msg" resource="m" op="upsert"></sn-event></sn-sync>
    <template data-sn-for="x in m">
      <div>
        <span data-sn-text="[x.subject, x.read ? 'read' : 'unread', x.flagged ? 'flag' : '-'].join(' ')"></span>
        <button id="read" data-sn-patch="/api/read" data-sn-body="{id: x.id}" data-sn-optimistic="patch('m', x, {read: true})">r</button>
        <button id="flag" data-sn-patch="/api/flag" data-sn-body="{id: x.id}" data-sn-optimistic="patch('m', x, {flagged: true})">f</button>
      </div>
    </template>`, { requests, streams: { '/s': stream } });
  await settle();
  const text = () => root.querySelector('span')!.textContent;
  root.querySelector<HTMLElement>('#read')!.click();
  root.querySelector<HTMLElement>('#flag')!.click();
  await flush();
  expect(text()).toBe('hi read flag');
  // a server update arrives while both requests are pending
  stream.emit('msg', { id: 1, read: false, flagged: false, subject: 'edited' });
  await flush();
  expect(text()).toBe('edited read flag');
  // the read request fails: only its layer is dropped; the flag layer stays until it settles
  await settle();
  expect(text()).toBe('edited unread -');
});

test('islands use app.optimistic() with the same layers', async () => {
  const requests = mockRequests({ 'GET /api/m': [{ id: 1 }, { id: 2 }], 'DELETE /api/m': { status: 500 } });
  const { root, flush, settle, app } = await render(`
    <sn-resource name="m" src="/api/m" key="id"></sn-resource>
    <p data-sn-text="m.length + ' ' + $meta.m.pending"></p>`, { requests });
  await settle();
  const res = app.resource('m');
  const p = app.optimistic(() => res.remove('1'), () => app.request('/api/m', { method: 'DELETE' })).catch((e) => e);
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('1 1');
  await settle();
  expect(((await p) as { status: number }).status).toBe(500);
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('2 0');
});
