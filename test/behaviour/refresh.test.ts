// `refresh` on <sn-resource>: background reloads once the last load is that old, and reloads
// that the response's version (ETag, Last-Modified) shows to be unchanged.
import { afterEach, expect, test } from 'vitest';
import { configure } from '../../src/index.js';
import { compile } from '../../src/compiler/index.js';
import { mockRequests, mockStream, render, type RecordedCall, type RouteResponse } from '../../src/testing/index.js';

afterEach(() => configure({ request: [], onError: null }));

const PAGE = (attrs = 'refresh="10s"', extra = '') => `
  <main data-sn-state="{ loads: 0, on: true, seen: '' }">
    <sn-resource name="jobs" src="/api/jobs" key="id" order="id" ${attrs} then="loads = loads + 1; seen = $result.map((j) => j.state).join()"></sn-resource>
    <s data-sn-text="seen"></s>
    <p data-sn-text="$meta.jobs.loading ? 'loading' : 'idle'"></p>
    <b data-sn-text="loads"></b>
    <i data-sn-text="$meta.jobs.error ? 'error' : ''"></i>
    <ul><template data-sn-for="j in jobs"><li data-sn-text="j.state"></li></template></ul>
    ${extra}
  </main>`;

const states = (root: HTMLElement) => [...root.querySelectorAll('li')].map((l) => l.textContent);
const text = (root: HTMLElement, sel: string) => root.querySelector(sel)!.textContent;
const gets = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'GET' && c.path === '/api/jobs').length;

/** a server whose job list the test changes; each response carries `etag` when given */
function server(etag?: () => string | null) {
  const state = { jobs: [{ id: 1, state: 'queued' }] as Array<{ id: number; state: string }> };
  const route: RouteResponse = () => {
    const tag = etag?.();
    return { status: 200, body: state.jobs, headers: tag ? { ETag: tag } : {} };
  };
  return { state, route };
}

test('reloads in the background once the last load is `refresh` old', async () => {
  const s = server();
  const requests = mockRequests({ 'GET /api/jobs': s.route });
  const r = await render(PAGE(), { requests });
  await r.settle();
  expect(states(r.root)).toEqual(['queued']);
  expect(gets(requests.calls)).toBe(1);

  s.state.jobs = [{ id: 1, state: 'running' }];
  await r.advance(9_999);
  expect(gets(requests.calls)).toBe(1);
  await r.advance(1);
  expect(gets(requests.calls)).toBe(1 + requests.pending);
  // a background load: `loading` stays false while it runs
  expect(text(r.root, 'p')).toBe('idle');
  await r.settle();
  expect(states(r.root)).toEqual(['running']);
  expect(text(r.root, 'b')).toBe('2');
  expect(r.app.page.$meta.jobs.loadedAt).toBe(Date.parse('2026-01-01T09:00:10Z'));

  // and again, counted from that load
  await r.advance(10_000);
  await r.settle();
  expect(gets(requests.calls)).toBe(3);
});

test('any load starts the clock again: a stream that keeps the resource current leaves nothing to refresh', async () => {
  const s = server();
  const stream = mockStream();
  const requests = mockRequests({ 'GET /api/jobs': s.route });
  const html = PAGE('refresh="10s"', `<sn-sync src="/api/events"><sn-event name="jobs_changed" resource="jobs" op="refetch"></sn-event></sn-sync>`);
  const r = await render(html, { requests, streams: { '/api/events': stream } });
  await r.settle();
  await r.advance(8_000);
  stream.emit('jobs_changed', {});
  await r.settle();
  expect(gets(requests.calls)).toBe(2);
  // 10 s after the first load: the event's refetch was 2 s ago
  await r.advance(2_000);
  expect(requests.pending).toBe(0);
  await r.advance(8_000);
  await r.settle();
  expect(gets(requests.calls)).toBe(3);
});

test('`refresh()` and other loads that show `loading` still show it', async () => {
  const s = server();
  const requests = mockRequests({ 'GET /api/jobs': s.route });
  const r = await render(PAGE('refresh="10s"', `<button data-sn-on-click="refresh('jobs')">reload</button>`), { requests });
  await r.settle();
  r.root.querySelector('button')!.click();
  await r.flush();
  expect(text(r.root, 'p')).toBe('loading');
  await r.settle();
  expect(text(r.root, 'p')).toBe('idle');
});

test('paused while the page is hidden; a refresh that fell due runs when it is shown again', async () => {
  const s = server();
  const requests = mockRequests({ 'GET /api/jobs': s.route });
  const r = await render(PAGE(), { requests });
  await r.settle();
  await r.visibility('hidden');
  await r.advance(60_000);
  expect(requests.pending).toBe(0);
  expect(gets(requests.calls)).toBe(1);
  await r.visibility('visible');
  await r.settle();
  expect(gets(requests.calls)).toBe(2);
});

