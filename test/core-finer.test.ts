// The finer parts of the site's core (docs/proposals/site-core.md): what decides each one, a page that uses it working
// on a core with it, a page that does not working without it, and what happens when code reaches a part left out.
import { expect, test, vi } from 'vitest';
import { compile } from '../src/compiler/index.js';
import { navigate } from '../src/runtime/app.js';
import { render } from '../src/testing/index.js';
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
