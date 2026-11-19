import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const C: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any; code: Slot<{ node: any }> }"><article><template data-sn-for="b in doc.children"><sn-component use="{ code: 'x-code', quote: 'x-quote' }[b.type]" data-sn-prop="{ node: b }"></sn-component></template></article></template>`,
  'x-code': `<template data-sn-props="{ node: any }"><slot name="code" data-sn-prop="{ node }"><pre data-sn-text="node.value"></pre></slot></template>`,
  'x-quote': `<template data-sn-props="{ node: any }"><blockquote><template data-sn-for="b in node.children"><sn-component use="{ code: 'x-code', quote: 'x-quote' }[b.type]" data-sn-prop="{ node: b }"></sn-component></template></blockquote></template>`,
};

function build(doc: unknown, fill = '') {
  const files: Record<string, string> = { '/p/doc.json': JSON.stringify(doc) };
  for (const [k, v] of Object.entries(C)) files[`/p/src/components/${k}.html`] = v;
  return compile(`<!doctype html><html><head></head><body><sn-resource name="doc" src="file:./doc.json"></sn-resource><x-doc data-sn-prop="{ doc }">${fill}</x-doc></body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, prerender: true, static: true, componentNames: Object.keys(C),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
  });
}

const body = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)![1];

test('a tree placement in a directly rendered candidate, with no fill, has no false SN201', () => {
  const out = build({ children: [{ type: 'code', value: 'top' }] });
  expect(out.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  expect(body(out.html)).toBe('<article><pre>top</pre></article>');
});

test('the same placement, one level down and at the top together, and with a fill', () => {
  const doc = { children: [{ type: 'code', value: 'top' }, { type: 'quote', children: [{ type: 'code', value: 'deep' }] }] };
  const out = build(doc);
  expect(out.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  expect(body(out.html)).toBe('<article><pre>top</pre><blockquote><pre>deep</pre></blockquote></article>');
  const filled = build(doc, '<pre slot="code" class="c" data-sn-text="$slot.node.value"></pre>');
  expect(filled.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  expect(body(filled.html)).toBe('<article><pre class="c">top</pre><blockquote><pre class="c">deep</pre></blockquote></article>');
});

test('a placement that is its component\'s root compiles its data-sn-prop in that component\'s scope, without prerender too', () => {
  const comps = {
    'x-doc': `<template data-sn-props="{ doc: any; code: Slot<{ node: any }> }"><article><x-code data-sn-prop="{ node: doc }"></x-code></article></template>`,
    'x-code': `<template data-sn-props="{ node: any }"><slot name="code" data-sn-prop="{ node: NODE }"><pre data-sn-text="node.value"></pre></slot></template>`,
  };
  const run = (name: string) => {
    const files: Record<string, string> = { '/p/doc.json': '{"value":"v"}' };
    for (const [k, v] of Object.entries(comps)) files[`/p/src/components/${k}.html`] = v.replace('NODE', name);
    return compile('<!doctype html><html><head></head><body><sn-resource name="doc" src="file:./doc.json"></sn-resource><x-doc data-sn-prop="{ doc }"></x-doc></body></html>', {
      file: '/p/index.html', root: '/p', dev: false, componentNames: Object.keys(comps),
      helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
    }).diagnostics.map((d) => `${d.code} ${d.message}`);
  };
  expect(run('node')).toEqual([]);
  // a name the component does not have is still reported, at the placement
  expect(run('nod')).toEqual([expect.stringMatching(/^SN201 `nod` is not defined/)]);
});
