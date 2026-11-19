// Constant trees through a component reached again by `<sn-component use>` inside its own row (a list in a
// list item): every level expands at build time, and a static page whose tree cannot fold says so (SN322).
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const MAP = "{ list: 'y-list', para: 'x-para', ol: 'y-ol', live: 'x-live' }";
const C: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any }"><article><template data-sn-for="b in doc.children"><sn-component use="${MAP}[b.type]" data-sn-prop="{ node: b }"></sn-component></template></article></template>`,
  'x-para': `<template data-sn-props="{ node: any }"><p data-sn-text="node.value"></p></template>`,
  'y-list': `<template data-sn-props="{ node: any }"><ul><template data-sn-for="i in node.children"><x-item data-sn-prop="{ node: i }"></x-item></template></ul></template>`,
  // the same list with an if-chain root
  'y-ol': `<template data-sn-props="{ node: any }"><template data-sn-if="node.ordered"><ol><template data-sn-for="i in node.children"><x-item data-sn-prop="{ node: i }"></x-item></template></ol></template><template data-sn-else><ul><template data-sn-for="i in node.children"><x-item data-sn-prop="{ node: i }"></x-item></template></ul></template></template>`,
  'x-item': `<template data-sn-props="{ node: any }"><li><template data-sn-for="b in node.children"><sn-component use="${MAP}[b.type]" data-sn-prop="{ node: b }"></sn-component></template></li></template>`,
  // a node that cannot be expanded at build time: its own state, which a click writes
  'x-live': `<template data-sn-props="{ node: any }"><button data-sn-state="{ n: 0 }" data-sn-on-click="n++" data-sn-text="node.value + n"></button></template>`,
};
function build(doc: unknown, more: { expansionLimit?: number } = {}) {
  const files: Record<string, string> = { '/p/doc.json': JSON.stringify(doc) };
  for (const [k, s] of Object.entries(C)) files[`/p/src/components/${k}.html`] = s;
  return compile('<!doctype html><html><head></head><body><sn-resource name="doc" src="file:./doc.json"></sn-resource><x-doc data-sn-prop="{ doc }"></x-doc></body></html>', {
    file: '/p/index.html', root: '/p', dev: false, prerender: true, static: true, componentNames: Object.keys(C),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); }, ...more,
  });
}
const body = (out: ReturnType<typeof build>) => /<body>([\s\S]*?)(<template|<\/body>)/.exec(out.html)![1];
const item = (...children: unknown[]) => ({ children });
const para = (value: string) => ({ type: 'para', value });

test('G: a list in a list item, through a choice, expands at build time', () => {
  const out = build({ children: [{ type: 'list', children: [item(para('a'), { type: 'list', children: [item(para('nested'))] })] }] });
  expect(out.diagnostics).toEqual([]);
  expect(body(out)).toBe('<article><ul><li><p>a</p><ul><li><p>nested</p></li></ul></li></ul></article>');
});

test('three levels deep, and with an if-chain root', () => {
  const three = build({ children: [{ type: 'list', children: [item({ type: 'list', children: [item({ type: 'list', children: [item(para('deep'))] })] })] }] });
  expect(three.diagnostics).toEqual([]);
  expect(body(three)).toBe('<article><ul><li><ul><li><ul><li><p>deep</p></li></ul></li></ul></li></ul></article>');
  const ol = build({ children: [{ type: 'ol', ordered: true, children: [item({ type: 'ol', ordered: false, children: [item({ type: 'ol', ordered: true, children: [item(para('x'))] })] })] }] });
  expect(ol.diagnostics).toEqual([]);
  expect(body(ol)).toBe('<article><ol><li><ul><li><ol><li><p>x</p></li></ol></li></ul></li></ol></article>');
});

test('a static page whose tree cannot be expanded at build time reports it (SN322), at any depth', () => {
  for (const doc of [
    { children: [{ type: 'live', value: 'top' }] },
    { children: [{ type: 'list', children: [item(para('a'), { type: 'list', children: [item({ type: 'live', value: 'deep' })] })] }] },
  ]) {
    const out = build(doc);
    expect(out.diagnostics.map((d) => d.code)).toContain('SN322');
  }
});

test('a static page never keeps a tree in the browser without SN322: one left there by the expansion limit', () => {
  const doc = { children: [{ type: 'list', children: [item(para('a'), { type: 'list', children: [item(para('b'), { type: 'list', children: [item(para('c'))] })] })] }] };
  const out = build(doc, { expansionLimit: 6 });
  const codes = out.diagnostics.map((d) => d.code);
  expect(codes).toContain('SN536');
  expect(codes).toContain('SN322');
  expect(out.static).toBeUndefined();
  // each SN322 names what runs in the browser, where it was written
  expect(out.diagnostics.filter((d) => d.code === 'SN322').map((d) => `${d.file}:${d.col} ${/but (.*) runs in the browser/.exec(d.message)![1]}`)).toEqual(['/p/index.html:60 resource `doc`', '/p/src/components/x-doc.html:72 `data-sn-for`']);
});
