// Coming back to the page: a bfcache restore (`pageshow` with `persisted`) and `online` refetch
// every resource; resources a stream feeds are left to the stream's reconnect.
import { afterEach, expect, test } from 'vitest';
import { configure } from '../../src/index.js';
import { render, mockRequests, mockStream } from '../../src/testing/index.js';

afterEach(() => configure({ sessionProbe: null }));

test('pageshow after a bfcache restore and online refetch the resources; an embedded or `when`-false one is not requested', async () => {
  const requests = mockRequests({ 'GET /api/a': { v: 1 }, 'GET /api/b': { v: 2 } });
  const { root, window, settle } = await render(`
    <div data-sn-state="{ on: false }">
      <sn-resource name="a" src="/api/a"></sn-resource>
      <sn-resource name="b" src="/api/b" when="on"></sn-resource>
      <p data-sn-text="a.v + '' + (b && b.v)"></p>
    </div>`, { requests });
  await settle();
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/a']);
  await window('pageshow');
  await settle();
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/a', '/api/a']);
  await window('online');
  await settle();
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/a', '/api/a', '/api/a']);
  expect(root.querySelector('p')!.textContent).toBe('1null');
});

test('a resource a stream feeds is refetched by the stream module on reconnect, not twice', async () => {
  const requests = mockRequests({ 'GET /api/m': { m: [] }, 'GET /api/user': { ok: true } });
  const stream = mockStream();
  configure({ sessionProbe: '/api/user' });
  const { window, settle } = await render(`
    <sn-resource name="m" src="/api/m" items="m" key="id"></sn-resource>
    <sn-sync src="/events"><sn-event name="m" resource="m" op="upsert"></sn-event></sn-sync>
    <template data-sn-for="x in m"><li></li></template>`, { requests, streams: { '/events': stream } });
  await settle();
  expect(requests.calls.filter((c) => c.url === '/api/m')).toHaveLength(1);
  await window('pagehide');
  await window('pageshow');
  await settle();
  // one refetch (the stream's), not one more from the page
  expect(requests.calls.filter((c) => c.url === '/api/m')).toHaveLength(2);
});
