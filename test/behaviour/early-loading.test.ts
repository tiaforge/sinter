// A resource's state when the page module mounts is known before the first paint (docs/first-paint.md):
// no data yet, and loading if its `when` holds. So a "Loading…" branch over `$meta.<name>.loading` is
// in the first frame, and the page module adopts it instead of adding it after the paint.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const PAGE = (res = '', cond = '$meta.c.loading && !c.length') => `<!doctype html><html><head></head><body>
  <sn-resource name="c" src="/api/c" items="c" key="id" ${res}></sn-resource>
  <template data-sn-if="${cond}"><p id="loading">Loading…</p></template>
  <template data-sn-if="$meta.c.error"><p id="failed">Could not load.</p></template>
  <ul><template data-sn-for="x in c"><li data-sn-text="x.name"></li></template></ul>
</body></html>`;
const loading = () => document.getElementById('loading');

// the early requests: never answered here
beforeEach(() => { vi.stubGlobal('fetch', () => new Promise(() => {})); });
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });

test('a loading branch is in the first paint, and the page module adopts it', async () => {
  await firstPaint(PAGE());
  expect(loading()).not.toBeNull();
  expect(document.getElementById('failed')).toBeNull();
  let early: Element | null = null;
  const { settle } = await render(PAGE(), { requests: mockRequests({ 'GET /api/c': { c: [{ id: 1, name: 'Ada' }] } }), firstPaint: { afterEarly: () => { early = loading(); } } });
  expect(early).not.toBeNull();
  // the same element, now the page module's
  expect(loading()).toBe(early);
  await settle();
  expect(loading()).toBeNull();
  expect(document.querySelector('li')!.textContent).toBe('Ada');
});

test('a `when` the early file can evaluate: not loading while it is false', async () => {
  await firstPaint(PAGE('when="$url.go"'));
  expect(loading()).toBeNull();
});

test('with `cache`: only in a tab that has cached nothing (cached rows would be there at mount)', async () => {
  await firstPaint(PAGE('cache'));
  expect(loading()).not.toBeNull();
  sessionStorage.setItem('sn:c:["/api/other","c",null]', JSON.stringify({ t: 0, v: [] }));
  await firstPaint(PAGE('cache'));
  expect(loading()).toBeNull();
});

test('a `when` over state, or a status field the early file does not know: left to the page module', async () => {
  await firstPaint(PAGE('when="open"').replace('<body>', '<body data-sn-state="{ open: true }">'));
  expect(loading()).toBeNull();
  await firstPaint(PAGE('paginate="offset" page-size="2"', '$meta.c.loading && !$meta.c.total'));
  expect(loading()).toBeNull();
});

test('between two resources, as RealWorld\'s feed: the one the URL picks', async () => {
  const page = PAGE().replace('<sn-resource', '<sn-resource name="f" src="/api/f" key="id" when="user"></sn-resource><sn-resource name="user" src="/api/user"></sn-resource><sn-resource')
    .replace('$meta.c.loading && !c.length', '($url.feed ? $meta.f : $meta.c).loading && !($url.feed ? f : c).length');
  await firstPaint(page);
  expect(loading()).not.toBeNull();
});

test('the early function: the status written in field by field, text in strings left alone', async () => {
  await firstPaint(PAGE('', "$meta.c.loading && 'reads $.$r.c and $.$meta.c.loading here'").replace('<p id="loading">Loading…</p>', '<p id="loading" data-sn-text="$meta.c.loading ? \'reads $.$r.c here\' : \'\'"></p>'));
  expect(loading()!.textContent).toBe('reads $.$r.c here');
});

test('the whole status, as a helper reads it: every field as at mount', async () => {
  const helpers = { idle: (m: { pending: number; total: unknown; live: unknown; loading: boolean }) => m.loading && m.pending === 0 && m.total === null && m.live === null };
  await firstPaint(PAGE('', 'idle($meta.c)'), { helpers });
  expect(loading()).not.toBeNull();
  // paginated: its pager fields are not known early
  await firstPaint(PAGE('paginate="offset" page-size="2"', 'idle($meta.c)'), { helpers });
  expect(loading()).toBeNull();
});

test('with next-page data in the app, the early binding first checks this tab holds no prefetched or cached rows; the when is the early table\'s', async () => {
  const { compile } = await import('../../src/compiler/index.js');
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null }, observe: true };
  const html = PAGE('when="$url.go"');
  const plain = compile(html, opts).early!, ahead = compile(html, { ...opts, prefetch: '/prefetch.js' }).early!;
  expect(plain).not.toContain('sessionStorage');
  expect(ahead).toContain('/^sn:[cp]:/');
  // `when` is called from the table, not written out again
  expect(ahead).toMatch(/!!f\[\d+\]\(\$\)/);
});
