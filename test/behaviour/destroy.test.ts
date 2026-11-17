// destroy(): an app that goes while its document stays (the next page swapped in,
// docs/proposals/swap-navigation.md, step 1): its handlers go, it writes what it would write on pagehide, and
// it stops its timers and streams. The marks it set on elements that stay (`<html>`, `<body>`, kept elements)
// are cleared by the swap (swap-run.ts), not by the core.
import { expect, test } from 'vitest';
import { memoryStorage, mockRequests, mockStream, render } from '../../src/testing/index.js';

/** the symbols sinter set on an element (handlers, models, state, rows) */
const marks = (el: Element) => Object.getOwnPropertySymbols(el).map((s) => s.description).filter((d) => d?.startsWith('sinter.'));
const marked = (root: Element) => [root, ...root.querySelectorAll('*')].filter((el) => marks(el).length);

test('its handlers go with it: a click changes nothing (the marks on elements that stay are the swap\'s to clear)', async () => {
  const r = await render(`
    <section data-sn-state="{ n: 0, q: '', rows: [{ id: 1 }, { id: 2 }] }">
      <button id="inc" data-sn-on-click="n = n + 1"></button><b data-sn-text="n"></b>
      <input id="q" data-sn-model="q">
      <ul><template data-sn-for="row in rows" data-sn-key="row.id"><li><button data-sn-on-click="n = n + row.id"></button></li></template></ul>
    </section>`);
  await r.settle();
  expect(marked(r.root).length).toBeGreaterThan(0);
  r.app.destroy();
  (r.root.querySelector('#inc') as HTMLElement).click();
  await new Promise((res) => setTimeout(res, 0));
  expect(r.root.querySelector('b')!.textContent).toBe('0');
});

test('the first write leaves a value the element already has alone (a playing <audio>\'s src would restart)', async () => {
  // markup that already carries the value: what the early script rendered, or a kept element another
  // page's code bound; updates compare with the previous value already, the first write did not
  const { compileParts } = await import('../../src/compiler/index.js');
  const { compactIR } = await import('../../src/ir.js');
  const { mount, defaultEnv } = await import('../../src/runtime/app.js').then(async (m) => ({ mount: m.mount, defaultEnv: (await import('../../src/runtime/env.js')).defaultEnv }));
  const parts = compileParts(`<html><head></head><body><div data-sn-state="{ s: '/a.wav' }"><button data-sn-on-click="s = '/b.wav'"></button><audio data-sn-attr="{ src: s, title: s + '!' }"></audio></div></body></html>`, {
    file: '/p/x.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  });
  const fns = new Function('$k', `return [${parts.fns.join(',')}]`)((x: unknown) => x);
  const host = document.createElement('div');
  host.innerHTML = /<body>([\s\S]*)<\/body>/i.exec(parts.html)![1]!;
  const audio = host.querySelector('audio')!;
  audio.setAttribute('src', '/a.wav');
  const writes: string[] = [];
  new MutationObserver((ms) => { for (const m of ms) writes.push(m.attributeName!); }).observe(audio, { attributes: true });
  const app = mount(host, { ir: compactIR(parts.ir), fns, env: { ...defaultEnv, href: () => 'http://localhost/' }, features: [] });
  await new Promise((res) => setTimeout(res, 0));
  // `title` is new and written; `src` already had the value and is not
  expect(writes).toEqual(['title']);
  app.destroy();
});

test('`cache` writes confirmed changes when the app is destroyed, as on pagehide', async () => {
  const session = memoryStorage();
  const stream = mockStream();
  const LIST = `<sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" order="name" cache></sn-resource>
    <ul><template data-sn-for="c in contacts"><li data-sn-text="c.name"></li></template></ul>`;
  const r = await render(`${LIST}<sn-sync src="/api/events"><sn-event name="contact_updated" resource="contacts" op="upsert" item="contact"></sn-event></sn-sync>`,
    { session, requests: mockRequests({ 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }] } }), streams: { '/api/events': stream } });
  await r.settle();
  stream.emit('contact_updated', { contact: { id: 2, name: 'Grace' } });
  await r.flush();
  r.app.destroy();
  // the next page, from the cache, before any response
  const next = await render(LIST, { session, requests: mockRequests({ 'GET /api/contacts': { contacts: [] } }) });
  expect([...next.root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['Ada', 'Grace']);
});

test('its streams close and its timers stop', async () => {
  const stream = mockStream();
  const requests = mockRequests({ 'GET /api/jobs': { jobs: [] } });
  const r = await render(`<sn-resource name="jobs" src="/api/jobs" items="jobs" key="id" refresh="10s"></sn-resource>
    <sn-sync src="/api/events"><sn-event name="job" resource="jobs" op="upsert" item="job"></sn-event></sn-sync>`,
    { requests, streams: { '/api/events': stream } });
  await r.settle();
  expect(stream.connected).toBe(true);
  const gets = () => requests.calls.filter((c) => c.path === '/api/jobs').length;
  const before = gets();
  r.app.destroy();
  expect(stream.connected).toBe(false);
  await r.advance(60_000);
  expect(gets()).toBe(before);
});

test('a flush scheduled before destroy() does nothing after it (a stream\'s frame flush on the page swapped out)', async () => {
  const r = await render('<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n = n + 1"></button><b data-sn-text="n"></b></div>');
  await r.settle();
  let flushed = 0;
  r.app.afterFlush.push(() => { flushed++; });
  // a change whose flush is scheduled, then the app goes before it runs
  (r.root.querySelector('button') as HTMLElement).click();
  r.app.destroy();
  await new Promise((res) => setTimeout(res, 0));
  r.app.flush();
  expect(flushed).toBe(0);
  expect(r.root.querySelector('b')!.textContent).toBe('0');
});
