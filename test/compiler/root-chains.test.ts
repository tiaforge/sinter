// Constant trees through component roots that are if chains (docs/spec.md, Build-time constants): a loop
// in a branch of such a root, and a chain nested in its else, are unrolled and decided per instance.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const C: Record<string, string> = {
  'x-doc': `<template data-sn-component="{ doc: any }"><article><template data-sn-for="b in doc.children"><sn-component use="{ list: 'x-list', h: 'x-h', deep: 'x-deep' }[b.type]" data-sn-prop="{ node: b }"></sn-component></template></article></template>`,
  'x-list': `<template data-sn-component="{ node: any }"><template data-sn-if="node.ordered"><ol><template data-sn-for="i in node.children"><li data-sn-text="i"></li></template></ol></template><template data-sn-else><ul><template data-sn-for="i in node.children"><li data-sn-text="i"></li></template></ul></template></template>`,
  'x-h': `<template data-sn-component="{ node: any }"><template data-sn-if="node.depth === 1"><h1 data-sn-text="node.value"></h1></template><template data-sn-else><template data-sn-if="node.depth === 2"><h2 data-sn-text="node.value"></h2></template><template data-sn-else><h3 data-sn-text="node.value"></h3></template></template></template>`,
  // a component used inside itself whose root is a chain
  'x-t': `<template data-sn-component="{ node: any }"><template data-sn-if="node.kids"><ul><template data-sn-for="k in node.kids"><li><x-t data-sn-prop="{ node: k }"></x-t></li></template></ul></template><template data-sn-else><span data-sn-text="node.v"></span></template></template>`,
  // one level deeper: a loop in a branch of a chain nested in the else of a chain root
  'x-deep': `<template data-sn-component="{ node: any }"><template data-sn-if="node.kind === 'a'"><p data-sn-text="node.kind"></p></template><template data-sn-else><template data-sn-if="node.kind === 'b'"><ol><template data-sn-for="i in node.children"><li data-sn-text="i"></li></template></ol></template><template data-sn-else><ul><template data-sn-for="i in node.children"><li data-sn-text="i"></li></template></ul></template></template></template>`,
};
function build(doc: unknown, page = '<x-doc data-sn-prop="{ doc }"></x-doc>') {
  const files: Record<string, string> = { '/p/doc.json': JSON.stringify(doc) };
  for (const [k, v] of Object.entries(C)) files[`/p/src/components/${k}.html`] = v;
  return compile('<!doctype html><html><head></head><body><sn-resource name="doc" src="file:./doc.json"></sn-resource>' + page + '</body></html>', {
    file: '/p/index.html', root: '/p', dev: false, prerender: true, static: true, componentNames: Object.keys(C),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
  });
}
const report = (out: ReturnType<typeof build>) => out.diagnostics.map((d) => `${d.code} ${d.file}:${d.line}:${d.col}`);
const body = (out: ReturnType<typeof build>) => /<body>([\s\S]*)<\/body>/.exec(out.html)![1];

test('B: a for inside a branch of an if-chain root unrolls over constants', () => {
  const out = build({ children: [{ type: 'list', ordered: false, children: ['a', 'b'] }] });
  expect(report(out)).toEqual([]);
  expect(body(out)).toBe('<article><ul><li>a</li><li>b</li></ul></article>');
});

test('C: an if chain nested in the else of an if-chain root is decided over constants', () => {
  const out = build({ children: [{ type: 'h', depth: 2, value: 'two' }] });
  expect(report(out)).toEqual([]);
  expect(body(out)).toBe('<article><h2>two</h2></article>');
});

test('a for in a branch of a chain nested in an if-chain root, each instance its own branch', () => {
  const out = build({ children: [
    { type: 'deep', kind: 'b', children: ['x', 'y'] }, { type: 'deep', kind: 'c', children: ['z'] }, { type: 'deep', kind: 'a' },
    { type: 'list', ordered: true, children: ['1'] }, { type: 'h', depth: 3, value: 'three' },
  ] });
  expect(report(out)).toEqual([]);
  expect(body(out)).toBe('<article><ol><li>x</li><li>y</li></ol><ul><li>z</li></ul><p>a</p><ol><li>1</li></ol><h3>three</h3></article>');
});

test('a component used inside itself whose root is a chain expands at every level', () => {
  const out = build({ kids: [{ v: 'a' }, { kids: [{ v: 'b' }, { v: 'c' }] }] }, '<x-t data-sn-prop="{ node: doc }"></x-t>');
  expect(report(out)).toEqual([]);
  expect(body(out)).toBe('<ul><li><span>a</span></li><li><ul><li><span>b</span></li><li><span>c</span></li></ul></li></ul>');
});
