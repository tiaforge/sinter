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

test('<sn-sync> inside a state element: src and event expressions read that state', async () => {
  // Caley's mail page: refetch the list only for the mailbox that is open
  const requests = mockRequests({ 'GET /api/m': [] });
  const stream = mockStream();
  const { root, settle } = await render(`<main data-sn-state="{ sel: 'inbox', topic: 'mail' }">
    <sn-resource name="m" src="/api/m" key="id"></sn-resource>
    <sn-sync src="/s/{topic}">
      <sn-event name="refetch" resource="m" op="refetch" when="mailbox === sel"></sn-event>
    </sn-sync>
    <button data-sn-on-click="sel = 'sent'"></button>
    <p data-sn-text="m.length"></p></main>`, { requests, streams: { '/s/mail': stream } });
  await settle();
  const loads = () => requests.calls.filter((c) => c.path === '/api/m').length;
  expect(loads()).toBe(1);
  stream.emit('refetch', { mailbox: 'sent' });
  await settle();
  expect(loads()).toBe(1);
  stream.emit('refetch', { mailbox: 'inbox' });
  await settle();
  expect(loads()).toBe(2);
  root.querySelector('button')!.click();
  await settle();
  stream.emit('refetch', { mailbox: 'sent' });
  await settle();
  expect(loads()).toBe(3);
});

test('an app destroyed before its streams connect opens none', async () => {
  const { mount } = await import('../../src/runtime/app.js');
  const { defaultEnv } = await import('../../src/runtime/env.js');
  const sse = (await import('../../src/sse.js')).default;
  const { compileParts } = await import('../../src/compiler/index.js');
  const parts = compileParts(`<html><head></head><body>${PAGE}</body></html>`, {
    file: '/p/x.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  });
  const fns = new Function('$k', `return [${parts.fns.join(',')}]`)((x: unknown) => x);
  // its own root: the previous test's page is still mounted on the document
  const host = document.createElement('div');
  host.innerHTML = /<body>([\s\S]*)<\/body>/i.exec(parts.html)![1]!;
  let open = 0;
  const env = { ...defaultEnv, href: () => 'http://localhost/', fetch: async () => new Response('{"contacts":[]}', { headers: { 'Content-Type': 'application/json' } }) };
  const app = mount(host, { ir: parts.ir, fns, env, features: [sse], transport: () => ({ connect() { open++; }, close() { open--; } }) });
  app.destroy();
  await new Promise((r) => setTimeout(r, 10));
  expect(open).toBe(0);
  let ran = false;
  app.addCleanup(() => { ran = true; });   // after destroy(): runs at once
  expect(ran).toBe(true);
});

test('<sn-sync>s that share a stream URL share one connection, and all their events apply', async () => {
  // Caley: the nav partial's sync and the page's sync both use /api/events/stream
  let connects = 0;
  let open = 0;
  const stream = mockStream();
  const counted = (): ReturnType<typeof stream.transport> => {
    const t = stream.transport();
    return {
      connect(...a) { connects++; open++; t.connect(...a); },
      listen: (n) => t.listen?.(n),
      close() { open--; t.close(); },
    };
  };
  configure({ transport: (url) => (url === '/api/events/stream' ? counted() : undefined) });
  const requests = mockRequests({ 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }] }, 'GET /api/n': { unread: 0 }, 'GET /api/user': { id: 'me' } });
  try {
    const { root, app, flush, settle } = await render(`
      <sn-include src="nav.html"></sn-include>
      ${PAGE}
      <p data-sn-text="n.unread"></p>`, {
      requests,
      files: { 'nav.html': `<sn-resource name="n" src="/api/n"></sn-resource>
        <sn-sync src="/api/events/stream">
          <sn-event name="unread" resource="n" op="upsert"></sn-event>
          <sn-event name="contacts_refetch" resource="n" op="refetch"></sn-event>
        </sn-sync>` },
    });
    await settle();
    expect(connects).toBe(1);
    stream.emit('contact_updated', { contact: { id: 2, name: 'Bob' } });
    stream.emit('unread', { unread: 4 });
    await flush();
    expect(names(root)).toEqual(['Ada', 'Bob']);
    expect(root.querySelector('p')!.textContent).toBe('4');
    // an event both syncs map applies in both, and islands still see it once
    const got: unknown[] = [];
    app.on('contacts_refetch', (p) => got.push(p));
    stream.emit('contacts_refetch', {});
    await settle();
    expect(got).toHaveLength(1);
    expect(requests.calls.filter((c) => c.path === '/api/n')).toHaveLength(2);
    expect(requests.calls.filter((c) => c.path === '/api/contacts')).toHaveLength(2);

    // a reconnect is one probe and one reconnect, refetching what either sync feeds
    configure({ sessionProbe: '/api/user' });
    stream.drop();
    await settle();
    expect(connects).toBe(2);
    expect(requests.calls.filter((c) => c.path === '/api/user')).toHaveLength(1);
    expect(requests.calls.filter((c) => c.path === '/api/n')).toHaveLength(3);
    expect(requests.calls.filter((c) => c.path === '/api/contacts')).toHaveLength(3);

    app.destroy();
    expect(open).toBe(0);
  } finally {
    configure({ transport: null });
  }
});

