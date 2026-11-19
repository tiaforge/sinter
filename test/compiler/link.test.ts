// Linking (docs/proposals/compile-once.md, (5)): shared definitions recorded on one page and linked into the next
// (compile's `definitions`). Every page must be what it is compiled on its own, whatever comes before its first
// recursion point on the page: other components, templates, state, a fill of the tree's slot, a second tree.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const INL = "{ text: 'x-text', link: 'x-link' }";
const C: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any; link: Slot<{ url: string }> }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></div></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': `<template data-sn-props="{ node: any }"><slot name="link" data-sn-prop="{ url: node.url }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></a></slot></template>`,
  'x-pill': '<template data-sn-props="{ to: string }"><a class="pill" data-sn-attr="{ href: to }"><slot></slot></a></template>',
};
const DOC = { children: [{ type: 'text', value: 'see ' }, { type: 'link', url: '/a', children: [{ type: 'text', value: 'a' }, { type: 'link', url: '/b', children: [{ type: 'text', value: 'b' }] }] }] };
const OTHER = { children: [{ type: 'link', url: '/c', children: [{ type: 'text', value: 'c' }] }] };

const PAGES: Record<string, string> = {
  alone: '<x-doc data-sn-prop="{ doc }"></x-doc>',
  'loop and if before': '<ul><template data-sn-for="x in [1, 2, 3]"><li data-sn-text="x"></li></template></ul><template data-sn-if="doc.children.length > 1"><p>long</p></template><x-doc data-sn-prop="{ doc }"></x-doc>',
  'component before': '<x-pill data-sn-prop="{ to: \'/home\' }">home</x-pill><x-doc data-sn-prop="{ doc }"></x-doc>',
  'a fill of its slot': '<x-doc data-sn-prop="{ doc }"><a slot="link" class="L" data-sn-attr="{ href: $slot.url }"><slot></slot></a></x-doc>',
  'state and a handler': '<section data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></section><x-doc data-sn-prop="{ doc }"></x-doc>',
  'two trees': '<x-doc data-sn-prop="{ doc }"></x-doc><x-doc data-sn-prop="{ doc: other }"></x-doc>',
};

function build(name: string, body: string, definitions?: Map<string, unknown>) {
  const files: Record<string, string> = { '/p/doc.json': JSON.stringify(DOC), '/p/other.json': JSON.stringify(OTHER) };
  for (const [k, s] of Object.entries(C)) files[`/p/src/components/${k}.html`] = s;
  const out = compile(`<!doctype html><html><head></head><body><sn-resource name="doc" src="file:./doc.json"></sn-resource><sn-resource name="other" src="file:./other.json"></sn-resource>${body}</body></html>`, {
    file: `/p/${name.replace(/\W+/g, '-')}.html`, root: '/p', dev: false, prerender: true, componentNames: Object.keys(C),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
    ...(definitions ? { definitions } : {}),
  });
  return { html: out.html, module: out.module, early: out.early, runtime: out.runtime, diagnostics: out.diagnostics };
}

test('pages of every shape, linked: each as compiled on its own', () => {
  const definitions = new Map<string, unknown>();
  const stats = { hits: 0, recorded: 0, refused: [] as string[] };
  (globalThis as { __snLink?: typeof stats }).__snLink = stats;
  try {
    // three rounds: a definition is seen, then recorded, then linked
    for (let round = 0; round < 3; round++) for (const [name, body] of Object.entries(PAGES)) {
      expect(build(name, body, definitions), `${name}, round ${round}`).toEqual(build(name, body));
    }
  } finally { delete (globalThis as { __snLink?: unknown }).__snLink; }
  expect(stats.refused, JSON.stringify(stats.refused)).toEqual([]);
  expect(stats.recorded).toBeGreaterThan(0);
  expect(stats.hits).toBeGreaterThan(0);
});

test('an action in a definition: refused (its index is not renumbered), and each page as compiled on its own', () => {
  const definitions = new Map<string, unknown>();
  const stats = { hits: 0, recorded: 0, refused: [] as string[] };
  (globalThis as { __snLink?: typeof stats }).__snLink = stats;
  const was = C['x-link']!;
  // a button in every link of the tree, after the page's own action, so the page's actions and the unit's would mix
  C['x-link'] = was.replace('<a data-sn-attr', '<button data-sn-post="/api/visit/{node.url}">visit</button><a data-sn-attr');
  try {
    const body = '<button data-sn-post="/api/page">page</button><x-doc data-sn-prop="{ doc }"></x-doc>';
    for (let round = 0; round < 3; round++) for (const name of ['first', 'second']) expect(build(name, body, definitions), `${name}, round ${round}`).toEqual(build(name, body));
  } finally { C['x-link'] = was; delete (globalThis as { __snLink?: unknown }).__snLink; }
  expect(stats.refused.some((r) => r.includes('adds an action'))).toBe(true);
});
