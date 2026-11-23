// Second-pass units (docs/proposals/redesign-notes/stage5-a1.md): the definitions a page ships (its live instances
// that stay recursion points) come from a unit made once per build and placed before the second pass's walk, at numbers
// from 0. The page is what it is compiled without the unit up to numbering (its canonical form); a page that ships no
// definition places none and is byte for byte what it was. Each fallback is counted by its reason.
import { afterEach, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { UNIT_STATS } from '../../src/compiler/units.js';
import { build, PAGES } from './units-pages.js';

const env = process.env;
afterEach(() => { delete env.SN_CANON; delete env.SN_UNITS2; });
/** a page's output in its canonical numbering (`SN_CANON=1`) */
const canon = (f: () => ReturnType<typeof build>) => { env.SN_CANON = '1'; try { return f(); } finally { delete env.SN_CANON; } };
const stats = () => ({ made2: UNIT_STATS.made2, placed2: UNIT_STATS.placed2, fallback: new Map(UNIT_STATS.fallback) });
const fellBack = (before: ReturnType<typeof stats>, why: string) => (UNIT_STATS.fallback.get(`pass 2: ${why}`) ?? 0) - (before.fallback.get(`pass 2: ${why}`) ?? 0);

// (a page with a second pass: a constant tree before its live one, which the first pass decides and the second unrolls;
// a page with live parts only has no second pass, its first is its output: A2's)
const SECOND: Record<string, string> = Object.fromEntries(Object.entries(PAGES).map(([k, v]) => [k, `<x-doc data-sn-with="{ doc }"></x-doc>${v}`]));
const LIVE = ['live', 'live, a fill', 'loop and if before', 'state and a handler', 'two trees'];
const CONST = ['alone', 'a fill of its slot', 'component before'];

test('a page that ships definitions: its second pass makes a unit on the first page and places it on the next, the same up to numbering', () => {
  for (const order of [Object.keys(SECOND), Object.keys(SECOND).reverse()]) {
    const units = new Map<string, unknown>(), s = stats();
    for (let round = 0; round < 2; round++) for (const name of order) {
      const n = UNIT_STATS.made2 + UNIT_STATS.placed2;
      const through = canon(() => build(name, SECOND[name]!, units));
      expect(UNIT_STATS.made2 + UNIT_STATS.placed2 > n, `${name}: the route`).toBe(LIVE.includes(name));
      expect(through, `${name}, round ${round}`).toEqual(canon(() => build(name, SECOND[name]!)));
    }
    // one unit for the pages of one shape, a few by one key (the pages differ in what their own markup used before)
    expect(UNIT_STATS.made2 - s.made2).toBeGreaterThan(0);
    expect(UNIT_STATS.placed2 - s.placed2).toBeGreaterThanOrEqual(LIVE.length);
  }
});

test('the unit comes first: its templates and functions before the page\'s own, numbered alike on every page', () => {
  const units = new Map<string, unknown>();
  const a = build('live', SECOND.live!, units), b = build('state and a handler', SECOND['state and a handler']!, units);
  const without = build('live', SECOND.live!);
  // (the definition's props: `$p0` through the unit, the walk's number after the page's own templates without it)
  expect(a.module).not.toEqual(without.module);
  for (const r of [a, b]) expect(r.module).toMatch(/\$p0\b/);
  expect(without.module).not.toMatch(/\$p0\b/);
});

test('a page that ships no definition places no unit, and is byte for byte what it was', () => {
  const units = new Map<string, unknown>(), s = stats();
  for (let round = 0; round < 2; round++) for (const name of CONST) expect(build(name, SECOND[name]!, units), name).toEqual(build(name, SECOND[name]!));
  expect(UNIT_STATS.made2 + UNIT_STATS.placed2).toBe(s.made2 + s.placed2);
});

test('SN_UNITS2=0: the second pass compiles its definitions as before', () => {
  const units = new Map<string, unknown>(), s = stats();
  env.SN_UNITS2 = '0';
  for (const name of LIVE) expect(build(name, SECOND[name]!, units), name).toEqual(build(name, SECOND[name]!));
  expect(UNIT_STATS.made2 + UNIT_STATS.placed2).toBe(s.made2 + s.placed2);
});

test('under the type check: the same up to numbering, the first pass\'s check unit as it was', () => {
  const units = new Map<string, unknown>(), s = stats();
  for (let round = 0; round < 2; round++) for (const name of LIVE) {
    const through = canon(() => build(name, SECOND[name]!, units, true)), alone = canon(() => build(name, SECOND[name]!, undefined, true));
    expect(through, name).toEqual(alone);
  }
  expect(UNIT_STATS.placed2).toBeGreaterThan(s.placed2);
});

// fallbacks, by reason
const C2: Record<string, string> = {
  // a tree slot inside a definition's row (a loop of its own): a fill's cases hang under a template that is not the definition
  // a tree slot inside a definition's row (a loop of its own): a fill of the outer use's slot reaches the definition, and
  // its cases hang under that row, not under the definition
  'y-doc': `<template data-sn-props="{ doc: any; link: Slot<{ url: string }> }"><div><template data-sn-for="n in doc.kids"><y-item data-sn-with="{ node: n }"></y-item></template></div></template>`,
  'y-item': `<template data-sn-props="{ node: any }"><p><template data-sn-for="c in node.links"><slot name="link" data-sn-with="{ url: c.url }"><i data-sn-text="c.url"></i></slot></template><template data-sn-for="n in node.kids"><y-item data-sn-with="{ node: n }"></y-item></template></p></template>`,
  // (a choice of \`y-text\` in its own definition too: the unit makes \`y-text\`'s table of tag attributes, the page adds to it)
  'y-pick': `<template data-sn-props="{ node: any }"><sn-component use="{ text: 'y-text' }[node.type]" data-sn-with="{ node }"></sn-component></template>`,
  'y-chosen': `<template data-sn-props="{ node: any }"><p><sn-component use="{ text: 'y-text' }[node.type]" data-sn-with="{ node }"></sn-component><template data-sn-for="k in node.kids"><y-chosen data-sn-with="{ node: k }"></y-chosen></template></p></template>`,
  // a form reading \`$error\` in a definition, its state the same as one of the page's: the page made that state's function first
  'y-ftext': '<template data-sn-props="{ node: any }"><span><span data-sn-text="node.value"></span><form data-sn-state="{ t: live.t }"><b data-sn-text="$error"></b><i data-sn-text="t"></i></form></span></template>',
  'y-fchosen': `<template data-sn-props="{ node: any }"><p><sn-component use="{ text: 'y-ftext' }[node.type]" data-sn-with="{ node }"></sn-component><template data-sn-for="k in node.kids"><y-fchosen data-sn-with="{ node: k }"></y-fchosen></template></p></template>`,
  // scoped styles: their marks (`data-sn-c`) are written on each instance's root after the walk, the unit's too
  'y-card': '<template data-sn-props="{ t: string }"><b class="c"><slot></slot></b></template><style>.c { color: red }</style>',
  'y-styled': '<template data-sn-props="{ node: any }"><li class="n"><y-card data-sn-with="{ t: node.value }"><em data-sn-text="node.value"></em></y-card><ul><template data-sn-for="k in node.kids"><y-styled data-sn-with="{ node: k }"></y-styled></template></ul></li></template><style>.n { padding: 0 }</style>',
  // \`$slots\` in a component used inside itself: SN201, which its unit cannot carry
  'y-bad': `<template data-sn-props="{ node: any }"><b><template data-sn-if="$slots.x"><i>x</i></template><template data-sn-for="n in node.children"><y-bad data-sn-with="{ node: n }"></y-bad></template></b></template>`,
  'y-pill': '<template data-sn-props="{ to: string }"><a class="pill" data-sn-attr="{ href: to }"><slot></slot></a></template>',
  'y-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'y-tree': `<template data-sn-props="{ node: any }"><div><y-text data-sn-with="{ node }"></y-text><template data-sn-for="n in node.children"><y-tree data-sn-with="{ node: n }"></y-tree></template></div></template>`,
};
export function page(name: string, body: string, units?: Map<string, unknown>) {
  const files: Record<string, string> = { '/p/items.json': '[1, 2]' };
  for (const [k, s] of Object.entries(C2)) files[`/p/src/components/${k}.html`] = s;
  // (a constant loop, unrolled by a second pass)
  const out = compile(`<!doctype html><html><head></head><body><sn-resource name="live" src="/api/doc"></sn-resource><sn-resource name="items" src="file:./items.json"></sn-resource><ul><template data-sn-for="x in items"><li data-sn-text="x"></li></template></ul>${body}</body></html>`, {
    file: `/p/${name}.html`, root: '/p', dev: false, prerender: true, componentNames: Object.keys(C2),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
    ...(units ? { units } : {}),
  });
  return { html: out.html, module: out.module, runtime: out.runtime, diagnostics: out.diagnostics };
}

test('a fill whose cases hang under a unit\'s row, not its definition: compiled again without the unit (counted)', () => {
  const units = new Map<string, unknown>(), s = stats();
  const body = '<y-doc data-sn-with="{ doc: live }"><b slot="link" data-sn-text="$slot.url"></b></y-doc>';
  for (let round = 0; round < 2; round++) expect(page('rows', body, units)).toEqual(page('rows', body));
  expect(fellBack(s, 'templates of its own inside its unit\'s rows')).toBe(2);
});

test('scoped styles in what the unit compiled: the same up to numbering on every page, and no unit object left changed', () => {
  env.SN_UNITS_VERIFY = '1';
  try {
    const units = new Map<string, unknown>(), s = stats();
    const bodies = ['<ul><y-styled data-sn-with="{ node: live }"></y-styled></ul>', '<p>other</p><ul><y-styled data-sn-with="{ node: live }"></y-styled></ul>'];
    for (let round = 0; round < 2; round++) bodies.forEach((body, i) => {
      expect(canon(() => page(`s${i}`, body, units)), `page ${i}, round ${round}`).toEqual(canon(() => page(`s${i}`, body)));
      expect(page(`s${i}`, body, units).html).toContain('data-sn-c="y-styled"');
    });
    expect(UNIT_STATS.placed2 - s.placed2).toBeGreaterThanOrEqual(3);
  } finally { delete env.SN_UNITS_VERIFY; }
});

test('pages that pass other attributes to a definition\'s tag (its root binds their union, `defAttrs`): each its own', () => {
  env.SN_UNITS_VERIFY = '1';
  try {
    const units = new Map<string, unknown>(), s = stats();
    // (the class is on a tag the dispatch inside \`y-pick\` passes on to the shared definition of \`y-text\`)
    const own = (cls: string) => `<y-chosen data-sn-with="{ node: live }"></y-chosen><y-pick class="${cls}" data-sn-with="{ node: live }"></y-pick>`;
    for (let round = 0; round < 2; round++) for (const [i, cls] of ['pa', 'pb', 'pa'].entries()) {
      const body = own(cls);
      const through = canon(() => page(`d${i}`, body, units));
      expect(through, `page ${i} (${cls}), round ${round}`).toEqual(canon(() => page(`d${i}`, body)));
      expect(through.module).toContain(`c:${cls}`);
      expect(through.module).not.toContain(`c:${cls === 'pa' ? 'pb' : 'pa'}`);
    }
    expect(UNIT_STATS.placed2 - s.placed2).toBeGreaterThan(0);
  } finally { delete env.SN_UNITS_VERIFY; }
});

test('a state the page made first, wrapped for `$error` in a definition: each page its own, no unit object left changed', () => {
  env.SN_UNITS_VERIFY = '1';
  try {
    const units = new Map<string, unknown>(), s = stats();
    const body = '<p data-sn-state="{ t: live.t }"><i data-sn-text="t"></i></p><y-fchosen data-sn-with="{ node: live }"></y-fchosen>';
    for (let round = 0; round < 3; round++) for (const name of ['e0', 'e1']) expect(canon(() => page(name, body, units)), `${name}, round ${round}`).toEqual(canon(() => page(name, body)));
    expect(UNIT_STATS.placed2 - s.placed2).toBeGreaterThan(0);
  } finally { delete env.SN_UNITS_VERIFY; }
});

test('a unit that is refused (a definition that reports a diagnostic): the page compiled again without one (counted)', () => {
  const units = new Map<string, unknown>(), s = stats();
  const body = '<y-bad data-sn-with="{ node: live }"></y-bad>';
  for (let round = 0; round < 2; round++) expect(page('bad', body, units)).toEqual(page('bad', body));
  expect(fellBack(s, 'reports a diagnostic')).toBe(2);
  expect(fellBack(s, 'its unit refused')).toBe(1);
});
