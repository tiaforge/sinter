// Dev builds warn when an EventSource stream's origin is served over HTTP/1.1.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import dev, { protocolOf } from '../../src/dev.js';
import type { App } from '../../src/runtime/app.js';
import { mockRequests, mockStream, render } from '../../src/testing/index.js';

const navigation = (protocol: string, name = 'http://localhost/') => ({
  getEntriesByType: (type: string) => (type === 'navigation' ? [{ name, nextHopProtocol: protocol }] : []),
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); warn.mockRestore(); });
const http1 = () => warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('HTTP/1.1'));

/** the dev feature installed on the parts of an app it uses */
function devApp(): App {
  const app = { beforeFlush: [], afterFlush: [], states: [], env: { href: () => 'http://localhost/inbox' } } as unknown as App;
  dev.install(app);
  return app;
}

test('a stream over HTTP/1.1 warns once', () => {
  vi.stubGlobal('performance', navigation('http/1.1'));
  const app = devApp();
  app.streamOpened!('/api/events');
  app.streamOpened!('/api/events');
  expect(http1()).toHaveLength(1);
  expect(String(http1()[0]![0])).toContain('stream `/api/events` is served over HTTP/1.1');
});

test('HTTP/2, HTTP/3 and an unknown protocol do not warn', () => {
  const app = devApp();
  for (const p of ['h2', 'h3', '']) {
    vi.stubGlobal('performance', navigation(p));
    app.streamOpened!('/api/events');
  }
  expect(http1()).toHaveLength(0);
});

test('a stream on another transport (here a mock) is not reported', async () => {
  vi.stubGlobal('performance', navigation('http/1.1'));
  const stream = mockStream();
  const r = await render(`
    <sn-resource name="contacts" src="/api/contacts" key="id"></sn-resource>
    <sn-sync src="/api/events"><sn-event name="refresh" resource="contacts" op="refetch"></sn-event></sn-sync>
    <p data-sn-text="contacts.length"></p>`, { requests: mockRequests({ 'GET /api/contacts': [] }), streams: { '/api/events': stream } });
  await r.settle();
  expect(stream.connected).toBe(true);
  expect(http1()).toHaveLength(0);
});

test('protocolOf reads the navigation for same-origin URLs, else the last request to the origin', () => {
  const perf = {
    getEntriesByType: (type: string) => (type === 'navigation'
      ? [{ name: 'https://app.test/inbox', nextHopProtocol: 'h2' }]
      : [{ name: 'https://api.test/a', nextHopProtocol: 'http/1.1' }, { name: 'https://api.test/b', nextHopProtocol: 'h2' }, { name: 'https://cdn.test/x', nextHopProtocol: '' }]),
  } as unknown as Performance;
  expect(protocolOf('/events', 'https://app.test/inbox', perf)).toBe('h2');
  expect(protocolOf('https://api.test/events', 'https://app.test/', perf)).toBe('h2');
  // no Timing-Allow-Origin: the protocol is hidden
  expect(protocolOf('https://cdn.test/events', 'https://app.test/', perf)).toBeNull();
  expect(protocolOf('https://other.test/events', 'https://app.test/', perf)).toBeNull();
});
