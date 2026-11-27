// What the early script renders over resources is decided per resource (docs/first-paint.md): an embedded resource's
// data, a fetched one's status before data; a fetched one's data waits for the page module, also on a page with
// embedded data. The page module then renders the same page as before.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const PAGE = `<!doctype html><html><head><script type="application/json" data-sn-resource="a">{"name":"Ada"}</script></head><body>
  <sn-resource name="a" src="/api/a"></sn-resource>
  <sn-resource name="b" src="/api/b"></sn-resource>
  <p id="pa" data-sn-text="a.name"></p>
  <p id="pb" data-sn-text="b.label"></p>
  <p id="mix" data-sn-text="a.name + ' ' + b.label"></p>
  <template data-sn-if="$meta.b.loading"><i id="lb">loading b</i></template>
</body></html>`;
const text = (id: string) => document.getElementById(id)?.textContent ?? null;

// the early request for b: never answered here
beforeEach(() => { vi.stubGlobal('fetch', () => new Promise(() => {})); });
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });

test('first paint: the embedded resource\'s data and the fetched one\'s loading branch, not the fetched one\'s data', async () => {
  await firstPaint(PAGE);
  expect(text('pa')).toBe('Ada');
  expect(document.getElementById('lb')).not.toBeNull();
  expect(text('pb')).toBe('');
  expect(text('mix')).toBe('');
});

test('the page module takes over what the early script painted and renders the rest when b loads', async () => {
  let early: Element | null = null, pa = '';
  const { settle } = await render(PAGE, { requests: mockRequests({ 'GET /api/b': { label: 'Bea' } }), firstPaint: { afterEarly: () => { early = document.getElementById('lb'); pa = text('pa')!; } } });
  expect(pa).toBe('Ada');
  expect(early).not.toBeNull();
  expect(document.getElementById('lb')).toBe(early);
  await settle();
  expect(text('pa')).toBe('Ada');
  expect(text('pb')).toBe('Bea');
  expect(text('mix')).toBe('Ada Bea');
  expect(document.getElementById('lb')).toBeNull();
});
