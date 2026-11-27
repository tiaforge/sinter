// The finer parts of the site's core (docs/proposals/site-core.md): what decides each one, a page that uses it working
// on a core with it, a page that does not working without it, and what happens when code reaches a part left out.
import { expect, test, vi } from 'vitest';
import { compile } from '../src/compiler/index.js';
import { navigate } from '../src/runtime/app.js';
import { mockRequests, render } from '../src/testing/index.js';
import * as flags from './core-flags.js';

const parts = (html: string) => compile(`<html><body>${html}</body></html>`, {
  file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '', moduleSrc: '/m.js',
}).core;

test('a store function keeps its group when a handler names it, and only then', () => {
  expect(parts('<button data-sn-on-click="openDialog(\'d\')">o</button><dialog id="d"></dialog>')).toContain('FN_DIALOG');
  expect(parts('<div data-sn-state="{ x: 1 }"><button data-sn-on-click="emit(\'go\', x)">e</button></div>')).toEqual(['EVENTS', 'FN_EMIT']);
  expect(parts('<sn-resource name="xs" src="/api/xs" key="id"></sn-resource><template data-sn-for="x in xs"><button data-sn-on-click="remove(x)">x</button></template>')).toContain('FN_ITEMS');
  expect(parts('<sn-resource name="xs" src="/api/xs"></sn-resource><button data-sn-on-click="refresh(xs)">r</button>')).toContain('FN_REFRESH');
  // navigate() and signOut() are no part: the package's own navigate() and signOut() call them
  expect(parts('<button data-sn-on-click="navigate(\'/a\')">a</button>')).toEqual(['EVENTS']);
  // an optimistic change names them too
  expect(parts('<sn-resource name="xs" src="/api/xs" key="id"></sn-resource><template data-sn-for="x in xs"><button data-sn-delete="/api/xs/{x.id}" data-sn-optimistic="remove(x)">x</button></template>')).toContain('FN_ITEMS');
});

test('a page that calls emit() runs on a core with it; one that does not, without it', async () => {
  const seen: unknown[] = [];
  const { root, flush } = await render('<div data-sn-state="{ x: 1 }"><button id="b" data-sn-on-click="emit(\'go\', x)">e</button></div>');
  expect([flags.FN_EMIT, flags.FN_DIALOG, flags.FN_ITEMS, flags.FN_RUN]).toEqual([true, false, false, false]);
  root.addEventListener('go', (e) => seen.push((e as CustomEvent).detail));
  (root.querySelector('#b') as HTMLElement).click();
  await flush();
  expect(seen).toEqual([1]);
});

test('the package\'s navigate() works on a core with no store function part', async () => {
  const { flush, navigations } = await render('<p data-sn-text="$url.q"></p>');
  expect([flags.FN_DIALOG, flags.FN_ITEMS, flags.FN_REFRESH, flags.FN_PAGE, flags.FN_EMIT, flags.FN_RUN].some(Boolean)).toBe(false);
  navigate('/next');
  await flush();
  expect(navigations).toEqual(['http://localhost/next']);
});

test('a handler that reaches a store function the core left out fails loudly: a TypeError, logged', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { root, flush } = await render('<button id="b" data-sn-on-click="openDialog(\'d\')">o</button><dialog id="d"></dialog>');
  // a core built without the part (a build whose pages never call it), reached anyway
  flags.reset();
  flags.use({ v: 2, roots: [], templates: [], actions: [], resources: [], ev: ['click'] } as never);
  (root.querySelector('#b') as HTMLElement).click();
  await flush();
  expect(errors.mock.calls.flat().some((e) => e instanceof TypeError && /openDialog/.test(e.message))).toBe(true);
  expect((root.querySelector('#d') as HTMLDialogElement).open).toBe(false);
  errors.mockRestore();
});

test('a writer stays when a page has its kind of binding, and only then', () => {
  expect(parts('<div data-sn-state="{ s: \'x\' }"><p data-sn-text="s"></p></div>')).toEqual([]);
  expect(parts('<div data-sn-state="{ s: \'x\' }"><p><template data-sn-text="s"></template> after</p></div>')).toEqual(['TEXTRUN']);
  expect(parts('<div data-sn-state="{ s: true }"><p data-sn-show="s">x</p></div>')).toEqual(['SHOW']);
  expect(parts('<div data-sn-state="{ s: true }"><p data-sn-class="{ on: s }">x</p></div>')).toEqual([]);
  expect(parts('<div data-sn-state="{ s: \'red\' }"><p data-sn-class="{ [s]: true }">x</p></div>')).toEqual(['CLASSX']);
  expect(parts('<div data-sn-state="{ s: \'/a\' }"><a data-sn-attr="{ title: s }">x</a></div>')).toEqual(['ATTR']);
});

