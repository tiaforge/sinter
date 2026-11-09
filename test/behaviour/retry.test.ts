// Retry policies: a write is sent again only when its element names a policy; GETs use `retry.get`.
// Between tries the request waits (doubling, the clock in `advance`); after a network error the
// session probe decides. Writes carry one idempotency key on every try.
import { afterEach, expect, test } from 'vitest';
import { configure } from '../../src/index.js';
import { compile } from '../../src/compiler/index.js';
import { retry } from '../../src/retry.js';
import { mockRequests, render, type RecordedCall, type RouteResponse } from '../../src/testing/index.js';

afterEach(() => configure({ request: [], onError: null, sessionProbe: null, retry: null }));

const policies = {
  drafts: { backoff: ['1s', '30s'] as ['1s', '30s'] },
  three: { backoff: ['1s', '1s'] as ['1s', '1s'], retries: 3 },
  fiveMin: { backoff: ['5m', '5m'] as ['5m', '5m'], retries: 3 },
};

const NOTE = (attrs: string, extra = '') => `
  <main data-sn-state="{ saved: 0, failed: '' }" data-sn-on-sn-error="failed = $event.detail.error.message; $event.preventDefault()">
    <sn-resource name="notes" src="/api/notes" key="id"></sn-resource>
    <template data-sn-for="n in notes">
      <button data-sn-put="/api/notes/{n.id}" data-sn-body="{id: n.id, title: 'new'}" ${attrs}
              data-sn-optimistic="patch('notes', n, {title: 'new'})" data-sn-then="saved = saved + 1">save</button>
      <i data-sn-text="n.title"></i>
    </template>
    <b data-sn-text="saved"></b><s data-sn-text="failed"></s>${extra}
  </main>`;

/** a route that answers with each value in turn (the last one repeats); a thrown error is a network error */
function seq(...steps: Array<RouteResponse | Error>): RouteResponse {
  let i = 0;
  return (c: RecordedCall) => {
    const v = steps[Math.min(i++, steps.length - 1)];
    if (v instanceof Error) throw v;
    return typeof v == 'function' ? (v as (c: RecordedCall) => unknown)(c) : v;
  };
}
const offline = () => new TypeError('Failed to fetch');

async function page(put: RouteResponse, attrs = 'data-sn-retry="drafts"', o: { probe?: RouteResponse; extra?: string; method?: string } = {}) {
  configure({ retry: retry({ policies }), sessionProbe: o.probe ? '/api/user' : null });
  const requests = mockRequests({
    'GET /api/notes': [{ id: 1, title: 'old' }],
    [`${o.method ?? 'PUT'} /api/notes/1`]: put,
    ...(o.probe ? { 'GET /api/user': o.probe } : {}),
  });
  const r = await render(NOTE(attrs, o.extra), { requests });
  await r.settle();
  const button = () => r.root.querySelector('button')!;
  const text = (sel: string) => r.root.querySelector(sel)!.textContent;
  const sent = () => requests.calls.filter((c) => c.method == (o.method ?? 'PUT'));
  return { ...r, requests, button, text, sent, click: async () => { button().click(); await r.settle(); } };
}

test('without a policy a write is sent once and carries no key', async () => {
  const p = await page(seq(offline(), { id: 1, title: 'new' }), '');
  await p.click();
  expect(p.sent()).toHaveLength(1);
  expect(p.sent()[0]!.headers['idempotency-key']).toBeUndefined();
  expect(p.text('s')).toBe('Failed to fetch');
  expect(p.text('i')).toBe('old');
});

test('a network error waits, probes the session, and sends again with the same key', async () => {
  const p = await page(seq(offline(), { id: 1, title: 'new' }), undefined, { probe: { name: 'me' } });
  await p.click();
  expect(p.sent()).toHaveLength(1);
  // waiting: busy, the optimistic change shown, nothing reported
  expect(p.button().getAttribute('aria-busy')).toBe('true');
  expect(p.text('i')).toBe('new');
  expect(p.text('s')).toBe('');
  await p.advance(999);
  expect(p.requests.calls.filter((c) => c.path == '/api/user')).toHaveLength(0);
  await p.advance(1);
  await p.settle();
  expect(p.requests.calls.filter((c) => c.path == '/api/user')).toHaveLength(1);
  expect(p.sent()).toHaveLength(2);
  const [a, b] = p.sent().map((c) => c.headers['idempotency-key']);
  expect(a).toMatch(/^[0-9a-f-]{32,36}$/);
  expect(b).toBe(a);
  expect(p.text('b')).toBe('1');
  expect(p.button().hasAttribute('aria-busy')).toBe(false);
});

test('each trigger has its own key', async () => {
  const p = await page({ id: 1, title: 'new' });
  await p.click();
  await p.click();
  const keys = p.sent().map((c) => c.headers['idempotency-key']);
  expect(new Set(keys).size).toBe(2);
});

