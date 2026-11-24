// Linking (docs/proposals/compile-once.md, (5)), the third review: one scenario per finding, as in link-review-2.test.ts.
// Pages compile in order through one cache of shared definitions, three rounds (seen, recorded, linked), and each must be
// what it is compiled on its own, the whole result (files, the source map, the diagnostics). Its findings 1–3 (names
// renumbered) are gone with renumbering: a plan links only into a page numbered as its recording page was. The pages of
// those scenarios are numbered otherwise, so they compile in place, or link plans of their own. The last group checks
// that linking happens where it should.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

// (stage 5, B1, takes a page's second pass from its first pass's walk where it can: these tests count what the linker
// links in each pass, so they run with B1 off, as units.test.ts does; test/compiler/from-walk.test.ts compares B1 with
// the old route)
const walk = process.env.SN_FROM_WALK;
beforeAll(() => { process.env.SN_FROM_WALK = '0'; });
afterAll(() => { if (walk === undefined) delete process.env.SN_FROM_WALK; else process.env.SN_FROM_WALK = walk; });

const INL = "{ text: 'x-text', link: 'x-link' }";
const BASE: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': `<template data-sn-props="{ node: any }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></a></template>`,
};
/** `x-text` (the first definition a page needs) with `extra` inside its one root */
const textWith = (extra: string) => ({ 'x-text': `<template data-sn-props="{ node: any }"><span class="tx"><span data-sn-text="node.value"></span>${extra}</span></template>` });
/** a component used inside itself (one definition, no other read by it), with `extra` inside its one root */
const tree = (name: string, extra = '', decl = '') => ({ [name]: `<template data-sn-props="{ node: any }"${decl}><div><span data-sn-text="node.v"></span>${extra}<template data-sn-for="k in node.kids"><${name} data-sn-with="{ node: k }"></${name}></template></div></template>` });
const use = (name: string) => `<${name} data-sn-with="{ node: doc }"></${name}>`;
const TREE = '<x-doc data-sn-with="{ doc }"></x-doc>';
const DOC = '<sn-resource name="doc" src="/api/doc"></sn-resource>';
/** `n` loops, one inside the other: `n` templates of the page's own, one bound node */
const loops = (n: number) => '<ul>' + Array.from({ length: n }, (_, i) => `<template data-sn-for="x${i} in ${i ? `x${i - 1}` : 'doc'}.a"><li data-sn-text="x${i}.q"></li>`).join('') + '</template>'.repeat(n) + '</ul>';

type Page = { name: string; body?: string; res?: string; opts?: Record<string, unknown> };
type Stats = { hits: number; recorded: number; refused: string[] };
const text = (r: unknown) => JSON.stringify(r, (_, v) => (typeof v === 'function' ? '[fn]' : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v), 1);
function build(page: Page, components: Record<string, string>, definitions?: Map<string, unknown>) {
  const files: Record<string, string> = {};
  for (const [k, s] of Object.entries(components)) files[`/p/src/components/${k}.html`] = s;
  return compile(`<!doctype html><html lang="en"><head></head><body>${page.res ?? DOC}${page.body ?? TREE}</body></html>`, {
    file: `/p/${page.name}.html`, root: '/p', dev: false, prerender: true, componentNames: Object.keys(components),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
    ...page.opts, ...(definitions ? { definitions } : {}),
  });
}
/** each page, in order, through one cache, three rounds: each must be what it is compiled on its own, every field */
function linked(pages: Page[], more: Record<string, string> = {}) {
  const components = { ...BASE, ...more }, definitions = new Map<string, unknown>();
  for (const p of pages) expect(build(p, components).diagnostics.filter((d) => d.code === 'SN312'), `${p.name}: the scenario's components compile`).toEqual([]);
  for (let round = 0; round < 3; round++) for (const p of pages) {
    let got: ReturnType<typeof build>;
    expect(() => { got = build(p, components, definitions); }, `${p.name}, round ${round}: linking threw`).not.toThrow();
    expect(text(got!), `${p.name}, round ${round}`).toEqual(text(build(p, components)));
  }
}
/** the same, counting what linking did (the compiler's own counters, as the audit reads them): `[page, definitions linked into it]` per compile */
function hits(pages: Page[], more: Record<string, string> = {}, rounds = 3): Array<[string, number]> {
  const components = { ...BASE, ...more }, definitions = new Map<string, unknown>(), g = globalThis as { __snLink?: Stats }, was = g.__snLink, out: Array<[string, number]> = [];
  try {
    for (let round = 0; round < rounds; round++) for (const p of pages) { g.__snLink = { hits: 0, recorded: 0, refused: [] }; build(p, components, definitions); out.push([p.name, g.__snLink.hits]); }
  } finally { g.__snLink = was; }
  return out;
}
/** pages `a` and `b` alike (seen, recorded), `c` the page linked into */
const abc = (ab: Partial<Page>, c: Partial<Page> = ab): Page[] => [{ name: 'a', ...ab }, { name: 'b', ...ab }, { name: 'c', ...c }];

