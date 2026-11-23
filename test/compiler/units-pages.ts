// The pages of the units tests (units.test.ts, units2.test.ts): a tree of components over a file (decided by the first
// pass, rendered) and over an API (live: its definitions ship), in pages of every shape.
import { compile } from '../../src/compiler/index.js';

const INL = "{ text: 'x-text', link: 'x-link' }";
const C: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any; link: Slot<{ url: string }> }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': `<template data-sn-props="{ node: any }"><slot name="link" data-sn-with="{ url: node.url }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></a></slot></template>`,
  'x-pill': '<template data-sn-props="{ to: string }"><a class="pill" data-sn-attr="{ href: to }"><slot></slot></a></template>',
};
const DOC = { children: [{ type: 'text', value: 'see ' }, { type: 'link', url: '/a', children: [{ type: 'text', value: 'a' }, { type: 'link', url: '/b', children: [{ type: 'text', value: 'b' }] }] }] };

export const PAGES: Record<string, string> = {
  alone: '<x-doc data-sn-with="{ doc }"></x-doc>',
  'a fill of its slot': '<x-doc data-sn-with="{ doc }"><a slot="link" class="L" data-sn-attr="{ href: $slot.url }"><slot></slot></a></x-doc>',
  'live': '<x-doc data-sn-with="{ doc: live }"></x-doc>',
  'live, a fill': '<x-doc data-sn-with="{ doc: live }"><a slot="link" class="L" data-sn-attr="{ href: $slot.url }"><slot></slot></a></x-doc>',
  'loop and if before': '<ul><template data-sn-for="x in live.children"><li data-sn-text="x.type"></li></template></ul><template data-sn-if="live.children.length > 1"><p>long</p></template><x-doc data-sn-with="{ doc: live }"></x-doc>',
  'component before': '<x-pill data-sn-with="{ to: \'/home\' }">home</x-pill><x-doc data-sn-with="{ doc }"></x-doc>',
  'state and a handler': '<section data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></section><x-doc data-sn-with="{ doc: live }"></x-doc>',
  'two trees': '<x-doc data-sn-with="{ doc }"></x-doc><x-doc data-sn-with="{ doc: live }"></x-doc>',
};

export function build(name: string, body: string, units?: Map<string, unknown>, check = false) {
  const files: Record<string, string> = { '/p/doc.json': JSON.stringify(DOC) };
  for (const [k, s] of Object.entries(C)) files[`/p/src/components/${k}.html`] = s;
  const out = compile(`<!doctype html><html><head></head><body><sn-resource name="doc" src="file:./doc.json"></sn-resource><sn-resource name="live" src="/api/doc"></sn-resource>${body}</body></html>`, {
    file: `/p/${name.replace(/\W+/g, '-')}.html`, root: '/p', dev: false, prerender: true, componentNames: Object.keys(C),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
    ...(units ? { units } : {}), ...(check ? { check: true } : {}),
  });
  return { html: out.html, module: out.module, early: out.early, runtime: out.runtime, diagnostics: out.diagnostics, check: out.check };
}