test('shown again before a refresh fell due: nothing is requested early', async () => {
  const requests = mockRequests({ 'GET /api/jobs': server().route });
  const r = await render(PAGE(), { requests });
  await r.settle();
  await r.visibility('hidden');
  await r.advance(5_000);
  await r.visibility('visible');
  expect(requests.pending).toBe(0);
  await r.advance(5_000);
  await r.settle();
  expect(gets(requests.calls)).toBe(2);
});

test('nothing is refreshed while `when` is falsy; the next load starts the clock again', async () => {
  const requests = mockRequests({ 'GET /api/jobs': server().route });
  const html = PAGE('refresh="10s" when="on"', `<button data-sn-on-click="on = !on">toggle</button>`);
  const r = await render(html, { requests });
  await r.settle();
  r.root.querySelector('button')!.click();
  await r.settle();
  await r.advance(60_000);
  expect(gets(requests.calls)).toBe(1);
  r.root.querySelector('button')!.click();
  await r.settle();
  expect(gets(requests.calls)).toBe(2);
  await r.advance(10_000);
  await r.settle();
  expect(gets(requests.calls)).toBe(3);
});

test('a response with the version of the data shown is not stored again or re-rendered; `then` runs as for any load', async () => {
  let tag = '"v1"';
  const s = server(() => tag);
  const requests = mockRequests({ 'GET /api/jobs': s.route });
  const r = await render(PAGE(), { requests });
  await r.settle();
  const li = r.root.querySelector('li');
  expect(text(r.root, 'b')).toBe('1');

  // same version (the browser's cache answered a revalidation with 304): nothing changes
  s.state.jobs = [{ id: 1, state: 'not what the server says for v1' }];
  await r.advance(10_000);
  await r.settle();
  expect(gets(requests.calls)).toBe(2);
  expect(states(r.root)).toEqual(['queued']);
  expect(r.root.querySelector('li')).toBe(li);
  // `then` behaves as on a page without the check: it runs, with what the stored load gave it
  expect(text(r.root, 'b')).toBe('2');
  expect(text(r.root, 's')).toBe('queued');
  // still counts as a load: loadedAt moves, and the clock starts again from it
  expect(r.app.page.$meta.jobs.loadedAt).toBe(Date.parse('2026-01-01T09:00:10Z'));

  tag = '"v2"';
  s.state.jobs = [{ id: 1, state: 'done' }];
  await r.advance(10_000);
  await r.settle();
  expect(states(r.root)).toEqual(['done']);
  expect(text(r.root, 'b')).toBe('3');
  expect(text(r.root, 's')).toBe('done');
});

test('`Last-Modified` serves as the version without an `ETag`', async () => {
  const state = { jobs: [{ id: 1, state: 'queued' }] };
  const requests = mockRequests({ 'GET /api/jobs': () => ({ status: 200, body: state.jobs, headers: { 'Last-Modified': 'Thu, 01 Jan 2026 08:00:00 GMT' } }) });
  const r = await render(PAGE(), { requests });
  await r.settle();
  state.jobs = [{ id: 1, state: 'not stored' }];
  await r.advance(10_000);
  await r.settle();
  expect(states(r.root)).toEqual(['queued']);
});

test('a change to the data since (a server event) makes the next response count, whatever its version', async () => {
  const s = server(() => '"v1"');
  const stream = mockStream();
  const requests = mockRequests({ 'GET /api/jobs': s.route });
  const html = PAGE('refresh="10s"', `<sn-sync src="/api/events">
      <sn-event name="job" resource="jobs" op="upsert"></sn-event>
      <sn-event name="jobs_changed" resource="jobs" op="refetch"></sn-event>
    </sn-sync>`);
  const r = await render(html, { requests, streams: { '/api/events': stream } });
  await r.settle();
  stream.emit('job', { id: 2, state: 'pushed' });
  await r.flush();
  expect(states(r.root)).toEqual(['queued', 'pushed']);
  // the server's list does not have it: the store takes the response, though its version is the same
  stream.emit('jobs_changed', {});
  await r.settle();
  expect(states(r.root)).toEqual(['queued']);
});

test('on a page with a stream, the version check applies to every reload, not only refreshes', async () => {
  const s = server(() => '"v1"');
  const requests = mockRequests({ 'GET /api/jobs': s.route });
  const html = PAGE('', `<button data-sn-on-click="refresh('jobs')">reload</button>
    <sn-sync src="/api/events"><sn-event name="jobs_changed" resource="jobs" op="refetch"></sn-event></sn-sync>`);
  const r = await render(html, { requests, streams: { '/api/events': mockStream() } });
  await r.settle();
  s.state.jobs = [{ id: 1, state: 'not stored' }];
  r.root.querySelector('button')!.click();
  await r.settle();
  expect(gets(requests.calls)).toBe(2);
  expect(states(r.root)).toEqual(['queued']);
  expect(text(r.root, 'b')).toBe('2');
});

test('a page with neither `refresh` nor a stream has no version check: every reload is stored', async () => {
  const s = server(() => '"v1"');
  const requests = mockRequests({ 'GET /api/jobs': s.route });
  const r = await render(PAGE('', `<button data-sn-on-click="refresh('jobs')">reload</button>`), { requests });
  await r.settle();
  s.state.jobs = [{ id: 1, state: 'stored' }];
  r.root.querySelector('button')!.click();
  await r.settle();
  expect(states(r.root)).toEqual(['stored']);
  expect(text(r.root, 'b')).toBe('2');
});