test('a probe that keeps failing waits longer; a 401 ends the write', async () => {
  const p = await page(seq(offline()), undefined, { probe: seq(offline(), { status: 401 }) });
  await p.click();
  await p.advance(1000);
  await p.settle();
  // the probe failed: wait twice as long, probe again
  await p.advance(2000);
  await p.settle();
  expect(p.requests.calls.filter((c) => c.path == '/api/user')).toHaveLength(2);
  expect(p.sent()).toHaveLength(1);
  expect(p.text('s')).toBe('unauthorized');
  expect(p.text('i')).toBe('old');
});

test('a 5xx is a failed try: no probe; the policy gives up after its retries', async () => {
  const p = await page({ status: 502 }, 'data-sn-retry="three"', { probe: { name: 'me' } });
  await p.click();
  for (let i = 0; i < 5; i++) { await p.advance(1000); await p.settle(); }
  expect(p.sent()).toHaveLength(4);
  expect(p.requests.calls.filter((c) => c.path == '/api/user')).toHaveLength(0);
  expect(p.text('s')).toBe('502');
  // rolled back
  expect(p.text('i')).toBe('old');
});

test('other 4xx fail at once', async () => {
  const p = await page({ status: 422, body: { message: 'title missing' } });
  await p.click();
  expect(p.sent()).toHaveLength(1);
  expect(p.text('s')).toBe('title missing');
});

test('429 waits for Retry-After, and fails at once when that is after the last allowed try', async () => {
  const p = await page(seq({ status: 429, headers: { 'Retry-After': '20' } }, { id: 1, title: 'new' }));
  await p.click();
  await p.advance(19_999);
  expect(p.sent()).toHaveLength(1);
  await p.advance(1);
  await p.settle();
  expect(p.sent()).toHaveLength(2);
  expect(p.text('b')).toBe('1');

  configure({ onError: null });
  const q = await page({ status: 429, headers: { 'Retry-After': '3600' } }, 'data-sn-retry="fiveMin"');
  await q.click();
  expect(q.sent()).toHaveLength(1);
  expect(q.text('s')).toBe('429');
});

test('a retried DELETE that finds nothing succeeded; a first try that finds nothing fails', async () => {
  const del = async (route: RouteResponse) => {
    configure({ retry: retry({ policies }) });
    const requests = mockRequests({ 'GET /api/notes': [{ id: 1, title: 'old' }], 'DELETE /api/notes/1': route });
    const r = await render(`<main data-sn-state="{ done: '', failed: '' }" data-sn-on-sn-error="failed = $event.detail.error.message; $event.preventDefault()">
      <sn-resource name="notes" src="/api/notes" key="id"></sn-resource>
      <template data-sn-for="n in notes"><button data-sn-delete="/api/notes/{n.id}" data-sn-retry="drafts" data-sn-then="done = 'deleted ' + $result"></button></template>
      <p data-sn-text="notes.length + ' ' + done + failed"></p></main>`, { requests });
    await r.settle();
    r.root.querySelector('button')!.click();
    await r.settle();
    await r.advance(1000);
    await r.settle();
    return r.root.querySelector('p')!.textContent;
  };
  // write-through rule 4 removes the row
  expect(await del(seq(offline(), { status: 404 }))).toBe('0 deleted null');
  expect(await del({ status: 404 })).toBe('1 404');
});

test('`latest`: a newer trigger replaces the write waiting for a retry', async () => {
  const p = await page(seq(offline(), { id: 1, title: 'new' }), 'data-sn-retry="drafts" data-sn-concurrency="latest"');
  await p.click();
  expect(p.sent()).toHaveLength(1);
  await p.click();
  // the waiting write is dropped and the newest is sent right away
  expect(p.sent()).toHaveLength(2);
  expect(p.text('b')).toBe('1');
  await p.advance(60_000);
  await p.settle();
  expect(p.sent()).toHaveLength(2);
});

test('leaving the page asks while a write waits', async () => {
  const p = await page(seq(offline(), { id: 1, title: 'new' }));
  const ask = async () => {
    let asked = false;
    await p.window('beforeunload', { preventDefault: () => { asked = true; }, returnValue: undefined });
    return asked;
  };
  expect(await ask()).toBe(false);
  await p.click();
  expect(await ask()).toBe(true);
  await p.advance(1000);
  await p.settle();
  expect(p.text('b')).toBe('1');
  expect(await ask()).toBe(false);
});

test('`online` ends the wait', async () => {
  const p = await page(seq(offline(), offline(), { id: 1, title: 'new' }));
  await p.click();
  await p.advance(1000);
  await p.settle();
  expect(p.sent()).toHaveLength(2);
  // now waiting 2 s
  await p.window('online');
  await p.settle();
  expect(p.sent()).toHaveLength(3);
  expect(p.text('b')).toBe('1');
});

