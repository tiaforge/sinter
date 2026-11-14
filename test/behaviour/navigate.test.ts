// navigate(url, { replace }): a store function for handlers, `then` and `catch`. To this page with only
// parameters it reads changed, it is a same-page link (no load, `$url` read again); anywhere else the
// browser navigates (a new entry, or `replace: true` in the current one).
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { mockRequests, render } from '../../src/testing/index.js';

const ITEMS = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
const PAGE = `
  <sn-resource name="a" src="/api/a" items="items" total="total" key="id" paginate="offset" page-size="2" page-model="$url.page"></sn-resource>
  <span data-sn-text="[$meta.a.page, a.map((x) => x.id)].join(' ')"></span>
  <button id="p2" data-sn-on-click="navigate('?page=2')"></button>
  <button id="p3r" data-sn-on-click="navigate('?page=3', { replace: true })"></button>
  <button id="away" data-sn-on-click="navigate('/login')"></button>
  <button id="awayr" data-sn-on-click="navigate('/login', { replace: true })"></button>
  <button id="other" data-sn-on-click="navigate('?lang=de')"></button>
  <form data-sn-post="/api/save" data-sn-then="navigate('/saved/' + $result.id)"><button id="save">save</button></form>`;
const requests = () => mockRequests({
  'GET /api/a': (call) => { const p = Number(new URL(call.url, 'http://x').searchParams.get('page') ?? 1); return { items: ITEMS.slice((p - 1) * 2, p * 2), total: ITEMS.length }; },
  'POST /api/save': { id: 7 },
});
async function setup() {
  const r = await render(PAGE, { requests: requests(), url: 'http://localhost/' });
  await r.settle();
  const click = async (id: string) => { (r.root.querySelector(`#${id}`) as HTMLElement).click(); await r.settle(); };
  return { ...r, click, shown: () => r.root.querySelector('span')!.textContent };
}

test('to this page with only parameters it reads changed: in the page, a new entry, and the list follows', async () => {
  const p = await setup();
  expect(p.shown()).toBe('1 1,2');
  await p.click('p2');
  expect(p.navigations).toEqual([]);
  expect(p.url()).toBe('http://localhost/?page=2');
  expect(p.history()).toEqual(['http://localhost/', 'http://localhost/?page=2']);
  expect(p.shown()).toBe('2 3,4');
  // replace: the current entry
  await p.click('p3r');
  expect(p.history()).toEqual(['http://localhost/', 'http://localhost/?page=3']);
  expect(p.shown()).toBe('3 5,6');
  expect(p.navigations).toEqual([]);
});

test('anywhere else, or a parameter the page does not read: the browser navigates, absolute', async () => {
  const p = await setup();
  await p.click('away');
  await p.click('awayr');
  await p.click('other');
  expect(p.navigations).toEqual(['http://localhost/login', 'replace http://localhost/login', 'http://localhost/?lang=de']);
  expect(p.url()).toBe('http://localhost/');
});

test('in `then`, with the response', async () => {
  const p = await setup();
  await p.click('save');
  expect(p.navigations).toEqual(['http://localhost/saved/7']);
});

test('the build loads the same-page module for a page that calls navigate() and reads the URL', () => {
  const opts = { file: '/p/index.html', root: '/p', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} } };
  const out = compile(`<span data-sn-text="$url.q"></span><button data-sn-on-click="navigate('?q=1')"></button>`, opts);
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.module).toContain('query-links');
  // a page that reads no parameter: nothing to stay on, no module
  expect(compile(`<button data-sn-on-click="navigate('/x')"></button>`, opts).module).not.toContain('query-links');
});
