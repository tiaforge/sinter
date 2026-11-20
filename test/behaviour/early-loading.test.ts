// A resource's state when the page module mounts is known before the first paint (docs/first-paint.md):
// no data yet, and loading if its `when` holds. So a "Loading…" branch over `$meta.<name>.loading` is
// in the first frame, and the page module adopts it instead of adding it after the paint.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const PAGE = (res = '', cond = '$meta.c.loading && !c.length') => `<!doctype html><html><head></head><body>
  <sn-resource name="c" src="/api/c" select="c" key="id" ${res}></sn-resource>
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

test('with `cache`: only in a tab that has not cached this resource (its rows would be there at mount)', async () => {
  await firstPaint(PAGE('cache'));
  expect(loading()).not.toBeNull();
  // another resource's entry: not this one's rows
  sessionStorage.setItem('sn:c:["/api/other","c",null]', JSON.stringify({ t: 0, items: [{ id: 1 }], total: null }));
  await firstPaint(PAGE('cache'));
  expect(loading()).not.toBeNull();
  sessionStorage.setItem('sn:c:["http://localhost/api/c","c",null]', JSON.stringify({ t: 0, items: [{ id: 1 }], total: null }));
  await firstPaint(PAGE('cache'));
  expect(loading()).toBeNull();
});

test('with `cache`: an entry without data is what the early file writes in, so the branch stays early', async () => {
  // a list cached empty
  sessionStorage.setItem('sn:c:["http://localhost/api/c","c",null]', JSON.stringify({ t: 0, items: [], total: null }));
  await firstPaint(PAGE('cache'));
  expect(loading()).not.toBeNull();
  // an object cached as null (RealWorld's signed-out `{user: null}`): the signed-out branch is in the first paint
  // with an embedded resource beside it, as RealWorld's article page served by sinter-axum
  const page = `<!doctype html><html><head><script type="application/json" data-sn-resource="a">{"a":{"title":"T"}}</script></head><body>
  <sn-resource name="a" src="/api/a" select="a"></sn-resource>
  <sn-resource cache name="user" src="/api/user" select="user"></sn-resource>
  <template data-sn-if="user"><p id="in">Signed in</p></template><template data-sn-else><p id="out">Sign in</p></template>
</body></html>`;
  sessionStorage.setItem('sn:c:["http://localhost/api/user","user",null]', JSON.stringify({ t: 0, items: null, total: null }));
  await firstPaint(page);
  expect(document.getElementById('out')).not.toBeNull();
  sessionStorage.clear();
  await firstPaint(page);
  expect(document.getElementById('out')).not.toBeNull();
  // a signed-in user cached: left to the page module, which shows it at mount
  sessionStorage.setItem('sn:c:["http://localhost/api/user","user",null]', JSON.stringify({ t: 0, items: { username: 'ada' }, total: null }));
  await firstPaint(page);
  expect(document.getElementById('out')).toBeNull();
  expect(document.getElementById('in')).toBeNull();
});

test('a `when` over state, or a status field the early file does not know: left to the page module', async () => {
  await firstPaint(PAGE('when="open"').replace('<body>', '<body data-sn-state="{ open: true }">'));
  expect(loading()).toBeNull();
  await firstPaint(PAGE('paginate="{ numbered: true, size: 2 }"', '$meta.c.loading && !$meta.c.total'));
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
  const helpers = { idle: (m: { total: unknown; live: unknown; loading: boolean }) => m.loading && !('pending' in m) && m.total === null && m.live === null };
  await firstPaint(PAGE('', 'idle($meta.c)'), { helpers });
  expect(loading()).not.toBeNull();
  // paginated: its pager fields are not known early, and a binding that reads one is the page module's
  await firstPaint(PAGE('paginate="{ numbered: true, size: 2 }"', 'idle($meta.c)'), { helpers });
  expect(loading()).toBeNull();
  // one that reads only what is known renders early
  await firstPaint(PAGE('paginate="{ numbered: true, size: 2 }"', '((m) => m.loading)($meta.c) && !c.length'.replace('((m) => m.loading)($meta.c)', 'first($meta.c)')), { helpers: { ...helpers, first: (m: { loading: boolean }) => m.loading } });
  expect(loading()).not.toBeNull();
});

test('with next-page data in the app, the early binding first checks this tab holds no prefetched or cached rows; the when is the early table\'s', async () => {
  const { compile } = await import('../../src/compiler/index.js');
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null }, observe: true };
  const html = PAGE('when="$url.go"');
  const plain = compile(html, opts).early!, ahead = compile(html, { ...opts, prefetch: '/prefetch.js' }).early!;
  // without `cache`: the page-load cache's entries count only on Back or Forward, which restores them (cache.ts)
  expect(plain).toContain("type == 'back_forward' || sessionStorage.getItem('sn:back') == location.href ? /^sn:[cp]:\\[/ : /^sn:p:\\[/");
  expect(ahead).toContain('/^sn:p:\\[/');
  // `when` is called from the table, not written out again
  expect(ahead).toMatch(/!!f\[\d+\]\(\$\)/);
});

test('embedded rows chosen by the URL between an embedded resource and one that is not: in the first paint (as before)', async () => {
  const page = `<!doctype html><html><head><script type="application/json" data-sn-resource="all">{"c":[{"id":1,"name":"Ada"},{"id":2,"name":"Grace"}]}</script></head><body>
    <sn-resource name="user" src="/api/user"></sn-resource>
    <sn-resource name="mine" src="/api/mine" select="c" key="id" when="user"></sn-resource>
    <sn-resource name="all" src="/api/all" select="c" key="id"></sn-resource>
    <ul data-sn-let="{ list: $url.feed == 'following' ? mine : all }"><template data-sn-for="x in list"><li data-sn-text="x.name"></li></template></ul>
  </body></html>`;
  await firstPaint(page);
  expect([...document.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['Ada', 'Grace']);
});

test('a branch the status closes at mount (no data yet, loading or not) is not in the early file: the HTML shows it closed already', async () => {
  const { compile } = await import('../../src/compiler/index.js');
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null }, observe: true };
  const page = (cond: string) => `<!doctype html><html><head></head><body><sn-resource name="user" src="/api/user" cache></sn-resource>
    <template data-sn-if="${cond}"><p id="b">x</p></template></body></html>`;
  // closed at mount whatever the load does: nothing early
  for (const cond of ['user', 'user && user.name', '$meta.user.error']) expect(compile(page(cond), opts).early ?? '', cond).not.toContain('sessionStorage');
  // open while loading: early
  expect(compile(page('!user && $meta.user.loading'), opts).early).toContain('sessionStorage');
  await firstPaint(page('user'));
  expect(document.getElementById('b')).toBeNull();
});
