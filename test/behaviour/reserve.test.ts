// The space a list holds before its data arrives (docs/first-paint.md#reserved-space): the build
// writes a placeholder after the template, and the page module removes it once the resource has rows,
// has loaded (empty too) or has failed. Its size is the build's (test/compiler/reserve.test.ts).
import { expect, test } from 'vitest';
import { memoryStorage, mockRequests, render } from '../../src/testing/index.js';
import { compile } from '../../src/compiler/index.js';

const CSS = 'ul { margin: 0; padding: 0 } li { height: 20px }';
const PAGE = (attrs = '', resource = 'paginate="offset" page-size="3"') => `
  <sn-resource name="people" src="/api/people" items="people" key="id" ${resource}></sn-resource>
  <ul><template data-sn-for="p in people"${attrs}><li data-sn-text="p.name"></li></template></ul>`;
const rows = (n: number) => ({ people: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `P${i + 1}` })) });
const held = (root: ParentNode) => root.querySelector('ul > .sn-reserve');

test('the placeholder stands after the template until the rows arrive, then the rows are the list\'s only children', async () => {
  const requests = mockRequests({ 'GET /api/people?page=1&limit=3': rows(3) });
  const { root, settle } = await render(PAGE(), { requests, css: CSS });
  expect(held(root)).not.toBeNull();
  expect(held(root)!.getAttribute('aria-hidden')).toBe('true');
  expect(held(root)!.previousElementSibling!.localName).toBe('template');
  await settle();
  expect(held(root)).toBeNull();
  expect([...root.querySelectorAll('ul > li')].map((l) => l.textContent)).toEqual(['P1', 'P2', 'P3']);
});

test('an empty list and a failed load remove it too', async () => {
  for (const answer of [rows(0), { status: 500 }]) {
    const { root, settle } = await render(PAGE(), { requests: mockRequests({ 'GET /api/people?page=1&limit=3': answer }), css: CSS });
    expect(held(root)).not.toBeNull();
    await settle();
    expect(held(root)).toBeNull();
  }
});

test('a list whose `src` cannot be built loads nothing: removed at mount', async () => {
  const { root } = await render(PAGE('', 'paginate="offset" page-size="3"').replace('src="/api/people"', 'src="/api/people/{boom()}"'), { requests: mockRequests({}), css: CSS, helpers: { boom: () => { throw new Error('no'); } } });
  expect(held(root)).toBeNull();
});

test('cached rows replace it when the page module mounts', async () => {
  // the previous page loaded them
  const session = memoryStorage(), page = PAGE('', 'paginate="offset" page-size="3" cache');
  await (await render(page, { requests: mockRequests({ 'GET /api/people?page=1&limit=3': rows(2) }), css: CSS, session })).settle();
  const { root } = await render(PAGE('', 'paginate="offset" page-size="3" cache'), { requests: mockRequests({ 'GET /api/people?page=1&limit=3': rows(2) }), css: CSS, session });
  expect(held(root)).toBeNull();
  expect(root.querySelectorAll('ul > li').length).toBe(2);
});

test('not for a list without pages: the build cannot count its rows', async () => {
  const { root } = await render(PAGE('', ''), { requests: mockRequests({ 'GET /api/people': rows(4) }), css: CSS });
  expect(held(root)).toBeNull();
});

test('not for a resource that may not load, one the page embeds, nor a list that is not the resource itself', async () => {
  for (const page of [
    PAGE('', 'paginate="offset" page-size="3" when="$url.go"'),
    PAGE().replace('p in people', 'p in people.filter((x) => x.id > 1)'),
    `<script type="application/json" data-sn-data="people">{"people":[]}</script>${PAGE()}`,
  ]) {
    const { root } = await render(page, { requests: mockRequests({ 'GET /api/people?page=1&limit=3': rows(1) }), css: CSS });
    expect(held(root)).toBeNull();
  }
});

test('the build: the placeholder\'s rule in the page\'s first-paint stylesheet, imported by the page module', () => {
  const out = compile(`<!doctype html><html><head></head><body>${PAGE()}</body></html>`, {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} },
    prerender: true, styles: [{ file: 'a.css', css: CSS }], paintCss: '/@sinter/paint-css/index.html.css',
  });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.html).toMatch(/<\/template><li class="sn-reserve snr[a-z0-9]+0" aria-hidden="true" data-sn="\d+"><\/li><\/ul>/);
  // one base rule per page, then each list's own height
  expect(out.paint).toMatch(/^\.sn-reserve:not\(#_\) \{ display:block !important;[^}]*\}\n\.sn-reserve\.snr[a-z0-9]+0:not\(#_\) \{ height:60px !important \}\n$/);
  expect(out.module).toContain('import "/@sinter/paint-css/index.html.css";');
  // no rules: nothing imported
  const none = compile('<!doctype html><html><head></head><body><p>x</p></body></html>', { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css: CSS }], paintCss: '/p.css' });
  expect(none.paint).toBe('');
  expect(none.module).not.toContain('/p.css');
});

test('SN520: a list over late data in a flex item whose width follows its content', async () => {
  const css = '.row { display: flex; flex-wrap: wrap }';
  const page = (resource = '') => `<sn-resource name="people" src="/api/people" items="people" key="id" ${resource}></sn-resource>
    <div class="row"><div class="feed"><template data-sn-for="p in people"><p class="card" data-sn-text="p.name"></p></template></div><aside>tags</aside></div>`;
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, styles: [{ file: 'a.css', css }], paintCss: '/p.css' };
  const warned = compile(page(), opts).diagnostics.filter((d) => d.code === 'SN520');
  expect(warned).toHaveLength(1);
  expect(warned[0]!.message).toContain('`<div.feed>`');
  // with a basis of its own, nothing to say
  expect(compile(page(), { ...opts, styles: [{ file: 'a.css', css: css + ' .feed { flex: 1 1 0 }' }] }).diagnostics.filter((d) => d.code === 'SN520')).toEqual([]);
  // rows of a width of their own, paginated: a placeholder as wide holds the box's width, nothing to say either
  const fixed = compile(page('paginate="offset" page-size="4"'), { ...opts, styles: [{ file: 'a.css', css: css + ' .card { width: 280px; height: 40px; margin: 0 }' }] });
  expect(fixed.diagnostics.filter((d) => d.code === 'SN520')).toEqual([]);
  expect(fixed.paint).toContain('width:280px');
  expect(fixed.paint).toContain('height:160px');
});