test('pages with and without each writer render on their own cores', async () => {
  // (a handler writes the state, so the build cannot render the bindings into the page)
  const { root } = await render('<div data-sn-state="{ s: \'/a\', on: true, c: \'red\' }"><button data-sn-on-click="s = c = \'\'; on = false">b</button><a id="a" data-sn-attr="{ title: s }" data-sn-show="on" data-sn-class="{ [c]: on }">x <template data-sn-text="c"></template></a></div>');
  expect([flags.TEXTRUN, flags.SHOW, flags.CLASSX, flags.ATTR]).toEqual([true, true, true, true]);
  const a = root.querySelector('#a') as HTMLAnchorElement;
  expect([a.getAttribute('title'), a.hidden, a.className, a.textContent]).toEqual(['/a', false, 'red', 'x red']);
  flags.reset();
  const plain = await render('<div data-sn-state="{ s: \'hi\', on: true }"><button data-sn-on-click="s = \'\'; on = false">b</button><p id="p" data-sn-text="s" data-sn-class="{ on }"></p></div>');
  expect([flags.TEXTRUN, flags.SHOW, flags.CLASSX, flags.ATTR]).toEqual([false, false, false, false]);
  expect(plain.root.querySelector('#p')!.outerHTML).toMatch(/^<p id="p" data-sn="\d+" class="on">hi<\/p>$/);
});

test('a binding that reaches a writer the core left out fails loudly: a TypeError out of the render', async () => {
  // a core built without attribute bindings, a page with one: its first render throws
  flags.without('ATTR');
  await expect(render('<div data-sn-state="{ s: \'/a\' }"><button data-sn-on-click="s = \'/b\'">b</button><a data-sn-attr="{ title: s }">x</a></div>')).rejects.toThrow(TypeError);
});

test('the store keeps keyed collections and ordering when a resource has a key or an order, and only then', () => {
  expect(parts('<sn-resource name="u" src="/api/u"></sn-resource><p data-sn-text="u.n"></p>')).toEqual(['RESOURCE']);
  expect(parts('<sn-resource name="xs" src="/api/xs" key="id"></sn-resource><template data-sn-for="x in xs"><p data-sn-text="x.n"></p></template>')).toEqual(['LIST', 'RESOURCE', 'KEYED']);
  expect(parts('<sn-resource name="xs" src="/api/xs" key="id" order="n"></sn-resource><template data-sn-for="x in xs"><p data-sn-text="x.n"></p></template>')).toEqual(['LIST', 'RESOURCE', 'KEYED', 'ORDER']);
});

test('keyed and ordered resources work on a core with the parts; a single value on one without', async () => {
  const requests = mockRequests({ 'GET /api/xs': [{ id: 2, n: 'b' }, { id: 1, n: 'a' }], 'GET /api/u': { n: 'me' } });
  const { root, settle } = await render('<sn-resource name="xs" src="/api/xs" key="id" order="n"></sn-resource><ul id="l"><template data-sn-for="x in xs"><li data-sn-text="x.n"></li></template></ul>', { requests });
  await settle();
  expect([flags.KEYED, flags.ORDER]).toEqual([true, true]);
  expect(root.querySelector('#l')!.textContent).toBe('ab');
  flags.reset();
  const one = await render('<sn-resource name="u" src="/api/u"></sn-resource><p id="p" data-sn-text="u.n"></p>', { requests });
  await one.settle();
  expect([flags.KEYED, flags.ORDER]).toEqual([false, false]);
  expect(one.root.querySelector('#p')!.textContent).toBe('me');
});

test('a resource with a key or an order on a core built without that part fails loudly at mount', async () => {
  const requests = mockRequests({ 'GET /api/xs': [{ id: 1, n: 'a' }] });
  flags.without('KEYED');
  await expect(render('<sn-resource name="xs" src="/api/xs" key="id"></sn-resource><template data-sn-for="x in xs"><p data-sn-text="x.n"></p></template>', { requests })).rejects.toThrow('resource xs: this build\'s core has no key');
  flags.reset();
  flags.without('ORDER');
  await expect(render('<sn-resource name="xs" src="/api/xs" key="id" order="n"></sn-resource><template data-sn-for="x in xs"><p data-sn-text="x.n"></p></template>', { requests })).rejects.toThrow('has no order');
});
