// Linking (docs/proposals/compile-once.md, (5)), the fifth review: `Rec.hand` (fd3c4fb), which copies only the page's
// objects a unit is handed. One scenario per finding, as in link-review-4.test.ts: pages compile in order through one
// cache of shared definitions, three rounds (seen, recorded, linked), and each must be what it is compiled on its own.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const INL = "{ text: 'x-text', link: 'x-link' }";
const BASE: Record<string, string> = {
  'x-doc': `<template data-sn-component="{ doc: any }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></div></template>`,
  'x-text': '<template data-sn-component="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': `<template data-sn-component="{ node: any }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></a></template>`,
};
const textWith = (extra: string) => ({ 'x-text': `<template data-sn-component="{ node: any }"><span class="tx"><span data-sn-text="node.value"></span>${extra}</span></template>` });
const tree = (name: string, extra = '', decl = '') => ({ [name]: `<template data-sn-component="{ node: any }"${decl}><div><span data-sn-text="node.v"></span>${extra}<template data-sn-for="k in node.kids"><${name} data-sn-prop="{ node: k }"></${name}></template></div></template>` });
const use = (name: string) => `<${name} data-sn-prop="{ node: doc }"></${name}>`;
const TREE = '<x-doc data-sn-prop="{ doc }"></x-doc>';
const DOC = '<sn-resource name="doc" src="/api/doc"></sn-resource>';

type Page = { name: string; body?: string; res?: string; head?: string; html?: string; opts?: Record<string, unknown> };
type Stats = { hits: number; recorded: number; refused: string[] };
const text = (r: unknown) => JSON.stringify(r, (_, v) => (typeof v === 'function' ? '[fn]' : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v), 1);
function build(page: Page, components: Record<string, string>, definitions?: Map<string, unknown>, files0: Record<string, string> = {}) {
  const files: Record<string, string> = { ...files0 };
  for (const [k, s] of Object.entries(components)) files[`/p/src/components/${k}.html`] = s;
  return compile(page.html ?? `<!doctype html><html lang="en"><head>${page.head ?? ''}</head><body>${page.res ?? DOC}${page.body ?? TREE}</body></html>`, {
    file: `/p/${page.name}.html`, root: '/p', dev: false, prerender: true, componentNames: Object.keys(components),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
    ...page.opts, ...(definitions ? { definitions } : {}),
  });
}
function linked(pages: Page[], more: Record<string, string> = {}, files: Record<string, string> = {}, rounds = 3) {
  const components = { ...BASE, ...more }, definitions = new Map<string, unknown>();
  for (const p of pages) expect(build(p, components, undefined, files).diagnostics.filter((d) => d.code === 'SN312'), `${p.name}: the scenario's components compile`).toEqual([]);
  for (let round = 0; round < rounds; round++) for (const p of pages) {
    let got: ReturnType<typeof build>;
    expect(() => { got = build(p, components, definitions, files); }, `${p.name}, round ${round}: linking threw`).not.toThrow();
    expect(text(got!), `${p.name}, round ${round}`).toEqual(text(build(p, components, undefined, files)));
  }
}
function hits(pages: Page[], more: Record<string, string> = {}, files: Record<string, string> = {}, rounds = 3): Array<[string, number, string[]]> {
  const components = { ...BASE, ...more }, definitions = new Map<string, unknown>(), g = globalThis as { __snLink?: Stats }, was = g.__snLink, out: Array<[string, number, string[]]> = [];
  try {
    for (let round = 0; round < rounds; round++) for (const p of pages) { g.__snLink = { hits: 0, recorded: 0, refused: [] }; build(p, components, definitions, files); out.push([p.name, g.__snLink.hits, g.__snLink.refused]); }
  } finally { g.__snLink = was; }
  return out;
}
const abc = (ab: Partial<Page>, c: Partial<Page> = ab): Page[] => [{ name: 'a', ...ab }, { name: 'b', ...ab }, { name: 'c', ...c }];




// ---- 1. a table inside a table of the page (`defAttrs.get(rt)`: a Map) that the unit writes back where it found it
//         (compile.ts `pointAttrs`: `const keys = this.defAttrs.get(rt) ?? new Map(); this.defAttrs.set(rt, keys)`).
//         The unit gets a wrapper (link.ts `LoggedMap.value`: `wrap(v, ...)`), which is never handed (`Rec.hand` is
//         for what is not a container), so the page's own map is not `old`: the plan's traversal copies it, with what
//         the recording page had in it, and a page that links the plan gets that copy in place of its own map.
//         Here the page's own `<sn-component>` passes a class to `x-text` before the tree; `x-link` (the unit) uses
//         `x-text` again. The page linked into (`c`) binds the class `pa` (the recording page's) where it passes `pc`.
//         Before fd3c4fb the map was `old` (the full `reach`) and the plan named it by its path (`defAttrs[$p0]`).
describe('1. a page table inside a table, set again by the unit (`defAttrs`): the page linked into gets the recording page\'s', () => {
  const more = { 'x-wrap': `<template data-sn-component="{ node: any }"><sn-component use="{ text: 'x-text' }[node.type]" data-sn-prop="{ node }"></sn-component></template>` };
  const own = (cls: string) => `<x-wrap class="${cls}" data-sn-prop="{ node: doc }"></x-wrap>`;
  test('1a. the pages pass different classes to `x-text` before the tree', () => { linked(abc({ body: own('pa') + TREE }, { body: own('pc') + TREE }), more); });
  test('(the same class on each: alike)', () => { linked(abc({ body: own('pa') + TREE }), more); });
});

// ---- 2. a place the page wrote a function at, read from the unit's copy of the numbering (`fnAt`, link.ts
//         `UNIT_NUMBERING`: the child gets a copy of the list, holding the page's own sites), never handed. A form that
//         reads `$error` wraps its state's function and keeps `fnAt[state]` as the wrapped part's site (compile.ts
//         `element`: `parts: [{ code: init, site: this.fnAt[node.state!] }]`). Where the page made that function before
//         the unit (the same state on the page), the site is the page's: it is not `old`, so the traversal copies it and
//         walks from its element through the page's whole document, until it meets the root of the fragment the unit is
//         compiled in and refuses ("refers to an object of the page that has no key (Object: #document-fragment)").
//         No page differs, and none links. Before fd3c4fb the site was `old`, named by its path (`codeAt[<code>]`),
//         and the pages linked. (With a source map the unit's `fn()` looks the code up in `codeAt`, which hands it.)
describe('2. a site of the page read from the unit\'s copy of `fnAt` (a state the page made first, wrapped for `$error`)', () => {
  const more = textWith('<form data-sn-state="{ t: doc.t }"><b data-sn-text="$error"></b><i data-sn-text="t"></i></form>');
  const pages = abc({ body: '<p data-sn-state="{ t: doc.t }"><i data-sn-text="t"></i></p>' + TREE });
  test('2a. the pages are as compiled on their own', () => { linked(pages, more); });
  test('2b. and they link (they did at 6fba1af)', () => {
    const got = hits(pages, more);
    expect(got.flatMap(([, , refused]) => refused), 'nothing refused').toEqual([]);
    expect(got.slice(2).map(([, n]) => n), 'linked from the third page on').toEqual([2, 2, 2, 2, 2, 2, 2]);
  });
});
