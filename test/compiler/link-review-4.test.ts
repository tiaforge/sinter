// Linking (docs/proposals/compile-once.md, (5)), the fourth review: one scenario per finding, as in link-review-3.test.ts.
// Pages compile in order through one cache of shared definitions, three rounds (seen, recorded, linked), and each must be
// what it is compiled on its own, the whole result. As reviewed (6fba1af), 1 and 2 were pages that differed; 3 and 4 pages
// that never linked (no page differed); 5 the cost of recording, quadratic in a page's definitions.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const INL = "{ text: 'x-text', link: 'x-link' }";
const BASE: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></div></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': `<template data-sn-props="{ node: any }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></a></template>`,
};
const textWith = (extra: string) => ({ 'x-text': `<template data-sn-props="{ node: any }"><span class="tx"><span data-sn-text="node.value"></span>${extra}</span></template>` });
const tree = (name: string, extra = '', decl = '') => ({ [name]: `<template data-sn-props="{ node: any }"${decl}><div><span data-sn-text="node.v"></span>${extra}<template data-sn-for="k in node.kids"><${name} data-sn-prop="{ node: k }"></${name}></template></div></template>` });
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



// ---- 1. a library's component, recorded on a page at the root and linked into a page in a folder: "used at" names the
//         page without its folder. A library definition's origin holds two strings of the page, `chain[0]`
//         (`<base name>:1`, compile.ts `expandUse`) and `usedAt` (`<path under the root>:1`). At the root both are
//         `b.html:1`, and `keep` tries the base-name form first (link.ts `enc`: `v.startsWith(base + ':')` before `rel`),
//         so `usedAt` is kept as a base-name place and the page in a folder gets `c.html:1` for `blog/c.html:1`. The
//         unit's own diagnostics refuse the plan (their text holds the file's name); one the page reports after the
//         walk about an element of the definition (SN317, `resolveSources`) reads the linked origin.

describe('1. a library definition recorded at the root, linked in a folder: a diagnostic after the walk says where it is used', () => {
  const LIB = { name: '@acme/ui', dir: '/lib', folder: '/lib/sinter', prefix: 'ui', public: ['ui-tree'], internal: [], types: null };
  // (`sel` is never assigned a row: SN317, reported when the page's sources are resolved)
  const files = { '/lib/sinter/components/ui-tree.html': tree('ui-tree', '<p data-sn-state="{ sel: null }"><button data-sn-on-click="remove(sel)">x</button></p>')['ui-tree']! };
  const opts = { libraries: [LIB], componentNames: [...Object.keys(BASE), 'ui-tree'] };
  const pg = (name: string): Page => ({ name, body: use('ui-tree'), opts });
  test('1a. `a.html`, `b.html`, then `blog/c.html`', () => {
    const pages = [pg('a'), pg('b'), pg('blog/c')];
    expect(hits(pages, {}, files).slice(0, 3).map(([, n]) => n), 'the page in the folder links what the root recorded').toEqual([0, 0, 1]);
    linked(pages, {}, files);
  });
  test('1b. index pages: `index.html`, `about.html`, then `blog/index.html`', () => { linked([pg('index'), pg('about'), pg('blog/index')], {}, files); });
  test('1c. the other way (recorded in a folder, linked at the root and in another folder) is right', () => { linked([pg('blog/a'), pg('blog/b'), pg('c'), pg('docs/guide/d')], {}, files); });
});

// ---- 2. source maps: a function the unit makes whose code the page wrote before it. In place, `fn()` gives it the
//         page's place (`codeAt`), and what reads `fnAt` next sees that. A unit's `codeAt` starts empty (link.ts
//         `runUnit`: `child.codeAt = new Map()`), so inside the unit `fnAt[i]` is the unit's own place until `runUnit`
//         puts the page's back after the unit is done (`hadCode`). A form that reads `$error` wraps its state's
//         function and keeps `fnAt[state]` as the wrapped part's site (compile.ts `element`: `parts: [{ code: init,
//         site: this.fnAt[node.state!] }]`) while the unit runs: the recording page's map differs from the page compiled
//         alone, and the plan keeps the recording's site for a page whose own `codeAt` says otherwise.
//         `<x-box data-sn-prop="{ t: doc.t }">` on the page writes `($) => ({ t: $.doc.t })` (no function made);
//         `<form data-sn-state="{ t: doc.t }">` in the definition is the same code.

