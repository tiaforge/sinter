// Linking (docs/proposals/compile-once.md, (5)) across pages that differ in what comes before a definition, in their
// options and in their file: the review's findings, one scenario each. Pages compile in order through one cache of
// shared definitions, in rounds (a definition is seen, then recorded, then linked), and each page must be what it is
// compiled on its own. The tree's data comes from the API, so nothing folds and the definitions stay shared.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import type { RemoteConfig } from '../../src/remote.js';

const INL = "{ text: 'x-text', link: 'x-link' }";
const BASE: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any; link: Slot<{ url: string }> }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': `<template data-sn-props="{ node: any }"><slot name="link" data-sn-with="{ url: node.url }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></a></slot></template>`,
};
/** `x-link` with `extra` in its link, inside its one root (beside the `<slot>` it would be two, and not compile: SN312) */
const linkWith = (extra: string) => ({ 'x-link': BASE['x-link']!.replace('<a data-sn-attr="{ href: node.url }">', `<a data-sn-attr="{ href: node.url }">${extra}`) });
const TREE = '<x-doc data-sn-with="{ doc }"></x-doc>';

type Page = { name: string; body: string; opts?: Record<string, unknown> };
function build(page: Page, components: Record<string, string>, definitions?: Map<string, unknown>) {
  const files: Record<string, string> = {};
  for (const [k, s] of Object.entries(components)) files[`/p/src/components/${k}.html`] = s;
  const out = compile(`<!doctype html><html lang="en"><head></head><body><sn-resource name="doc" src="/api/doc"></sn-resource>${page.body}</body></html>`, {
    file: `/p/${page.name}.html`, root: '/p', dev: false, prerender: true, componentNames: Object.keys(components),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
    ...page.opts, ...(definitions ? { definitions } : {}),
  });
  return out;
}
/** the whole result, as text (functions by name, maps and sets as lists) */
const text = (r: unknown) => JSON.stringify(r, (_, v) => (typeof v === 'function' ? '[fn]' : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v), 1);
/** each page, in order, through one cache, three rounds: each must be what it is compiled on its own */
function linked(pages: Page[], more: Record<string, string> = {}) {
  const components = { ...BASE, ...more }, definitions = new Map<string, unknown>();
  // (the scenario's components compile: a test of nothing otherwise)
  for (const p of pages) expect(build(p, components).diagnostics.filter((d) => d.code === 'SN312'), `${p.name}: its components compile`).toEqual([]);
  for (let round = 0; round < 3; round++) for (const p of pages) {
    let got: ReturnType<typeof build>;
    expect(() => { got = build(p, components, definitions); }, `${p.name}, round ${round}: linking threw`).not.toThrow();
    expect(text(got!), `${p.name}, round ${round}`).toEqual(text(build(p, components)));
  }
  return definitions;
}

test('a feature the recording page had already (a checkbox model): the linked page has it too', () => {
  const model = '<span data-sn-state="{ on: false }"><input type="checkbox" data-sn-model="on"></span>';
  linked([{ name: 'a', body: model + TREE }, { name: 'b', body: model + TREE }, { name: 'c', body: TREE }], linkWith(model));
});

test('`$now`, which the recording page read already: the linked page reads it too', () => {
  const now = '<b data-sn-text="$now"></b>';
  linked([{ name: 'a', body: now + TREE }, { name: 'b', body: now + TREE }, { name: 'c', body: TREE }], linkWith(now));
});

test('a definition that reads `$locale`, recorded in one language and linked in another', () => {
  const lang = (name: string) => ({ locale: { name, urls: null, base: '/' } });
  linked([{ name: 'a', body: TREE, opts: lang('en') }, { name: 'b', body: TREE, opts: lang('en') }, { name: 'c', body: TREE, opts: lang('fr') }], linkWith('<b data-sn-text="$locale"></b>'));
});

test('a definition that calls `localeUrl()`, each page with its own translations', () => {
  const urls = (p: string) => ({ locale: { name: 'en', urls: { en: `/${p}`, fr: `/fr/${p}` }, base: '/' } });
  linked([{ name: 'a', body: TREE, opts: urls('a') }, { name: 'b', body: TREE, opts: urls('b') }, { name: 'c', body: TREE, opts: urls('c') }], linkWith('<a data-sn-attr="{ href: localeUrl(\'fr\') }">fr</a>'));
});

test('remote images in a definition: the page module defines what their functions call', () => {
  const remote: RemoteConfig = { url: 'https://img.example.com/{w}/{url}', cover: null, origins: ['self'], quality: 80 };
  const img = '<template data-sn-for="i in node.imgs ?? []"><img alt="" data-sn-attr="{ src: i }"></template>';
  // (compiled as a unit even when nothing links: the recording page, the first, is compared with it compiled in place)
  linked([{ name: 'a', body: TREE, opts: { remoteImages: remote } }, { name: 'b', body: TREE, opts: { remoteImages: remote } }, { name: 'c', body: TREE, opts: { remoteImages: remote } }], linkWith(img));
});

