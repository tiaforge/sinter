// Streams across a swap (docs/proposals/stream-handover.md): with the swap's window open, the old page's open
// connections park as its app is destroyed; the next page takes over those whose URL it declares, with the
// same transport, and the window's close shuts the rest and replays what arrived meanwhile. Each test does what
// swap-run.ts does at a commit: open the window, destroy the old app, mount the next page on the document,
// close the window a task later.
import { afterEach, expect, test } from 'vitest';
import { configure } from '../../src/index.js';
import { compileParts } from '../../src/compiler/index.js';
import { compactIR } from '../../src/ir.js';
import { type App, instance, mount } from '../../src/runtime/app.js';
import { defaultEnv } from '../../src/runtime/env.js';
import sse from '../../src/sse.js';
import { streamWindow, streamsFrom } from '../../src/swap-run.js';
import type { Transport } from '../../src/runtime/app.js';

const STREAMS = Symbol.for('sinter.streams');
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  try { instance(document).destroy(); } catch { /* none */ }
  (globalThis as Record<symbol, unknown>)[STREAMS] = undefined;
  configure({ transport: null as never, sessionProbe: null });
});

/** a fake transport per connect: the names it delivers (as `EventSource`, only those it listens to), and its state */
interface Fake { url: string; names: Set<string>; closed: boolean; open(): void; fail(): void; emit(name: string, p: unknown): void }
function transports(opts: { listen?: boolean } = {}) {
  const made: Fake[] = [];
  const factory = (url: string): Transport => {
    let ev: ((n: string, p: unknown) => void) | null = null, st: ((s: 'open' | 'error') => void) | null = null;
    const f: Fake = {
      url, names: new Set(), closed: false,
      open: () => st?.('open'),
      fail: () => st?.('error'),
      emit: (n, p) => { if (!f.closed && f.names.has(n)) ev?.(n, p); },
    };
    made.push(f);
    return {
      connect(_u, onEvent, onState, initial) { ev = onEvent; st = onState; for (const n of initial) f.names.add(n); },
      ...(opts.listen === false ? {} : { listen: (n: string) => void f.names.add(n) }),
      close() { f.closed = true; },
    };
  };
  configure({ transport: factory });
  return { made, open: () => made.filter((f) => !f.closed) };
}