test('a 304 that reaches the page (middleware sent the condition) keeps the data', async () => {
  let n = 0;
  const state = { jobs: [{ id: 1, state: 'queued' }] };
  const requests = mockRequests({ 'GET /api/jobs': () => (n++ ? { status: 304, headers: { ETag: '"v1"' } } : { status: 200, body: state.jobs, headers: { ETag: '"v1"' } }) });
  const r = await render(PAGE(), { requests });
  await r.settle();
  await r.advance(10_000);
  await r.settle();
  expect(states(r.root)).toEqual(['queued']);
  expect(text(r.root, 'i')).toBe('');
  expect(text(r.root, 's')).toBe('queued');
});

test('failures retry later with a growing wait, and are reported once until a load succeeds', async () => {
  const reported: string[] = [];
  configure({ onError: (e) => reported.push(e.message) });
  let fail = false;
  const state = { jobs: [{ id: 1, state: 'queued' }] };
  const requests = mockRequests({ 'GET /api/jobs': () => (fail ? { status: 503 } : state.jobs) });
  const r = await render(PAGE('refresh="5s"'), { requests });
  await r.settle();
  fail = true;
  const at = (ms: number) => r.advance(ms).then(() => r.settle());
  await at(5_000);              // fails (1st): the next try in 10 s
  expect(text(r.root, 'i')).toBe('error');
  expect(states(r.root)).toEqual(['queued']);
  await at(9_999);
  expect(gets(requests.calls)).toBe(2);
  await at(1);                  // fails (2nd): the next try in 20 s
  await at(20_000);             // fails (3rd): capped at 30 s
  await at(30_000);             // fails (4th)
  expect(gets(requests.calls)).toBe(5);
  expect(reported).toHaveLength(1);
  fail = false;
  await at(30_000);
  expect(text(r.root, 'i')).toBe('');
  expect(gets(requests.calls)).toBe(6);
  // back to the interval, and the next failure is reported again
  fail = true;
  await at(5_000);
  expect(reported).toHaveLength(2);
});

test('an `each` resource refreshes every source', async () => {
  const requests = mockRequests({
    'GET /api/accounts': [{ id: 'a' }, { id: 'b' }],
    'GET /api/boxes': (c: RecordedCall) => [{ account: new URLSearchParams(c.url.split('?')[1]).get('account'), name: 'inbox' }],
  });
  const html = `
    <sn-resource name="accounts" src="/api/accounts" key="id"></sn-resource>
    <sn-resource name="boxes" each="a in accounts" src="/api/boxes?account={a.id}" key="account,name" refresh="1m"></sn-resource>
    <p data-sn-text="$meta.boxes.loading ? 'loading' : 'idle'"></p>
    <ul><template data-sn-for="b in boxes"><li data-sn-text="b.account"></li></template></ul>`;
  const r = await render(html, { requests });
  await r.settle();
  expect(states(r.root)).toEqual(['a', 'b']);
  await r.advance(60_000);
  expect(text(r.root, 'p')).toBe('idle');
  await r.settle();
  expect(requests.calls.filter((c) => c.path === '/api/boxes')).toHaveLength(4);
});

test('the compiler checks the value and adds the feature only where it is used', () => {
  const opts = { file: '/x/i.html', root: '/x', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '' };
  const page = (v: string | null) => `<sn-resource name="jobs" src="/api/jobs"${v == null ? '' : ` refresh="${v}"`}></sn-resource><p data-sn-text="jobs"></p>`;
  const ok = compile(page('5m'), opts);
  expect(ok.diagnostics).toEqual([]);
  expect(ok.module).toContain("import sn$refresh from '@tiaforge-ui/sinter/refresh'");
  expect(ok.module).toContain('"refresh":300000');
  expect(ok.module).toContain("import sn$versions from '@tiaforge-ui/sinter/versions'");
  const plain = compile(page(null), opts).module;
  expect(plain).not.toContain('sinter/refresh');
  expect(plain).not.toContain('sinter/versions');
  // a stream reloads resources too (refetch events, reconnects): its pages get the version check
  const streamed = compile(`${page(null)}<sn-sync src="/api/events"><sn-event name="x" resource="jobs" op="refetch"></sn-event></sn-sync>`, opts).module;
  expect(streamed).toContain("import sn$versions from '@tiaforge-ui/sinter/versions'");
  expect(streamed).not.toContain('sinter/refresh');
  const errors = (v: string) => compile(page(v), opts).diagnostics.map((d) => `${d.code} ${d.message}`);
  expect(errors('0s')).toEqual(['SN401 `refresh` must be at least `1s`']);
  for (const v of ['500ms', '', 'soon', '1d']) expect(errors(v)).toEqual([expect.stringMatching(/^SN401 `refresh` takes/)]);
});