// ---- 1. text that is alike in both compiles and looks like a name of an earlier definition's template is renumbered,
//         the user's own text too (link.ts `merge`: `alike`, `EARLIER`). The second review's 6a/6b put such text in the
//         first definition, where there is no earlier one. Here `x-ta` is templates 2 and 3 where recorded (one loop
//         before it) and 4 and 5 where linked (three loops), and `x-tb` says "US$2": the linked page says "US$4".

describe('1. the user\'s text in a later definition, where it reads as a name of an earlier one', () => {
  const two = (extra: string) => ({ ...tree('x-ta'), ...tree('x-tb', extra) });
  const pages = abc({ body: loops(1) + use('x-ta') + use('x-tb') }, { body: loops(3) + use('x-ta') + use('x-tb') });
  test('1a. a price in the markup: `US$2`', () => { linked(pages, two('<p>costs US$2 today</p>')); });
  test('1b. the same in an attribute and in a string of an expression', () => { linked(pages, two('<p title="A$3">x</p><i data-sn-text="\'US$2 \' + node.v"></i>')); });
  test('1c. text that says `sn-t-2`, `$p2`, `$i3`', () => { linked(pages, two('<p>see sn-t-2, $p2 and $i3</p>')); });
});

// ---- 2. a use id inside a string is not renumbered: the shadow compile offsets templates and states only, so a use id
//         is alike in both compiles and stays as recorded (compile.ts `addSources('@ev:<use id>:<event>')`, `detailSource`;
//         link.ts `runUnit`: no offset for `useIds`). Recorded where the definition of `x-ta` is use 1, linked where it is
//         use 3 and use 1 is `<x-quiet>`, whose `pick` nothing emits: the linked page takes `x-ta`'s `emit('pick', o)` for
//         the source of `x-quiet`'s event, compiles `remove(["other"], …)` and loses SN317.

test('2. `emit()` in a definition, linked into a page whose uses are numbered otherwise', () => {
  const RES = DOC + '<sn-resource name="other" src="/api/other" key="id"></sn-resource>';
  const used = '<ul><template data-sn-for="z in other"><li data-sn-text="z.t"></li></template></ul>';
  const more = {
    ...tree('x-ta', '<template data-sn-for="o in other"><button data-sn-on-click="emit(\'pick\', o)">p</button></template>', ' data-sn-emits="{ pick: any }"'),
    'x-box': '<template data-sn-props="{ t: string }"><section><h2 data-sn-text="t"></h2><slot></slot></section></template>',
    'x-quiet': '<template data-sn-props="{ t: string }" data-sn-emits="{ pick: any }"><p data-sn-text="t"></p></template>',
  };
  // (four bound nodes before the tree on every page)
  const plain = '<b data-sn-text="doc.z1"></b><b data-sn-text="doc.z2"></b><b data-sn-text="doc.z3"></b>';
  const quiet = '<x-box data-sn-with="{ t: doc.title }"><i>q</i></x-box><x-quiet data-sn-with="{ t: doc.title }" data-sn-on-pick="remove($event.detail)"></x-quiet><b data-sn-text="doc.z3"></b>';
  linked(abc({ res: RES, body: used + plain + use('x-ta') }, { res: RES, body: used + quiet + use('x-ta') }), more);
});

// ---- 3. a key that names an earlier definition's template, in the path of a write or in a read, is not renumbered
//         (link.ts `merge`: `alike` is applied to values, not to `target.path`, `Read.at` or `Read.key`; `replay`: `follow`).
//         `x-tc` passes `class="hot"` to the definition of `x-tb` through `defAttrs.get('$p5')`. Recorded where `x-ta` is
//         template 2 and `x-tb` 5; linked where three more loops come first, `$p5` is `x-ta`: the classes land on the
//         root of `x-ta`. (Where the key names no definition the unit is not linked, which is why the tree of the other
//         two reviews links only its first definition on a page numbered otherwise.)

