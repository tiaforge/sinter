// Speculation Rules: the rules the build writes, and a page the browser prerenders (streams wait
// until it is shown, then everything is refetched).
import { afterEach, expect, test } from 'vitest';
import { speculationRules } from '../../src/prefetch-build.js';
import { mockRequests, mockStream, render } from '../../src/testing/index.js';

const doc = document as Document & { prerendering?: boolean };
afterEach(() => { delete (doc as { prerendering?: boolean }).prerendering; });

test('rules: the app\'s paths as URL patterns with any query and fragment; downloads and other targets left out', () => {
  const rules = JSON.parse(speculationRules('prefetch', ['/article/:slug', '/login.html', '/a*b', '/article/:slug'])!);
  const rule = rules.prefetch[0];
  expect(rule.eagerness).toBe('moderate');
  expect(rule.where.and[0].href_matches).toEqual(['/article/:slug\\?*#*', '/login.html\\?*#*', '/a\\*b\\?*#*']);
  expect(rule.where.and[1].not.selector_matches).toContain('[download]');
  expect(Object.keys(JSON.parse(speculationRules('prerender', ['/'])!))).toEqual(['prerender']);
  expect(speculationRules('prefetch', [])).toBeNull();
});

test('a prerendered page loads, connects its streams once shown, and refetches then', async () => {
  Object.defineProperty(doc, 'prerendering', { value: true, configurable: true, writable: true });
  const stream = mockStream();
  let n = 0;
  const requests = mockRequests({ 'GET /api/inbox': () => ({ items: [{ id: 1, n: ++n }] }) });
  const r = await render(`
    <sn-resource name="inbox" src="/api/inbox" items="items" key="id"></sn-resource>
    <sn-sync src="/api/events"><sn-event name="mail" resource="inbox" op="upsert" item="m"></sn-event></sn-sync>
    <template data-sn-for="m in inbox"><p data-sn-text="m.n"></p></template>`, { requests, streams: { '/api/events': stream } });
  await r.settle();
  expect(r.root.querySelector('p')!.textContent).toBe('1');
  expect(stream.connected).toBe(false);

  doc.prerendering = false;
  doc.dispatchEvent(new Event('prerenderingchange'));
  await r.settle();
  expect(stream.connected).toBe(true);
  expect(r.root.querySelector('p')!.textContent).toBe('2');
  expect(requests.calls).toHaveLength(2);
});

test('a page that is not prerendered connects at once and loads once', async () => {
  const stream = mockStream();
  const requests = mockRequests({ 'GET /api/inbox': { items: [] } });
  const r = await render(`
    <sn-resource name="inbox" src="/api/inbox" items="items" key="id"></sn-resource>
    <sn-sync src="/api/events"><sn-event name="mail" resource="inbox" op="upsert" item="m"></sn-event></sn-sync>
    <i data-sn-text="inbox.length"></i>`, { requests, streams: { '/api/events': stream } });
  await r.settle();
  expect(stream.connected).toBe(true);
  expect(requests.calls).toHaveLength(1);
});