/** a page: a resource `items` fed by the stream, and its state `got` that the events' `then` append to */
function compile(body: string, head = '') {
  const parts = compileParts(`<html><head>${head}</head><body>${body}</body></html>`, {
    file: '/p/x.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  });
  const fns = new Function('$k', `return [${parts.fns.join(',')}]`)((x: unknown) => x);
  return { ir: compactIR(parts.ir), fns, html: /<body>([\s\S]*)<\/body>/i.exec(parts.html)![1]!, head: /<head>([\s\S]*)<\/head>/i.exec(parts.html)![1]!.replace(/<script type="module"[^>]*><\/script>/g, '') };
}

let fetched: string[] = [];
const env = {
  ...defaultEnv,
  href: () => 'http://localhost/',
  // a reconnect's backoff at once
  setTimeout: (fn: () => void, ms: number, kind?: string) => setTimeout(fn, kind === 'backoff' ? 0 : ms),
  fetch: async (r: Request) => {
    fetched.push(new URL(r.url).pathname);
    return new Response('{"items":[]}', { headers: { 'Content-Type': 'application/json' } });
  },
};

function show(p: ReturnType<typeof compile>): App {
  document.head.innerHTML = p.head;
  document.body.innerHTML = p.html;
  return mount(document, { ir: p.ir, fns: p.fns, env, features: [sse] });
}

/** a swap from the page shown to `next`, as swap-run.ts commits it; `between` runs after the destroy, before the mount */
async function swapTo(next: ReturnType<typeof compile>, between?: () => void) {
  const close = streamWindow();
  instance(document).destroy();
  between?.();
  const app = show(next);
  // the sse feature connects or takes over in a microtask of the mount; the swap closes the window a task later
  await Promise.resolve();
  await Promise.resolve();
  await tick();
  close();
  return app;
}

const sync = (src: string, events: string) => `<sn-sync src="${src}">${events}</sn-sync>`;
const A = compile(`<div data-sn-state="{ got: [] }">
  <sn-resource name="items" src="/api/items" select="items" key="id"></sn-resource>
  ${sync('/events', '<sn-event name="item" resource="items" op="upsert"></sn-event><sn-event name="note" then="got = [...got, $event.text]"></sn-event>')}
  <p id="got" data-sn-text="got.join(',')"></p><p id="live" data-sn-text="$meta.items.live"></p>
  <ul><template data-sn-for="x in items"><li data-sn-text="x.id"></li></template></ul></div>`);
const B = compile(`<div data-sn-state="{ got: [] }">
  <sn-resource name="items" src="/api/other" select="items" key="id"></sn-resource>
  ${sync('/events', '<sn-event name="item" resource="items" op="upsert"></sn-event><sn-event name="note" then="got = [...got, \'B:\' + $event.text]"></sn-event><sn-event name="extra" then="got = [...got, \'x\']"></sn-event>')}
  <p id="got" data-sn-text="got.join(',')"></p><p id="live" data-sn-text="$meta.items.live"></p>
  <ul><template data-sn-for="x in items"><li data-sn-text="x.id"></li></template></ul></div>`);
const NONE = compile(`<p>no stream</p>`);
const OTHER = compile(`${sync('/other-events', '<sn-event name="note" then="0"></sn-event>')}`);

const text = (id: string) => document.getElementById(id)!.textContent;
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

async function onA() {
  fetched = [];
  const t = transports();
  show(A);
  await settle();
  t.made[0]!.open();
  await settle();
  return t;
}

test('a stream both pages declare stays open across the swap; the next page maps its events', async () => {
  const t = await onA();
  expect(t.made).toHaveLength(1);
  await swapTo(B);
  await settle();
  expect(t.made).toHaveLength(1);
  expect(t.made[0]!.closed).toBe(false);
  // the next page's names are listened to; its handlers apply, not the old page's
  expect(t.made[0]!.names.has('extra')).toBe(true);
  t.made[0]!.emit('note', { text: 'hi' });
  t.made[0]!.emit('extra', {});
  await settle();
  expect(text('got')).toBe('B:hi,x');
  // the connection is open: the next page shows it, and its resources were fetched once, no catch-up refetch
  expect(text('live')).toBe('open');
  expect(fetched.filter((p) => p === '/api/other')).toHaveLength(1);
});

test('events in the gap reach the next page once, in order, before a live event', async () => {
  const t = await onA();
  const c = t.made[0]!;
  const close = streamWindow();
  instance(document).destroy();
  c.emit('note', { text: '1' });
  c.emit('note', { text: '2' });
  show(B);
  await Promise.resolve(); await Promise.resolve();
  // taken over, still holding until the window closes
  c.emit('note', { text: '3' });
  await tick();
  expect(text('got')).toBe('');
  close();
  c.emit('note', { text: '4' });
  await settle();
  expect(text('got')).toBe('B:1,B:2,B:3,B:4');
});

test('a page without the URL: the stream closes when the window does', async () => {
  const t = await onA();
  await swapTo(NONE);
  expect(t.made[0]!.closed).toBe(true);
  expect(t.open()).toHaveLength(0);
});

test('another URL: the old one closes, the next page opens its own', async () => {
  const t = await onA();
  await swapTo(OTHER);
  expect(t.made[0]!.closed).toBe(true);
  expect(t.open().map((f) => f.url)).toEqual(['/other-events']);
});

test('interpolated src: the same value is taken over, another is a new connection', async () => {
  const room = (r: string) => compile(`<div data-sn-state="{ room: '${r}' }">${sync('/rooms/{room}/events', '<sn-event name="note" then="0"></sn-event>')}</div>`);
  const t = transports();
  show(room('a'));
  await settle();
  t.made[0]!.open();
  await swapTo(room('a'));
  expect(t.made).toHaveLength(1);
  expect(t.made[0]!.closed).toBe(false);
  await swapTo(room('b'));
  expect(t.made[0]!.closed).toBe(true);
  expect(t.open().map((f) => f.url)).toEqual(['/rooms/b/events']);
});

test('another config.transport: not taken over', async () => {
  const t = await onA();
  const u = transports();
  await swapTo(B);
  expect(t.made[0]!.closed).toBe(true);
  expect(u.open()).toHaveLength(1);
});

test('a transport without listen is taken over only when it already delivers every name the next page maps', async () => {
  fetched = [];
  const t = transports({ listen: false });
  show(A);
  await settle();
  t.made[0]!.open();
  // B maps `extra`, which A did not
  await swapTo(B);
  expect(t.made[0]!.closed).toBe(true);
  expect(t.open()).toHaveLength(1);
  // B to B: the same names
  t.made[1]!.open();
  await swapTo(B);
  expect(t.made[1]!.closed).toBe(false);
  expect(t.made).toHaveLength(2);
});

test('an async mount: nothing closes before the next page has taken over', async () => {
  const t = await onA();
  const close = streamWindow();
  instance(document).destroy();
  // the swap closes after `await booted`: a mount that comes later (built-in messages) still takes over
  await tick();
  await tick();
  show(B);
  await Promise.resolve(); await Promise.resolve();
  await tick();
  close();
  expect(t.made).toHaveLength(1);
  expect(t.made[0]!.closed).toBe(false);
});

test('a newer swap before the close: the connection passes to its page, the stale close touches nothing', async () => {
  const t = await onA();
  const c = t.made[0]!;
  const closeA = streamWindow();
  instance(document).destroy();
  show(NONE);
  await Promise.resolve(); await Promise.resolve();
  // swap B commits before A's close task: A's parked connection is B's to take
  const closeB = streamWindow();
  instance(document).destroy();
  c.emit('note', { text: 'gap' });
  closeA();
  expect(c.closed).toBe(false);
  show(B);
  await Promise.resolve(); await Promise.resolve();
  await tick();
  closeB();
  await settle();
  expect(c.closed).toBe(false);
  expect(t.made).toHaveLength(1);
  expect(text('got')).toBe('B:gap');
});

test('a newer swap after the claim, before the replay: what the first next page held goes to the second', async () => {
  const t = await onA();
  const c = t.made[0]!;
  const closeA = streamWindow();
  instance(document).destroy();
  c.emit('note', { text: '1' });
  show(A);
  await Promise.resolve(); await Promise.resolve();
  const closeB = streamWindow();
  instance(document).destroy();
  c.emit('note', { text: '2' });
  closeA();
  show(B);
  await Promise.resolve(); await Promise.resolve();
  closeB();
  await settle();
  expect(text('got')).toBe('B:1,B:2');
});

test('an error while parked: the next page connects anew', async () => {
  const t = await onA();
  await swapTo(B, () => t.made[0]!.fail());
  expect(t.made[0]!.closed).toBe(true);
  expect(t.open()).toHaveLength(1);
  expect(t.made[1]!.closed).toBe(false);
});

test('after the takeover, a reconnect refetches the next page\'s resources, not the old page\'s', async () => {
  const t = await onA();
  await swapTo(B);
  await settle();
  fetched = [];
  t.made[0]!.fail();
  await settle();
  t.made[1]!.open();
  await settle();
  expect(fetched).toEqual(['/api/other']);
});

test('$meta.live: the taken-over state before the first frame', async () => {
  await onA();
  expect(text('live')).toBe('open');
  const close = streamWindow();
  instance(document).destroy();
  const app = show(B);
  await Promise.resolve(); await Promise.resolve();
  expect(app.resource('items').meta.live).toBe('open');
  close();
});

test('more than the cap held: the newest kept, what the stream feeds refetched once', async () => {
  const t = await onA();
  const c = t.made[0]!;
  const close = streamWindow();
  instance(document).destroy();
  for (let i = 0; i < 1005; i++) c.emit('note', { text: String(i) });
  show(B);
  await settle();
  fetched = [];
  close();
  await settle();
  const got = text('got')!.split(',');
  expect(got).toHaveLength(1000);
  expect(got[0]).toBe('B:5');
  expect(fetched).toEqual(['/api/other']);
});

test('no window: destroy closes as before', async () => {
  const t = await onA();
  instance(document).destroy();
  expect(t.made[0]!.closed).toBe(true);
});

test('an app mounted on an element neither parks nor takes over', async () => {
  const t = await onA();
  const host = document.createElement('div');
  host.innerHTML = B.html;
  const close = streamWindow();
  const inner = mount(host, { ir: B.ir, fns: B.fns, env, features: [sse] });
  await Promise.resolve(); await Promise.resolve();
  // its own connection, though the page's is open on the same URL
  expect(t.made).toHaveLength(2);
  inner.destroy();
  expect(t.made[1]!.closed).toBe(true);
  close();
  expect(t.made[0]!.closed).toBe(false);
});

test('names app.on listens to on the next page are listened to on the connection it takes over', async () => {
  const t = await onA();
  const close = streamWindow();
  instance(document).destroy();
  const app = show(B);
  const got: unknown[] = [];
  app.on('new_email', (p) => got.push(p));
  await Promise.resolve(); await Promise.resolve();
  close();
  expect(t.made[0]!.names.has('new_email')).toBe(true);
  t.made[0]!.emit('new_email', { id: 1 });
  expect(got).toEqual([{ id: 1 }]);
});

test('the page left while the window is open: what is parked closes', async () => {
  const t = await onA();
  streamWindow();
  instance(document).destroy();
  expect(t.made[0]!.closed).toBe(false);
  dispatchEvent(new Event('pagehide'));
  expect(t.made[0]!.closed).toBe(true);
});

test('an event the page shown applies while the next page\'s HTML is fetched: the next page refetches what it feeds, if its data came with the HTML', async () => {
  // caley: the contacts page's embedded list was older than a contact_updated sent while its HTML was in flight
  const embedded = compile(`<div data-sn-state="{ got: [] }">
    <sn-resource name="items" src="/api/other" select="items" key="id"></sn-resource>
    ${sync('/events', '<sn-event name="item" resource="items" op="upsert"></sn-event>')}
    <ul><template data-sn-for="x in items"><li data-sn-text="x.id"></li></template></ul></div>`,
  '<script type="application/json" data-sn-resource="items">{"items":[{"id":1}]}</script>');
  const t = await onA();
  const c = t.made[0]!;
  // the swap's fetch starts; the page shown applies an event meanwhile
  streamsFrom();
  c.emit('item', { id: 7 });
  c.emit('note', { text: 'n' });
  await settle();
  fetched = [];
  await swapTo(embedded);
  await settle();
  expect(fetched).toEqual(['/api/other']);
  // without such an event: no refetch
  streamsFrom();
  fetched = [];
  await swapTo(embedded);
  await settle();
  expect(fetched).toEqual([]);
});

test('from a page that does not listen to an event the next page maps: its data from the HTML is refetched, events may have been missed', async () => {
  // caley: settings maps no contact_updated, so EventSource never delivered the one sent during the fetch
  const embedded = compile(`<sn-resource name="items" src="/api/other" select="items" key="id"></sn-resource>
    ${sync('/events', '<sn-event name="item" resource="items" op="upsert"></sn-event>')}`,
  '<script type="application/json" data-sn-resource="items">{"items":[{"id":1}]}</script>');
  const notes = compile(sync('/events', '<sn-event name="note" then="0"></sn-event>'));
  const t = transports();
  show(notes);
  await settle();
  t.made[0]!.open();
  streamsFrom();
  fetched = [];
  await swapTo(embedded);
  await settle();
  expect(t.made).toHaveLength(1);
  expect(fetched).toEqual(['/api/other']);
});

test('an event the page shown applied while the HTML was fetched: a resource the next page loads at mount is not asked twice', async () => {
  const t = await onA();
  streamsFrom();
  t.made[0]!.emit('item', { id: 7 });
  fetched = [];
  await swapTo(B);
  await settle();
  expect(fetched).toEqual(['/api/other']);
});
