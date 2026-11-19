// Linking (docs/proposals/compile-once.md, (5)), the second review: one scenario per finding, as in link-review.test.ts.
// Pages compile in order through one cache of shared definitions, three rounds (seen, recorded, linked), and each must be
// what it is compiled on its own, the whole result (files, the source map, the diagnostics).
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const INL = "{ text: 'x-text', link: 'x-link' }";
const BASE: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': `<template data-sn-props="{ node: any }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></a></template>`,
};
/** `x-text` (the first definition a page needs) with `extra` inside its one root */
const textWith = (extra: string) => ({ 'x-text': `<template data-sn-props="{ node: any }"><span class="tx"><span data-sn-text="node.value"></span>${extra}</span></template>` });
const TREE = '<x-doc data-sn-with="{ doc }"></x-doc>';
const DOC = '<sn-resource name="doc" src="/api/doc"></sn-resource>';

type Page = { name: string; body?: string; res?: string; opts?: Record<string, unknown> };
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
/** pages `a` and `b` alike (seen, recorded), `c` the page linked into */
const abc = (ab: Partial<Page>, c: Partial<Page> = ab): Page[] => [{ name: 'a', ...ab }, { name: 'b', ...ab }, { name: 'c', ...c }];

// ---- 1. the recording page's file name is replaced wherever it occurs in a string (link.ts `named`, `keep`'s `enc`)

test('1a. text, an href and a string in an expression that contain the recording page\'s file name (`b.html`)', () => {
  linked(abc({}), textWith('<p>see club.html</p><a href="/club.html">club</a><i data-sn-text="node.value + \'b.html\'"></i>'));
});

test('1b. a page named as a component file ends (`text.html`, `x-text.html`): the linked page\'s `files` name a file that is not there', () => {
  linked([{ name: 'home' }, { name: 'text' }, { name: 'about' }]);
});

// ---- 2. a plain object got from one of the page's tables is read freely: only the key's presence is a precondition
//         (link.ts `LoggedMap.value`, `look`)

const other = (attrs: string) => DOC + `<sn-resource name="other" src="/api/other" ${attrs}></sn-resource>`;
const rows = '<template data-sn-for="o in other"><i data-sn-text="o.t"></i></template>';

test('2a. a definition loops over a page resource: recorded where it has no `key`, linked where it has one', () => {
  linked(abc({ res: other('') }, { res: other('key="slug"') }), textWith(rows));
});

test('2b. `page(\'other\', 3)` in a definition: recorded where the resource has `offset-param`, linked where it has not (SN304 is lost)', () => {
  const pg = 'key="id" paginate="keyset" page-size="10" cursor="{ after: $last.id }"';
  linked(abc({ res: other(`${pg} offset-param="o"`) }, { res: other(pg) }), textWith('<button data-sn-on-click="page(\'other\', 3)">3</button>'));
});

test('2c. `run(\'save\')` in a definition: `#save` carries an action on the recording page and none on the linked one (SN311 is lost), and the other way round (SN311 is invented)', () => {
  const action = TREE + '<button id="save" data-sn-post="/api/s">s</button>', none = TREE + '<button id="save" data-sn-on-click="refresh(\'doc\')">s</button>';
  const run = textWith('<button data-sn-on-click="run(\'save\')">go</button>');
  linked(abc({ body: action }, { body: none }), run);
  linked(abc({ body: none }, { body: action }), run);
});

// ---- 3. an object of the page a unit refers to is found again by its position in a list (link.ts `paths`, `follow`)

test('3. the same two resources declared in another order: the loop gets the key fields of the wrong resource', () => {
  const doc = '<sn-resource name="doc" src="/api/doc" key="a"></sn-resource>', oth = '<sn-resource name="other" src="/api/other" key="id"></sn-resource>';
  linked(abc({ res: doc + oth }, { res: oth + doc }), textWith(rows));
});

// ---- 4. a function the recording page had already: its site is not in the plan, and `replay` hands it out with none

test('4. source maps: an expression the recording page compiled before the definition (its `<title>`), new on the linked page', () => {
  const components = { ...BASE, ...textWith('<b data-sn-text="doc.title"></b>') }, definitions = new Map<string, unknown>();
  const files: Record<string, string> = {};
  for (const [k, s] of Object.entries(components)) files[`/p/src/components/${k}.html`] = s;
  const run = (name: string, head: string, before: string, d?: Map<string, unknown>) => compile(`<!doctype html><html lang="en"><head>${head}</head><body>${DOC}${before}${TREE}</body></html>`, {
    file: `/p/${name}.html`, root: '/p', dev: false, prerender: true, sourcemap: true, componentNames: Object.keys(components),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); }, ...(d ? { definitions: d } : {}),
  });
  // (the linked page has a list where the others have a bound `<title>`: one bound node before the tree on each)
  const T = '<title data-sn-text="doc.title">t</title>', LIST = '<ul><template data-sn-for="x in doc.a"><li data-sn-text="x.q"></li></template></ul>';
  run('a', T, '', definitions); run('b', T, '', definitions);
  const got = run('c', '', LIST, definitions), want = run('c', '', LIST);
  expect(got.module).toEqual(want.module);
  expect(got.map).toEqual(want.map);
});

// ---- 5. the recording page itself: a check a unit leaves for the end of the page reports through the unit's compiler,
//         whose tables are gone by then (compile.ts `urlBinds`, `page.urlWrites`; link.ts `recordChild`)

test('5a. `$url.tags` bound as one value in a definition and as a list on the page: SN210 is lost on the page that records', () => {
  linked(abc({ body: TREE + '<input type="checkbox" value="a" data-sn-model="$url.tags">' }), textWith('<input data-sn-model="$url.tags">'));
});

test('5b. `$url.tags` tested as a condition in a definition, a list on the page: SN211 is lost on the page that records', () => {
  linked(abc({ body: TREE + '<input type="checkbox" value="a" data-sn-model="$url.tags">' }), textWith('<b data-sn-text="$url.tags ? 1 : 0"></b>'));
});

// ---- 6. the renamer renames the user's own names: any identifier `…$<n>` and any `$p<n>`, `sn-t-<n>` in markup whose
//         number is a template of the unit. Usually hidden: the component's source is among the plan's strings, the
//         tokenizer rejects it as code and the unit is not linked; not when the source reads as tokens (no end tags), or
//         does not show the name (a character reference)

const loop1 = '<ul><template data-sn-for="x in doc.a"><li data-sn-text="x.q"></li></template></ul>';
const loop3 = '<ul><template data-sn-for="x in doc.a"><li><template data-sn-for="y in x.b"><i data-sn-text="y.c"></i><template data-sn-if="y.d"><b data-sn-text="y.e"></b></template></template></li></template></ul>';

test('6a. a property named `v$2` in a definition whose template is number 2 where recorded and 4 where linked', () => {
  linked(abc({ body: loop1 + TREE }, { body: loop3 + TREE }), { 'x-text': '<template data-sn-props="{ node: any }"><p class="tx" data-sn-text="node.v$1 + node.v$2 + node.v$3">' });
});

test('6b. text and an attribute that say `$p2` and `sn-t-2` (written with a character reference)', () => {
  linked(abc({ body: loop1 + TREE }, { body: loop3 + TREE }), { 'x-text': '<template data-sn-props="{ node: any }"><p class="tx" title="&#36;p2 sn-t&#45;2"><b data-sn-text="node.v"></b>&#36;p2 each</p></template>' });
});