test('<sn-sync>s with different stream URLs keep their own connections', async () => {
  const a = mockStream();
  const b = mockStream();
  const requests = mockRequests({ 'GET /api/contacts': { contacts: [] } });
  const { root, flush, settle } = await render(`
    <sn-resource name="contacts" src="/api/contacts" items="contacts" key="id"></sn-resource>
    <sn-sync src="/s/a"><sn-event name="up" resource="contacts" op="upsert" item="contact"></sn-event></sn-sync>
    <sn-sync src="/s/b"><sn-event name="up" resource="contacts" op="upsert" item="contact"></sn-event></sn-sync>
    <ul><template data-sn-for="c in contacts"><li data-sn-text="c.name"></li></template></ul>`, { requests, streams: { '/s/a': a, '/s/b': b } });
  await settle();
  expect(a.connected && b.connected).toBe(true);
  a.emit('up', { contact: { id: 1, name: 'Ada' } });
  b.emit('up', { contact: { id: 2, name: 'Bob' } });
  await flush();
  expect(names(root)).toEqual(['Ada', 'Bob']);
});

test('`then` on <sn-event> runs after the change, with the payload and the sync\'s state in scope', async () => {
  // Caley: a removed contact closes the detail dialog that shows it
  const requests = mockRequests({ 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Bob' }] } });
  const stream = mockStream();
  let app: any;
  const seen: unknown[] = [];
  const r = await render(`<main data-sn-state="{ sel: null, removed: 0 }">
    <sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" order="name"></sn-resource>
    <sn-sync src="/api/events/stream">
      <sn-event name="contact_removed" resource="contacts" op="remove"
                then="removed++; seen(id); sel?.id === id && (sel = null, close('detail'))"></sn-event>
    </sn-sync>
    <ul><template data-sn-for="c in contacts"><li data-sn-on-click="sel = c; showModal('detail')" data-sn-text="c.name"></li></template></ul>
    <p data-sn-text="removed + ' ' + (sel?.name ?? '-')"></p>
    <dialog id="detail"><h2 data-sn-text="sel?.name"></h2></dialog></main>`, {
    requests, streams: { '/api/events/stream': stream },
    helpers: { seen: (id: number) => seen.push([id, app.resource('contacts').all().map((c: any) => c.name)]) },
  });
  app = r.app;
  await r.settle();
  r.root.querySelectorAll('li')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await r.flush();
  const dialog = r.root.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('h2')!.textContent).toBe('Bob');

  // another contact: the dialog stays open; the state write re-renders
  stream.emit('contact_removed', { id: 1 });
  await r.flush();
  expect(dialog.open).toBe(true);
  expect(r.root.querySelector('p')!.textContent).toBe('1 Bob');
  // the one it shows: the handler sees the list without it, clears `sel` and closes the dialog
  stream.emit('contact_removed', { id: 2 });
  await r.flush();
  expect(seen).toEqual([[1, ['Bob']], [2, []]]);
  expect(dialog.open).toBe(false);
  expect(r.root.querySelector('p')!.textContent).toBe('2 -');
});

test('`then` without resource and op only runs the handler; `when` gates it; a payload that cannot apply skips it', async () => {
  const requests = mockRequests({ 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }] } });
  const stream = mockStream();
  const { root, flush } = await render(`<main data-sn-state="{ last: '', n: 0 }">
    <sn-resource name="contacts" src="/api/contacts" items="contacts" key="id"></sn-resource>
    <sn-sync src="/api/events/stream">
      <sn-event name="notice" then="last = text" when="text !== 'skip'"></sn-event>
      <sn-event name="contact_removed" resource="contacts" op="remove" then="n++"></sn-event>
    </sn-sync>
    <p data-sn-text="last + ' ' + n + ' ' + contacts.length"></p></main>`, { requests, streams: { '/api/events/stream': stream } });
  const text = () => root.querySelector('p')!.textContent;
  await flush();
  stream.emit('notice', { text: 'hello' });
  stream.emit('notice', { text: 'skip' });
  // no key in the payload: nothing is removed and `then` does not run
  stream.emit('contact_removed', {});
  await flush();
  expect(text()).toBe('hello 0 0');
});