describe('2. source maps: a state in a definition whose code the page wrote first, wrapped for `$error`', () => {
  const more = { 'x-box': '<template data-sn-props="{ t: string }"><section><h2 data-sn-text="t"></h2><slot></slot></section></template>', ...textWith('<form data-sn-state="{ t: doc.t }"><b data-sn-text="$error"></b><i data-sn-text="t"></i></form>') };
  const box = (k: string) => `<x-box data-sn-prop="{ t: doc.${k} }"><i>q</i></x-box>`;
  const opts = { sourcemap: true };
  test('2a. every page wrote it: the page that records differs', () => { linked(abc({ opts, body: box('t') + TREE }), more); });
  test('2b. only the page linked into wrote it', () => { linked(abc({ opts, body: box('u') + TREE }, { opts, body: box('t') + TREE }), more); });
  test('2c. only the pages that saw and recorded it wrote it', () => { linked(abc({ opts, body: box('t') + TREE }, { opts, body: box('u') + TREE }), more); });
  test('(without a source map the same pages are alike, and link)', () => {
    const pages = abc({ body: box('u') + TREE }, { body: box('t') + TREE });
    linked(pages, more);
    expect(hits(pages, more).slice(2).map(([, n]) => n)).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });
});

// ---- Linking that never happens (no page differs): a precondition that holds the page's own file or URL, compared as
//      text, so no other page meets it. Each kind of page pays for one recording and then compiles in place.

describe('linking happens where it should (no page differs)', () => {
  // ---- 3. every unit reads `page.locale` (link.ts: the page info's proxy logs any field read, by its `shape`), and a
  //         localized static page's `localeUrl` is code holding the page's own URLs (compile.ts, the constructor:
  //         `((l) => ({"en":"/a.html","de":"/de/a.html"})[l])`). vite.ts passes `locale.urls` for every localized page.
  test('3. localized pages (`locale.urls`, the page\'s URL in each language): four pages alike link the tree', () => {
    const pages = ['a', 'b', 'c', 'd'].map((name) => ({ name, opts: { locale: { name: 'en', base: '/', urls: { en: `/${name}.html`, de: `/de/${name}.html` } } } }));
    linked(pages);
    expect(hits(pages).slice(-4).map(([, n]) => n), 'third round').toEqual([2, 2, 2, 2]);
  });
  test('(with `urls: null` they do)', () => {
    const pages = ['a', 'b', 'c', 'd'].map((name) => ({ name, opts: { locale: { name: 'en', base: '/', urls: null } } }));
    expect(hits(pages).slice(-4).map(([, n]) => n)).toEqual([2, 2, 2, 2]);
  });

  // ---- 4. in a prerendered page's first pass every bound attribute reads the page's diagnostics whole (compile.ts `element`,
  //         `source()`: `this.diagnostics.slice(d0)`,
  //         a method of a logged list: `readValue` of all of it), and a diagnostic of the page names the page's file. So
  //         a page with one warning of its own before its first definition links nothing, and neither does any page
  //         numbered like it.
  test('4. pages with a warning of their own before the tree (the same on each): they link the tree', () => {
    const warned = '<ul><template data-sn-for="x in doc.a"><li id="dup" data-sn-text="x.t"></li></template></ul>';
    const pages = ['a', 'b', 'c', 'd'].map((name) => ({ name, body: warned + TREE }));
    expect(build(pages[0]!, BASE).diagnostics.map((d) => [d.code, d.severity]), 'the scenario: one warning').toEqual([['SN532', 'warning']]);
    linked(pages);
    expect(hits(pages).slice(-4).map(([, n]) => n), 'third round').toEqual([2, 2, 2, 2]);
  });
});

// ---- 5. the cost of recording. Each unit recorded walked the whole page before it ran (`reach` over every field, a
//         copy of every plain object, `paths` over all of it again), so a page that records every definition it has was
//         quadratic in them: 150 small definitions, 85 ms compiled alone, 2.5 s where recorded. A unit now copies the
//         page's objects as it is handed them (`Rec.hand`): what it touches, not the page.

test('5. what recording copies of the page grows with the definitions, not with the page times the definitions', () => {
  const copied = (n: number) => {
    const names = Array.from({ length: n }, (_, i) => `x-n${i}`);
    const more = Object.assign({}, ...names.map((m) => tree(m, '<b>x</b>'))) as Record<string, string>;
    const page = (name: string): Page => ({ name, body: names.map(use).join('') });
    const components = { ...BASE, ...more }, definitions = new Map<string, unknown>(), g = globalThis as { __snLink?: Stats & { copied?: number } };
    build(page('a'), components, definitions);
    const was = g.__snLink;
    g.__snLink = { hits: 0, recorded: 0, refused: [], copied: 0 };
    try { build(page('b'), components, definitions); return { recorded: g.__snLink.recorded, copied: g.__snLink.copied! }; } finally { g.__snLink = was; }
  };
  const small = copied(10), large = copied(100);
  expect([small.recorded, large.recorded]).toEqual([10, 100]);
  // (per definition, about as many on a page ten times larger: quadratic would be ten times as many)
  expect(large.copied / large.recorded, `${small.copied} objects for 10, ${large.copied} for 100`).toBeLessThan(2 * (small.copied / small.recorded) + 5);
}, 120000);