test('maxAge: no new try once it has passed', async () => {
  configure({ retry: retry({ policies: { brief: { backoff: ['10s', '10s'], maxAge: '15s' } } }) });
  const requests = mockRequests({ 'GET /api/notes': [{ id: 1, title: 'old' }], 'PUT /api/notes/1': seq(offline()) });
  const r = await render(NOTE('data-sn-retry="brief"'), { requests });
  await r.settle();
  r.root.querySelector('button')!.click();
  await r.settle();
  await r.advance(10_000);
  await r.settle();
  expect(requests.calls.filter((c) => c.method == 'PUT')).toHaveLength(2);
  expect(r.root.querySelector('s')!.textContent).toBe('Failed to fetch');
});

test('an unknown policy fails the action; with no retry policies configured, the write is sent once', async () => {
  const p = await page({ id: 1 }, 'data-sn-retry="nope"');
  await p.click();
  expect(p.sent()).toHaveLength(0);
  expect(p.text('s')).toBe('unknown retry policy `nope`');
  configure({ retry: null });
  p.button().click();
  await p.settle();
  expect(p.sent()).toHaveLength(1);
  expect(p.sent()[0]!.headers['idempotency-key']).toBeUndefined();
  expect(p.text('b')).toBe('1');
});

test('retry() checks its policies', () => {
  expect(() => retry({ policies: { a: { backoff: ['1x' as '1s', '2s'] } } })).toThrow(/duration/);
  expect(() => retry({ policies: { a: { backoff: ['5s', '1s'] } } })).toThrow(/shorter/);
  expect(() => retry({ policies: { a: {} }, get: 'b' })).toThrow(/names no policy/);
});

test('`retry.get`: loads are retried, background refreshes are not', async () => {
  configure({ retry: retry({ policies, get: 'three' }) });
  const requests = mockRequests({ 'GET /api/jobs': seq(offline(), [{ id: 1 }], offline(), [{ id: 2 }]) });
  const r = await render(`<main data-sn-state="{ x: 0 }"><sn-resource name="jobs" src="/api/jobs" key="id" refresh="10s"></sn-resource>
    <p data-sn-text="jobs.map((j) => j.id).join() + ($meta.jobs.error ? ' error' : '') + ($meta.jobs.loading ? ' loading' : '')"></p></main>`, { requests });
  await r.settle();
  expect(r.root.querySelector('p')!.textContent).toBe(' loading');
  await r.advance(1000);
  await r.settle();
  expect(r.root.querySelector('p')!.textContent).toBe('1');
  // the refresh fails: no policy, the error shows at once
  await r.advance(10_000);
  await r.settle();
  expect(requests.calls).toHaveLength(3);
  expect(r.root.querySelector('p')!.textContent).toBe('1 error');
});

test('`retry.get` leaves background refreshes of an `each` resource to `refresh` too', async () => {
  configure({ retry: retry({ policies, get: 'three' }) });
  const requests = mockRequests({
    'GET /api/accounts': [{ id: 1 }],
    'GET /api/boxes': seq([{ id: 'a', account: 1 }], offline(), [{ id: 'b', account: 1 }]),
  });
  const r = await render(`<sn-resource name="accounts" src="/api/accounts" key="id"></sn-resource>
    <sn-resource name="boxes" each="a in accounts" src="/api/boxes?account={a.id}" key="id" refresh="10s"></sn-resource>
    <p data-sn-text="boxes.map((b) => b.id).join() + ($meta.boxes.error ? ' error' : '')"></p>`, { requests });
  await r.settle();
  expect(r.root.querySelector('p')!.textContent).toBe('a');
  await r.advance(10_000);
  await r.settle();
  // the refresh failed: no try of the policy after it
  await r.advance(1000);
  await r.settle();
  expect(requests.calls.filter((c) => c.path == '/api/boxes')).toHaveLength(2);
  expect(r.root.querySelector('p')!.textContent).toBe('a error');
});

test('the compiler: a policy name on a mutation only', () => {
  const opts = { file: '/x/i.html', root: '/x', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '' };
  const errors = (html: string) => compile(html, opts).diagnostics.map((d) => `${d.code} ${d.message}`);
  expect(errors('<button data-sn-post="/api/x" data-sn-retry="drafts">x</button>')).toEqual([]);
  expect(compile('<button data-sn-post="/api/x" data-sn-retry="drafts">x</button>', opts).module).toContain('"retry":"drafts"');
  expect(errors('<button data-sn-post="/api/x" data-sn-retry>x</button>')).toEqual([expect.stringMatching(/^SN401 `data-sn-retry` takes the name of a retry policy/)]);
  expect(errors('<button data-sn-get="/api/x" data-sn-retry="drafts">x</button>')).toEqual([expect.stringMatching(/^SN102 .*GETs use the policy `retry.get` names/)]);
  expect(errors('<button data-sn-retry="drafts">x</button>')).toEqual([expect.stringMatching(/^SN102 `data-sn-retry` needs a method attribute/)]);
});
