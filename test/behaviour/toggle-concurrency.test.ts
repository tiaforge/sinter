// Same id, same control (docs/actions.md#pending-state-and-concurrency): a toggle is two buttons in an
// if/else with one id. An optimistic change swaps the branch at once, so a quick second click lands on the
// other button; it continues the first one's concurrency (queue, block, latest) and busy state, so its
// request waits for the first instead of racing it.
import { expect, test } from 'vitest';
import { mockRequests, render, type MockRequests } from '../../src/testing/index.js';

const TOGGLE = (concurrency = '') => `
  <sn-resource name="a" src="/api/a"></sn-resource>
  <template data-sn-if="a">
    <template data-sn-if="a.on"><button id="t" data-sn-delete="/api/a/on" ${concurrency} data-sn-optimistic="merge(a, { on: false })">On</button></template>
    <template data-sn-else><button id="t" data-sn-post="/api/a/on" ${concurrency} data-sn-optimistic="merge(a, { on: true })">Off</button></template>
  </template>`;

/** a server whose network answers the newest request first; each write sets `on` when it arrives */
function server() {
  const state = { on: false };
  const inner = mockRequests({
    'GET /api/a': () => ({ on: state.on }),
    'POST /api/a/on': () => ((state.on = true), { on: true }),
    'DELETE /api/a/on': () => ((state.on = false), { on: false }),
  });
  // `deliver` takes the queue in order: reversing it is a network that reorders
  const held: Array<() => Promise<unknown>> = [];
  const sent: string[] = [];
  const mw = ((req: Request) => new Promise<Response>((resolve, reject) => {
    if (req.method !== 'GET') sent.push(req.method);
    held.push(async () => {
      const p = inner(req, fetch).then(resolve, reject);
      // the mock records the request after reading its body: answer it once it is queued
      while (!inner.pending) await new Promise((x) => setTimeout(x, 0));
      await inner.deliver();
      return p;
    });
  })) as unknown as MockRequests;
  Object.defineProperties(mw, {
    calls: { get: () => inner.calls },
    errors: { get: () => inner.errors },
    pending: { get: () => held.length },
    deliver: { value: async () => { const batch = held.splice(0).reverse(); for (const f of batch) await f(); return batch.length; } },
  });
  return { state, requests: mw, sent };
}

test('a quick second click on the swapped-in twin waits for the first request: the server ends as the page shows', async () => {
  const { state, requests, sent } = server();
  const r = await render(TOGGLE(), { requests });
  await r.settle();
  const t = () => r.root.ownerDocument.getElementById('t') as HTMLButtonElement;
  t().click();
  await r.flush();
  // the optimistic change swapped the branch: the other button, busy as the one it replaced
  expect(t().textContent).toBe('On');
  expect(t().getAttribute('aria-busy')).toBe('true');
  t().click();
  await r.flush();
  // queued behind the POST, not sent beside it
  expect(sent).toEqual(['POST']);
  expect(requests.pending).toBe(1);
  await r.settle();
  expect(sent).toEqual(['POST', 'DELETE']);
  expect(state.on).toBe(false);
  expect(t().textContent).toBe('Off');
  expect(t().hasAttribute('aria-busy')).toBe(false);
});

test('block: the twin ignores clicks while the first request runs; latest: it keeps the newest', async () => {
  const b = server();
  const r = await render(TOGGLE('data-sn-concurrency="block"'), { requests: b.requests });
  await r.settle();
  const t = () => r.root.ownerDocument.getElementById('t') as HTMLButtonElement;
  t().click();
  await r.flush();
  t().click();
  await r.flush();
  await r.settle();
  expect(b.sent).toEqual(['POST']);
  expect(b.state.on).toBe(true);
  expect(t().textContent).toBe('On');

  const l = server();
  const r2 = await render(TOGGLE('data-sn-concurrency="latest"'), { requests: l.requests });
  await r2.settle();
  const t2 = () => r2.root.ownerDocument.getElementById('t') as HTMLButtonElement;
  t2().click();
  await r2.flush();
  t2().click();
  await r2.flush();
  expect(l.requests.pending).toBe(1);
  await r2.settle();
  expect(l.sent).toEqual(['POST', 'DELETE']);
  expect(l.state.on).toBe(false);
  expect(t2().textContent).toBe('Off');
});

test('a twin in another row is another control: rows never share a queue', async () => {
  const requests = mockRequests({
    'GET /api/items': [{ id: 1, fav: false }, { id: 2, fav: false }],
    'POST /api/items/1/fav': { id: 1, fav: true }, 'POST /api/items/2/fav': { id: 2, fav: true },
  });
  const r = await render(`
    <sn-resource name="items" src="/api/items" key="id"></sn-resource>
    <ul><template data-sn-for="x in items"><li>
      <template data-sn-if="x.fav"><button data-sn-attr="{ id: 'fav-' + x.id }" data-sn-delete="/api/items/{x.id}/fav" data-sn-optimistic="merge(x, { fav: false })">Unfav</button></template>
      <template data-sn-else><button data-sn-attr="{ id: 'fav-' + x.id }" data-sn-post="/api/items/{x.id}/fav" data-sn-optimistic="merge(x, { fav: true })">Fav</button></template>
    </li></template></ul>`, { requests });
  await r.settle();
  const doc = r.root.ownerDocument;
  (doc.getElementById('fav-1') as HTMLButtonElement).click();
  await r.flush();
  expect(doc.getElementById('fav-2')!.hasAttribute('aria-busy')).toBe(false);
  (doc.getElementById('fav-2') as HTMLButtonElement).click();
  await r.flush();
  expect(requests.pending).toBe(2);
  await r.settle();
});