test('3. attributes passed to an earlier definition, on a page where its template\'s name is another definition\'s', () => {
  const more = {
    ...tree('x-ta'), ...tree('x-tb'),
    'x-wrapb': '<template data-sn-props="{ node: any }"><sn-component use="{ b: \'x-tb\' }[node.type]" data-sn-with="{ node: node }"></sn-component></template>',
    'x-tc': '<template data-sn-props="{ node: any }"><p><x-wrapb class="hot" data-sn-class="{ on: node.on }" data-sn-with="{ node: node }"></x-wrapb></p></template>',
    'x-docc': '<template data-sn-props="{ doc: any }"><div><template data-sn-for="n in doc.children"><sn-component use="{ c: \'x-tc\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>',
  };
  const three = use('x-ta') + use('x-tb') + '<x-docc data-sn-with="{ doc }"></x-docc>';
  linked(abc({ body: loops(1) + three }, { body: loops(4) + three }), more);
});

// ---- 4. the page that records, compiled as a unit, is not the page compiled in place: a function handed out with a
//         site of its own, whose code a later attribute of the same definition writes too, gets the later attribute's
//         place in the source map (link.ts `runUnit`: the loop over `c.fns` after the unit's `codeAt` is merged into the
//         page's; in place, `fn()` asks `codeAt` when the function is made, before the later attribute wrote it).
//         A `<form>` that reads `$error` makes `($) => ({ $error: null })` at the form; the `data-sn-state` after it is
//         the same code.

test('4. source maps: the recording page, a function made before its code was written by an attribute', () => {
  linked(abc({ opts: { sourcemap: true } }), textWith('<form><b data-sn-text="$error"></b></form><span data-sn-state="{ $error: null }"><i data-sn-text="$error"></i></span>'));
});

// ---- 5. recorded on a page at the root, linked into a page in a folder: the page's file name alone (`basename`: an
//         origin's `chain`, "included from b.html:1") gets the folder too. At the root the shadow's file is
//         `snLinkShadowDir` + `` + `snLinkShadowStem` + `b.html` in one path segment, so its base name carries both marks
//         (link.ts `recordChild`: `shadowFile`; `merge`: `text`).

test('5. a diagnostic in a definition: recorded at the root, linked in a folder', () => {
  linked([{ name: 'a' }, { name: 'b' }, { name: 'blog/c' }], textWith('<p data-sn-bogus="1">x</p>'));
});

// ---- Linking that never happens. None of these is a difference in a page; each is why a scenario that should exercise
//      the linker compiles in place instead (and passes).

describe('linking happens where it should (no page differs)', () => {
  test('a. pages numbered otherwise before the tree: each kind links a plan of its own, after two of its pages', () => {
    const more = '<b data-sn-text="doc.t"></b>' + TREE;
    const got = hits([{ name: 'a' }, { name: 'b' }, { name: 'c', body: more }, { name: 'd', body: more }]);
    // (round 1: a seen, b recorded, c seen, d recorded; then every page links both definitions)
    expect(got.map(([, n]) => n)).toEqual([0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2]);
  });

  test('b. a definition that loops over a page resource links (a read of what it changed after is not a precondition)', () => {
    const res = DOC + '<sn-resource name="other" src="/api/other"></sn-resource>';
    const got = hits(abc({ res }), textWith('<template data-sn-for="o in other"><i data-sn-text="o.t"></i></template>'));
    expect(got.slice(3).map(([, n]) => n), 'rounds 2 and 3, the same three pages').toEqual([2, 2, 2, 2, 2, 2]);
  });

  test('c. a definition first seen on a page that links another one is recorded there', () => {
    const more = { ...tree('x-ta'), ...tree('x-tb') };
    const got = hits([{ name: 'p1', body: use('x-ta') }, ...['q1', 'q2', 'q3', 'q4'].map((name) => ({ name, body: use('x-ta') + use('x-tb') }))], more);
    expect(got.at(-1)![1], 'the last page, third round: both definitions').toBe(2);
  });

  test('d. pages in other folders link what one recorded, each as compiled on its own (its file, where it is named, its own)', () => {
    const pages: Page[] = [{ name: 'a' }, { name: 'b' }, { name: 'blog/c' }, { name: 'blog/deep/d' }];
    linked(pages);
    expect(hits(pages).slice(-2).map(([, n]) => n)).toEqual([2, 2]);
  });
});