test('an image in a definition, each page with its own image host (URLs under the page\'s folder): compiled on each page', () => {
  const host = (dir: string) => ({ images: { info: () => ({ width: 800, height: 600, format: 'jpeg' }), url: (v: { width: number }) => `/${dir}/i-${v.width}.jpg`, ignore: true, stylesheet: `/@img/${dir}.css` } });
  const img = '<img src="/p/a.jpg" alt="">';
  linked([{ name: 'a', body: TREE, opts: host('a') }, { name: 'b', body: TREE, opts: host('b') }, { name: 'c', body: TREE, opts: host('c') }], linkWith(img));
});

test('a string in an expression that looks like a renumbered name (`x$1`) stays as written', () => {
  const loop = '<ul><template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template></ul>';
  linked([{ name: 'a', body: TREE }, { name: 'b', body: TREE }, { name: 'c', body: loop + TREE }], linkWith('<i data-sn-text="node.url.replace(/(a)/, \'x$1y$2\')"></i>'));
});

test('a dialog\'s template in a definition, on a page with another template before it', () => {
  const loop = '<ul><template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template></ul>';
  const res = '<sn-resource name="other" src="/api/other"></sn-resource>';
  linked([{ name: 'a', body: res + TREE }, { name: 'b', body: res + TREE }, { name: 'c', body: res + loop + TREE }], linkWith('<dialog><template data-sn-if="node.url"><p data-sn-text="other.title"></p></template></dialog>'));
});

test('a fill in a component used inside itself, on a page with another filled tree before it', () => {
  const wrap = '<template data-sn-props="{ doc: any }"><x-doc data-sn-with="{ doc }"><a slot="link" class="W" data-sn-attr="{ href: $slot.url }"><slot></slot></a></x-doc></template>';
  const filled = '<x-doc data-sn-with="{ doc }"><b slot="link" data-sn-text="$slot.url"></b></x-doc>';
  linked([{ name: 'a', body: '<x-wrap data-sn-with="{ doc }"></x-wrap>' }, { name: 'b', body: '<x-wrap data-sn-with="{ doc }"></x-wrap>' }, { name: 'c', body: filled + '<x-wrap data-sn-with="{ doc }"></x-wrap>' }], { 'x-wrap': wrap });
  linked([{ name: 'a', body: filled + '<x-wrap data-sn-with="{ doc }"></x-wrap>' }, { name: 'b', body: filled + '<x-wrap data-sn-with="{ doc }"></x-wrap>' }, { name: 'c', body: '<x-wrap data-sn-with="{ doc }"></x-wrap>' }], { 'x-wrap': wrap });
});

test('a component with scoped styles, used directly by the linked page and not by the recording one', () => {
  const styled = { 'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template><style>span { color: red }</style>' };
  const direct = '<x-text data-sn-with="{ node: { value: \'d\' } }"></x-text>';
  linked([{ name: 'a', body: TREE }, { name: 'b', body: TREE }, { name: 'c', body: direct + TREE }], styled);
  linked([{ name: 'a', body: direct + TREE }, { name: 'b', body: direct + TREE }, { name: 'c', body: TREE }], styled);
});

test('what the recording page had before the tree and the linked one has not: linked or refused, never a crash', () => {
  const direct = '<x-text data-sn-with="{ node: { value: \'d\' } }"></x-text>';
  linked([{ name: 'a', body: direct + TREE }, { name: 'b', body: direct + TREE }, { name: 'c', body: TREE }]);
  const res = '<sn-resource name="other" src="/api/other"></sn-resource>';
  linked([{ name: 'a', body: res + TREE }, { name: 'b', body: res + TREE }, { name: 'c', body: TREE }], linkWith('<p data-sn-text="other.title"></p>'));
});

test('a choice among many components: the cache keys stay short', () => {
  const names = Array.from({ length: 30 }, (_, i) => `x-k${i}`);
  const many: Record<string, string> = {};
  for (const n of names) many[n] = `<template data-sn-props="{ node: any }"><b><i data-sn-text="node.value"></i><sn-component use="${JSON.stringify(Object.fromEntries(names.map((m) => [m, m]))).replace(/"/g, "'")}[node.type]" data-sn-with="{ node: node.next }"></sn-component></b></template>`;
  const body = `<template data-sn-for="n in doc.children"><sn-component use="${JSON.stringify(Object.fromEntries(names.map((m) => [m, m]))).replace(/"/g, "'")}[n.type]" data-sn-with="{ node: n }"></sn-component></template>`;
  const definitions = linked([{ name: 'a', body }, { name: 'b', body }, { name: 'c', body }], many);
  // (a key names the definitions before it by their short ids: nested, 30 of them would be megabytes)
  expect(Math.max(...[...definitions.keys()].map((k) => k.length))).toBeLessThan(2_000);
}, 60_000);

test('a diagnostic in a definition names the page it is reported on', () => {
  linked([{ name: 'a', body: TREE }, { name: 'b', body: TREE }, { name: 'c', body: TREE }], linkWith('<p data-sn-text="node.missing.deeply" data-sn-bogus="1"></p>'));
});
