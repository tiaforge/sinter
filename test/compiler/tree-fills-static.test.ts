// Fills of tree placements in a constant tree on a static page (docs/static-pages.md, What is static): the
// fills a tree expands at build time, and the two that render in the browser, which SN322 names with why.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const INL = "{ text: 'x-text', link: 'x-link' }";
const C: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any; link: Slot<{ url: string }> }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></div></template>`,
  'x-text': `<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>`,
  'x-link': `<template data-sn-props="{ node: any }"><slot name="link" data-sn-prop="{ url: node.url }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></a></slot></template>`,
  'x-pill': `<template data-sn-props="{ to: string }"><a class="pill" data-sn-attr="{ href: to }"><slot></slot></a></template>`,
  // a wrapper that passes the page's link fill on to the tree
  'x-wrap': `<template data-sn-props="{ doc: any; link: Slot<{ url: string }> }"><x-doc data-sn-prop="{ doc }"><slot name="link" slot="link" data-sn-prop="{ url: $slot.url }"></slot></x-doc></template>`,
};
const DOC = { children: [{ type: 'text', value: 'see ' }, { type: 'link', url: '/a', children: [{ type: 'text', value: 'a' }] }] };

function build(body: string) {
  const files: Record<string, string> = { '/p/doc.json': JSON.stringify(DOC) };
  for (const [k, s] of Object.entries(C)) files[`/p/src/components/${k}.html`] = s;
  return compile(`<!doctype html><html><head></head><body><sn-resource name="doc" src="file:./doc.json"></sn-resource>${body}</body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, prerender: true, static: true, componentNames: Object.keys(C),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
  });
}
const html = (out: ReturnType<typeof build>) => /<body>([\s\S]*?)(<template|<\/body>)/.exec(out.html)![1];
const sn322 = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.code === 'SN322').map((d) => `${d.line}:${d.col} ${/but (.*) runs in the browser/.exec(d.message)?.[1]}`);

test('a fill with a <slot>, a chain fill and a component tag fill with slot content expand: nothing runs in the browser', () => {
  for (const [fill, want] of [
    ['<a slot="link" class="L" data-sn-attr="{ href: $slot.url }"><slot></slot></a>', '<div><span>see </span><a class="L" href="/a"><span>a</span></a></div>'],
    [`<template slot="link" data-sn-if="$slot.url == '/a'"><b data-sn-text="$slot.url"></b></template><template data-sn-else><i></i></template>`, '<div><span>see </span><b>/a</b></div>'],
    ['<x-pill slot="link" data-sn-prop="{ to: $slot.url }"><slot></slot></x-pill>', '<div><span>see </span><a class="pill" href="/a"><span>a</span></a></div>'],
  ] as const) {
    const out = build(`<x-doc data-sn-prop="{ doc }">${fill}</x-doc>`);
    expect(out.diagnostics).toEqual([]);
    expect(html(out)).toBe(want);
  }
});

test('a fill that holds a tree root of its own, or that a wrapper passes on, renders in the browser: SN322 names it and why', () => {
  const nested = build(`<x-doc data-sn-prop="{ doc }"><span slot="link"><x-doc data-sn-prop="{ doc }"></x-doc></span></x-doc>`);
  expect(sn322(nested)).toContainEqual('1:131 the fill `<span slot="link">` (it holds `<x-doc>`, a component with slots of its own, so it renders in the browser)');
  const wrapped = build(`<x-wrap data-sn-prop="{ doc }"><em slot="link" data-sn-text="$slot.url"></em></x-wrap>`);
  expect(sn322(wrapped)).toContainEqual(expect.stringMatching(/^1:\d+ the fill `<em slot="link">` \(it is passed on to `<x-doc>` by a component's `<slot name="link" slot="link">`, so it renders in the browser\)$/));
});

test('a fill that places the children twice is SN312 over constants and over state a handler writes alike', () => {
  const fill = '<u slot="link"><slot></slot>|<slot></slot></u>';
  const fixed = build(`<x-doc data-sn-prop="{ doc }">${fill}</x-doc>`);
  const files: Record<string, string> = {};
  for (const [k, s] of Object.entries(C)) files[`/p/src/components/${k}.html`] = s;
  const live = compile(`<!doctype html><html><head></head><body><div data-sn-state="{ doc: ${JSON.stringify(DOC).replace(/"/g, "'")} }"><i data-sn-on-click="doc = { ...doc }"></i><x-doc data-sn-prop="{ doc }">${fill}</x-doc></div></body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, prerender: true, componentNames: Object.keys(C),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
  });
  const twice = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.code === 'SN312').map((d) => d.message);
  expect(twice(fixed)).toEqual(['this fill of `link` places the children twice: two `<slot>`s in it can render together']);
  expect(twice(live)).toEqual(twice(fixed));
});
