// @vitest-environment jsdom
// In a branch, an `if` holding a constant text next to a sibling loop: both render, at run time, early and over constants.
import { expect, test } from 'vitest';
import { mockRequests, render } from '../../src/testing/index.js';

const SEP = `<template data-sn-if="i > 0"><template data-sn-text="' '"></template></template>`;
const LOOP = `<template data-sn-for="n in b.children"><template data-sn-text="n"></template></template>`;
const outer = (inner: string) => `<template data-sn-props="{ doc?: any }"><span class="l"><template data-sn-for="(b, i) in doc ? doc.children : []"><template data-sn-if="b.ok">${inner}</template></template></span></template>`;
const DATA = { children: [{ ok: true, children: ['a', 'b'] }, { ok: true, children: ['c'] }] };

async function text(component: string, opts: { early?: boolean; constant?: boolean } = {}) {
  const components = { 'x-l': component };
  if (opts.constant) {
    const { root } = await render(`<div data-sn-state="{ d: ${JSON.stringify(DATA).replace(/"/g, "'")} }"><x-l data-sn-with="{ doc: d }"></x-l></div>`, { components, static: true } as never);
    return root.querySelector('.l')!.textContent;
  }
  const page = opts.early
    ? `<!doctype html><html><head><script type="application/json" data-sn-data="d">${JSON.stringify(DATA)}</script></head><body><sn-resource name="d" src="/api/d"></sn-resource><x-l data-sn-with="{ doc: d }"></x-l></body></html>`
    : '<sn-resource name="d" src="/api/d"></sn-resource><x-l data-sn-with="{ doc: d }"></x-l>';
  let early: string | null = null;
  const { root, settle } = await render(page, { components, requests: mockRequests({ 'GET /api/d': DATA }), ...(opts.early ? { firstPaint: { afterEarly: () => { early = document.querySelector('.l')!.textContent; } } } : {}) });
  await settle();
  return opts.early ? [early, root.querySelector('.l')!.textContent] : root.querySelector('.l')!.textContent;
}

test('the repro: an if with a constant text, then a loop', async () => {
  expect(await text(outer(SEP + LOOP))).toBe('ab c');
});
test('the if after the loop', async () => {
  expect(await text(outer(LOOP + SEP.replace('i > 0', 'i < 1')))).toBe('ab c');
});
test('without the outer for', async () => {
  const c = `<template data-sn-props="{ doc?: any }"><span class="l"><template data-sn-if="doc"><template data-sn-if="doc.sep"><template data-sn-text="'-'"></template></template><template data-sn-for="n in doc.children"><template data-sn-text="n"></template></template></template></span></template>`;
  const components = { 'x-l': c };
  const { root, settle } = await render('<sn-resource name="d" src="/api/d"></sn-resource><x-l data-sn-with="{ doc: d }"></x-l>', { components, requests: mockRequests({ 'GET /api/d': { sep: true, children: ['a', 'b'] } }) });
  await settle();
  expect(root.querySelector('.l')!.textContent).toBe('-ab');
});
test('early, then the page module', async () => {
  expect(await text(outer(SEP + LOOP), { early: true })).toEqual(['ab c', 'ab c']);
});
test('over constants', async () => {
  expect(await text(outer(SEP + LOOP), { constant: true })).toBe('ab c');
});

test('any node after a nested anchor in a branch is found: a bound element after an if, updated later', async () => {
  const c = `<template data-sn-props="{ doc?: any }"><span class="l"><template data-sn-if="doc"><template data-sn-if="doc.sep"><b>-</b></template><i data-sn-text="doc.v"></i></template></span></template>`;
  const { root, settle } = await render(`<div data-sn-state="{ d: null }"><button id="w" data-sn-on-click="d = { sep: true, v: d ? d.v + 1 : 1 }">w</button><x-l data-sn-with="{ doc: d }"></x-l></div>`, { components: { 'x-l': c } });
  (root.querySelector('#w') as HTMLButtonElement).click();
  await settle();
  expect(root.querySelector('.l')!.textContent).toBe('-1');
  (root.querySelector('#w') as HTMLButtonElement).click();
  await settle();
  expect(root.querySelector('.l')!.textContent).toBe('-2');
});

test('an early branch with a nested if and a loop, adopted, then refreshed', async () => {
  const c = `<template data-sn-props="{ doc?: any }"><span class="l"><template data-sn-if="doc.on"><template data-sn-if="doc.sep"><b>-</b></template><template data-sn-for="n in doc.children"><i data-sn-text="n"></i></template></template><button id="r" data-sn-on-click="refresh(d)">r</button></span></template>`;
  const data = { on: true, sep: true, children: ['a', 'b'] };
  let early = '';
  const { root, settle } = await render(`<!doctype html><html><head><script type="application/json" data-sn-data="d">${JSON.stringify(data)}</script></head><body><sn-resource name="d" src="/api/d"></sn-resource><x-l data-sn-with="{ doc: d }"></x-l></body></html>`,
    { components: { 'x-l': c }, requests: mockRequests({ 'GET /api/d': { on: true, sep: false, children: ['c'] } }), firstPaint: { afterEarly: () => { early = document.querySelector('.l')!.textContent!; } } });
  await settle();
  expect(early).toBe('-abr');
  expect(root.querySelector('.l')!.textContent).toBe('-abr');
  (root.querySelector('#r') as HTMLButtonElement).click();
  await settle();
  expect(root.querySelector('.l')!.textContent).toBe('cr');
});
