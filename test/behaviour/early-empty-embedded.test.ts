// A list's empty state over an embedded resource is in the first paint (docs/spec.md, "Resource status early"): the
// embedded payload is the resource's first load, so at mount it is loaded (`loadedAt` set), not loading and has no
// error. The early file writes that status in, and the page module adopts the branch it painted.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const PAGE = (data: unknown, res = '', body = '') => `<!doctype html><html><head>${data === undefined ? '' : `<script type="application/json" data-sn-resource="c">${typeof data === 'string' ? data : JSON.stringify(data)}</script>`}</head><body>
  <sn-resource name="c" src="/api/c" select="c" key="id" ${res}></sn-resource>
  ${body || '<ul><template data-sn-for="x in c"><li data-sn-text="x.name"></li></template><template data-sn-else><li id="none">None</li></template></ul>'}
</body></html>`;
const none = () => document.getElementById('none');
const shape = () => document.body.querySelector('ul')?.outerHTML.replace(/<!--[^>]*-->/g, '') ?? '';

// a request sent at mount would never be answered here
beforeEach(() => { vi.stubGlobal('fetch', () => new Promise(() => {})); });
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });

/** the first paint, and the page after the page module took it over; whether the empty state's element was kept */
async function both(html: string, components?: Record<string, string>) {
  let early = '', el: Element | null = null;
  const requests = mockRequests({ 'GET /api/c': { c: [] } });
  const r = await render(html, { requests, ...(components ? { components } : {}), firstPaint: { afterEarly: () => { early = shape(); el = none(); } } });
  const kept = !!el && none() === el;
  await r.settle();
  return { early, took: shape(), kept, calls: requests.calls.length };
}

test('the page module mounts an embedded resource loaded, not loading, without error', async () => {
  const r = await render(PAGE({ c: [] }, '', `<p id="s" data-sn-text="[!!$meta.c.loadedAt, $meta.c.loading, $meta.c.error].join()"></p>`), { requests: mockRequests({}) });
  expect(r.root.querySelector('#s')!.textContent).toBe('true,false,');
  // a `refresh` reloads quietly: still not loading after its first reload starts
  const q = await render(PAGE({ c: [] }, 'refresh="1s"', `<p id="s" data-sn-text="$meta.c.loading"></p>`), { requests: mockRequests({}) });
  expect(q.root.querySelector('#s')!.textContent).toBe('false');
});

test('an empty embedded list: its empty state is in the first paint, and the page module adopts it', async () => {
  await firstPaint(PAGE({ c: [] }));
  expect(none()).not.toBeNull();
  const { early, took, kept, calls } = await both(PAGE({ c: [] }));
  expect(early).toBe(took);
  expect(kept).toBe(true);
  expect(calls).toBe(0);
});

test('a list with rows: no empty state at first paint or after', async () => {
  const { early, took } = await both(PAGE({ c: [{ id: 1, name: 'Ada' }] }));
  expect(early).toContain('Ada');
  expect(early).not.toContain('none');
  expect(early).toBe(took);
});

test('a list through a component prop and a fill over `$slot`', async () => {
  const components = {
    'c-list': `<template data-sn-props="{ x: any }"><ul><template data-sn-for="y in x.c.filter((z) => z.on)"><li data-sn-text="y.t"></li></template><template data-sn-else><li id="none">None</li></template></ul></template>`,
    'c-slot': `<template data-sn-props="{ x: any; item: Slot<{ x: any }> }"><div><slot name="item" data-sn-with="{ x }"></slot></div></template>`,
  };
  const prop = (data: unknown) => PAGE(data, '', `<template data-sn-let="{ d: c[0] }"><c-list data-sn-with="{ x: d }"></c-list></template>`).replace('key="id"', '');
  // a keyless list whose first entry is the component's item
  for (const [data, empty] of [[{ c: [{ t: 'a', c: [{ t: 'b', on: false }] }] }, true], [{ c: [{ t: 'a', c: [{ t: 'b', on: true }] }] }, false]] as const) {
    const html = prop(data).replace('<template data-sn-let="{ d: c[0] }">', '<div data-sn-let="{ d: c[0] }">').replace('</c-list></template>', '</c-list></div>');
    const r = await both(html, components);
    expect(r.early).toBe(r.took);
    expect(r.early.includes('None')).toBe(empty);
  }
  const fill = (data: unknown) => PAGE(data, '', `<div data-sn-let="{ d: c[0] }"><c-slot data-sn-with="{ x: d }"><q slot="item"><ul><template data-sn-for="z in $slot.x.c"><li data-sn-text="z.t"></li></template><template data-sn-else><li id="none">None</li></template></ul></q></c-slot></div>`).replace('key="id"', '');
  for (const [data, empty] of [[{ c: [{ t: 'a', c: [] }] }, true], [{ c: [{ t: 'a', c: [{ t: 'b' }] }] }, false]] as const) {
    const r = await both(fill(data), components);
    expect(r.early).toBe(r.took);
    expect(r.early.includes('None')).toBe(empty);
  }
});

test('a placeholder the server left empty: the page module loads it, and the empty state waits for that load', async () => {
  let early = 'unset';
  const requests = mockRequests({ 'GET /api/c': { c: [] } });
  const r = await render(PAGE(''), { requests, firstPaint: { afterEarly: () => { early = shape(); } } });
  expect(early).not.toContain('None');
  await r.settle();
  expect(none()).not.toBeNull();
});

test('status the build does not know is the page module\'s: `when`, `paginate`, `loadedAt` as a value', async () => {
  const early = async (html: string) => { let got = ''; await render(html, { requests: mockRequests({ 'GET /api/c': { c: [] } }), firstPaint: { afterEarly: () => { got = document.body.innerHTML.replace(/<template[\s\S]*?<\/template>/g, ''); } } }); return got; };
  // with `when` the payload is not stored when it is falsy at mount; a pager may load the page the URL names
  expect(await early(PAGE({ c: [] }, 'when="$url.go"'))).not.toContain('id="none"');
  expect(await early(PAGE({ c: [] }, 'paginate="{ numbered: true, size: 2 }"'))).not.toContain('id="none"');
  // the mount's time: not a build-time value
  expect(await early(PAGE({ c: [] }, '', '<p id="at" data-sn-text="$meta.c.loadedAt || \'never\'"></p>'))).toMatch(/<p id="at"[^>]*><\/p>/);
  // its truth is
  expect(await early(PAGE({ c: [] }, '', '<p id="at" data-sn-text="$meta.c.loadedAt ? \'loaded\' : \'never\'"></p>'))).toMatch(/<p id="at"[^>]*>loaded<\/p>/);
});

test('the early function reads the embedded data first and writes the status in', async () => {
  const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null }, observe: true };
  const code = compile(PAGE({ c: [] }), opts).early!;
  expect(code).toContain('$.$r.c, ');
  expect(code).not.toContain('$meta');
});
