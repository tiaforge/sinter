import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configure } from '../../src/index.js';
import { render, mockRequests } from '../../src/testing/index.js';
import { webSocketTransport, type WebSocketTransportOptions } from '../../src/ws.js';

/** A WebSocket the test drives: open(), send(event, data), message(raw), drop(). */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(readonly url: string, readonly protocols?: string | string[]) { FakeSocket.all.push(this); }
  close() { this.closed = true; this.onclose?.({ code: 1000 }); }
  open() { this.onopen?.({}); }
  message(data: unknown) { this.onmessage?.({ data }); }
  send(event: string, data: unknown) { this.message(JSON.stringify({ event, data })); }
  drop() { this.onclose?.({ code: 1006 }); }
}
const last = () => FakeSocket.all.at(-1)!;

beforeEach(() => { FakeSocket.all = []; vi.stubGlobal('WebSocket', FakeSocket); });
afterEach(() => {
  vi.unstubAllGlobals();
  configure({ transport: null, sessionProbe: null });
});

const PAGE = `
  <sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" order="name"></sn-resource>
  <sn-sync src="/ws/events">
    <sn-event name="contact_updated" resource="contacts" op="upsert" item="contact"></sn-event>
    <sn-event name="contact_removed" resource="contacts" op="remove"></sn-event>
  </sn-sync>
  <ul><template data-sn-for="c in contacts"><li data-sn-text="c.name"></li></template></ul>`;

const names = (root: HTMLElement) => [...root.querySelectorAll('li')].map((l) => l.textContent);

async function setup(options?: WebSocketTransportOptions) {
  configure({ sessionProbe: '/api/user', transport: (url) => (new URL(url, 'http://x').pathname.startsWith('/ws/') ? webSocketTransport(options) : undefined) });
  const requests = mockRequests({ 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }] }, 'GET /api/user': { id: 'me' } });
  const r = await render(PAGE, { requests });
  await r.settle();
  return { ...r, requests };
}

test('opens the stream URL as a WebSocket and applies mapped events', async () => {
  const { root, flush } = await setup();
  expect(FakeSocket.all).toHaveLength(1);
  const u = new URL(last().url);
  expect(u.protocol).toMatch(/^wss?:$/);
  expect(u.pathname).toBe('/ws/events');
  last().open();
  last().send('contact_updated', { contact: { id: 2, name: 'Bob' } });
  last().send('contact_removed', { id: 1 });
  await flush();
  expect(names(root)).toEqual(['Bob']);
});

test('drops unmapped, malformed and binary messages', async () => {
  const { root, flush } = await setup();
  last().open();
  last().send('something_else', { contact: { id: 3, name: 'Cy' } });
  last().message('not json');
  last().message(JSON.stringify({ data: { id: 1 } }));
  last().message(new ArrayBuffer(4));
  await flush();
  expect(names(root)).toEqual(['Ada']);
});

test('islands that listen later receive their events', async () => {
  const { app } = await setup();
  last().open();
  const got: unknown[] = [];
  app.on('new_email', (p) => got.push(p));
  last().send('new_email', { id: 9 });
  expect(got).toEqual([{ id: 9 }]);
});

test('a close reconnects through the session probe and refetches; the old socket is ignored', async () => {
  const { root, settle, requests, flush } = await setup();
  const first = last();
  first.open();
  first.drop();
  await settle();
  expect(requests.calls.map((c) => c.path)).toEqual(['/api/contacts', '/api/user']);
  expect(FakeSocket.all).toHaveLength(2);
  last().open();
  await settle();
  expect(requests.calls.map((c) => c.path)).toEqual(['/api/contacts', '/api/user', '/api/contacts']);
  first.send('contact_updated', { contact: { id: 4, name: 'Old' } });
  await flush();
  expect(names(root)).toEqual(['Ada']);
});

test('pagehide closes the socket without reporting an error', async () => {
  const { window, requests, settle } = await setup();
  last().open();
  await window('pagehide');
  expect(last().closed).toBe(true);
  await settle();
  expect(requests.calls.map((c) => c.path)).toEqual(['/api/contacts']);
  await window('pageshow');
  await settle();
  expect(FakeSocket.all).toHaveLength(2);
});

test('decode reads other message formats; protocols are passed through', async () => {
  const { root, flush } = await setup({
    protocols: 'events.v1',
    decode: (m) => { const [name, payload] = JSON.parse(m); return [name, payload]; },
  });
  expect(last().protocols).toBe('events.v1');
  last().open();
  last().message(JSON.stringify(['contact_updated', { contact: { id: 2, name: 'Bob' } }]));
  await flush();
  expect(names(root)).toEqual(['Ada', 'Bob']);
});
