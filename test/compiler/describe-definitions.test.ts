// A page's description (`describeOnly`, what the build reads for prefetch, prerendering and swaps) leaves out a shared
// definition that can add nothing to it (`describesNothing`): a component library's node dispatch is walked once per
// page, not twice. Whatever a definition holds, the description must be what the page's own compile reports.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

type Options = Parameters<typeof compile>[1];
const INL = "{ text: 'x-text', link: 'x-link' }";
const loop = `<template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template>`;
const COMPONENTS: Record<string, string> = {
  // the root: declares the tree slot `link`, filled from the page, placed deep in the tree by x-link
  'x-doc': `<template data-sn-props="{ doc: any; link: Slot<{ node: any }> }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': `<template data-sn-props="{ node: any }"><slot name="link" data-sn-with="{ node }"><a data-sn-attr="{ href: node.url }">${loop}</a></slot></template>`,
};

function compiled(body: string, components: Record<string, string> = {}, scripts: Record<string, string> = {}) {
  const all = { ...COMPONENTS, ...components };
  const files: Record<string, string> = {};
  for (const [k, s] of Object.entries(all)) files[`/p/src/components/${k}.html`] = s;
  for (const [k, s] of Object.entries(scripts)) files[`/p/src/components/${k}.ts`] = s;
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body>
<sn-resource name="doc" src="/api/doc?id={$url.id}"></sn-resource>
${body}
</body></html>`;
  const o: Options = {
    file: '/p/index.html', root: '/p', dev: false, componentNames: Object.keys(all),
    helpers: { module: null, names: [], namespaces: {} },
    readFile: (f) => { const t = files[f]; if (t === undefined) throw new Error(`no such file: ${f}`); return t; },
  } as Options;
  const fields = (r: ReturnType<typeof compile>) => ({ prefetch: r.prefetch, off: !!r.prefetchOff, path: r.path, effect: r.loadEffect ?? null, keep: r.permanent ?? [], keptSource: r.keptSource ?? {}, keptBound: r.keptBound ?? [], swapOff: !!r.swapOff });
  const full = compile(html, o), described = compile(html, { ...o, describeOnly: true });
  const templates = (h: string) => (h.match(/<template id="sn-t-/g) ?? []).length;
  return { full: fields(full), described: fields(described), skipped: templates(described.html) < templates(full.html), errors: full.diagnostics.filter((d) => d.severity === 'error') };
}

const USE = '<x-doc data-sn-with="{ doc }"></x-doc>';

test('a definition that adds nothing is left out of the description, which is the page\'s', () => {
  const r = compiled(USE);
  expect(r.errors).toEqual([]);
  expect(r.skipped).toBe(true);
  expect(r.described).toEqual(r.full);
  expect(r.full.prefetch?.res).toHaveLength(1);
  expect(r.full.effect).toBeNull();
});

test('a fill passed down the tree that does something as the page loads: the description walks the definition that places it', () => {
  const r = compiled('<x-doc data-sn-with="{ doc }"><img slot="link" alt="" data-sn-state="{ n: 0 }" data-sn-on-load="n = 1"></x-doc>');
  expect(r.errors).toEqual([]);
  expect(r.skipped).toBe(false);
  expect(r.full.effect).toBe('a handler of `load`, which the page may fire as it loads');
  expect(r.described).toEqual(r.full);
});

test.each([
  ['a link', '<a slot="link" data-sn-attr="{ href: $slot.node.url }"><slot></slot></a>'],
  ['a branch and its else', '<template slot="link" data-sn-if="$slot.node.url"><a data-sn-attr="{ href: $slot.node.url }"><slot></slot></a></template><template data-sn-else><span><slot></slot></span></template>'],
  ['a component without a script', '<x-pill slot="link" data-sn-with="{ node: $slot.node }"></x-pill>'],
])('a fill that adds nothing (%s): the definition is left out, the description is the page\'s', (_, fill) => {
  const r = compiled(`<x-doc data-sn-with="{ doc }">${fill}</x-doc>`, { 'x-pill': '<template data-sn-props="{ node: any }"><b data-sn-text="node.url"></b></template>' });
  expect(r.errors).toEqual([]);
  expect(r.skipped).toBe(true);
  expect(r.described).toEqual(r.full);
});

test.each([
  ['a fill with a click handler', '<x-doc data-sn-with="{ doc }"><a slot="link" data-sn-state="{ n: 0 }" data-sn-on-click="n = 1"><slot></slot></a></x-doc>', {}],
  ['a click handler and a key filter in a definition', USE, { 'x-text': '<template data-sn-props="{ node: any }"><span tabindex="0" data-sn-state="{ n: 0 }" data-sn-on-click="n = 1" data-sn-on-keydown-enter="n = 2" data-sn-text="node.value"></span></template>' }],
  ['an action on its click in a definition', USE, { 'x-text': '<template data-sn-props="{ node: any }"><button data-sn-post="/api/seen" data-sn-text="node.value"></button></template>' }],
] as Array<[string, string, Record<string, string>]>)('%s: a visitor\'s event adds nothing, the definition is left out', (_, body, components) => {
  const r = compiled(body, components);
  expect(r.errors).toEqual([]);
  expect(r.skipped).toBe(true);
  expect(r.full.effect).toBeNull();
  expect(r.described).toEqual(r.full);
});

test.each([
  ['an action triggered on load', '<img slot="link" alt="" data-sn-post="/api/seen" data-sn-trigger="load">', {}, {}, 'a handler of `load`'],
  ['a custom element', '<my-chip slot="link"></my-chip>', {}, {}, 'a custom element (`<my-chip>`)'],
  ['an inline script', '<span slot="link"><slot></slot><script>track()</script></span>', {}, {}, 'an inline script'],
  ['a load handler in a branch', '<template slot="link" data-sn-if="$slot.node.url"><img alt="" data-sn-state="{ n: 0 }" data-sn-on-load="n = 1"></template>', {}, {}, 'a handler of `load`'],
  ['a component with a script', '<x-pill slot="link" data-sn-with="{ node: $slot.node }"></x-pill>', { 'x-pill': '<template data-sn-props="{ node: any }"><b data-sn-text="node.url"></b></template>' }, { 'x-pill': 'export class XPill {}' }, 'a component with a script'],
] as Array<[string, string, Record<string, string>, Record<string, string>, string]>)('a fill holding %s: the description walks the definition that places it', (_, fill, components, scripts, effect) => {
  const r = compiled(`<x-doc data-sn-with="{ doc }">${fill}</x-doc>`, components, scripts);
  expect(r.errors).toEqual([]);
  expect(r.skipped).toBe(false);
  expect(r.full.effect).toContain(effect);
  expect(r.described).toEqual(r.full);
});

test.each([
  ['a handler of an event no visitor causes', { 'x-text': '<template data-sn-props="{ node: any }"><img alt="" data-sn-state="{ n: 0 }" data-sn-on-load="n = 1"></template>' }, {}, 'a handler of `load`'],
  ['an action triggered by an event no visitor causes', { 'x-text': '<template data-sn-props="{ node: any }"><img alt="" data-sn-post="/api/seen" data-sn-trigger="load"></template>' }, {}, 'a handler of `load`'],
  ['a custom element', { 'x-text': '<template data-sn-props="{ node: any }"><my-chart></my-chart></template>' }, {}, 'a custom element (`<my-chart>`)'],
  ['an inline script', { 'x-text': '<template data-sn-props="{ node: any }"><span>t<script>track()</script></span></template>' }, {}, 'an inline script'],
  ['a component with a script, reached from the dispatch', { 'x-text': '<template data-sn-props="{ node: any }"><x-chip data-sn-with="{ node }"></x-chip></template>', 'x-chip': '<template data-sn-props="{ node: any }"><b data-sn-text="node.value"></b></template>' }, { 'x-chip': 'export class XChip {}' }, 'a component with a script'],
] as Array<[string, Record<string, string>, Record<string, string>, string]>)('a definition holding %s: in the description', (_, components, scripts, effect) => {
  const r = compiled(USE, components, scripts);
  expect(r.errors).toEqual([]);
  expect(r.skipped).toBe(false);
  expect(r.full.effect).toContain(effect);
  expect(r.described).toEqual(r.full);
});

