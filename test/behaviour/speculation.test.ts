// Speculation Rules: the rules the build writes, and a page the browser prerenders (streams wait
// until it is shown, then everything is refetched).
import { afterEach, expect, test, vi } from 'vitest';
import { speculationRules, withRulesHash } from '../../src/prefetch-build.js';
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

test('a CSP in the page gets the inline rules\' hash, where it needs it and nowhere else', () => {
  const page = (csp: string) => `<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`;
  const csp = (csp: string) => /content="([^"]*)"/.exec(withRulesHash(page(csp), 'sha256-abc'))![1];
  expect(csp("script-src 'self'")).toBe("script-src 'self' 'sha256-abc'");
  expect(csp("default-src 'self'; script-src-elem 'self'; script-src 'self'")).toBe("default-src 'self'; script-src-elem 'self' 'sha256-abc'; script-src 'self' 'sha256-abc'");
  // no script directive: scripts follow default-src, so a script-src copied from it
  expect(csp("default-src 'self' https://cdn.example; img-src *")).toBe("default-src 'self' https://cdn.example; img-src *; script-src 'self' https://cdn.example 'sha256-abc'");
  expect(csp("script-src 'none'")).toBe("script-src 'sha256-abc'");
  // already allowed: unchanged (a hash would turn 'unsafe-inline' off for other inline scripts)
  expect(csp("script-src 'self' 'unsafe-inline'")).toBe("script-src 'self' 'unsafe-inline'");
  expect(csp("script-src 'self' 'inline-speculation-rules'")).toBe("script-src 'self' 'inline-speculation-rules'");
  // with a nonce, 'unsafe-inline' is ignored by browsers: the hash is needed
  expect(csp("script-src 'nonce-x' 'unsafe-inline'")).toBe("script-src 'nonce-x' 'unsafe-inline' 'sha256-abc'");
  // no script restriction at all, and no CSP: nothing to do
  expect(csp('img-src *')).toBe('img-src *');
  expect(withRulesHash('<html><head><meta name="x" content="y"></head></html>', 'sha256-abc')).toBe('<html><head><meta name="x" content="y"></head></html>');
});

test('dev builds warn when the CSP blocked the inline rules (a report from before mount)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let deliver: ((r: unknown[]) => void) | null = null;
  vi.stubGlobal('ReportingObserver', class {
    constructor(cb: (r: unknown[]) => void, o: { buffered?: boolean }) { if (o.buffered) deliver = cb; }
    observe() { deliver?.([{ type: 'csp-violation', body: { blockedURL: 'inline', effectiveDirective: 'script-src-elem' } }]); }
    disconnect() {}
  });
  try {
    await render(`<html><head><script type="speculationrules">{}</script></head><body><p data-sn-text="1"></p></body></html>`);
    const msgs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('Speculation Rules'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("'inline-speculation-rules'");
  } finally {
    vi.unstubAllGlobals();
    warn.mockRestore();
  }
});
