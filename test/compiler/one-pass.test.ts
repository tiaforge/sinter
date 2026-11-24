// Stage 3 (docs/proposals/redesign-notes/stage3-one-pass.md): a template's entries start their second pass from a copy
// of the template's expanded tree, kept with its first pass (`keptExpansion`), instead of parsing and expanding the page
// again. Each case is compiled with the route on and off (`SN_ONE_PASS=0`): the results must be the same, every field,
// and the test says which route each second pass took (`PASS_STATS`), or why it parsed the page again.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { compile, type CompileOptions, type CompileResult } from '../../src/compiler/index.js';
import { PASS_STATS } from '../../src/compiler/compile.js';

const C: Record<string, string> = {
  'x-doc': '<template data-sn-props="{ doc: any }"><div class="doc"><template data-sn-for="n in doc.children"><sn-component use="{ text: \'x-text\', link: \'x-link\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>',
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': '<template data-sn-props="{ node: any }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="{ text: \'x-text\', link: \'x-link\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></a></template>',
  'x-card': '<template data-sn-props="{ t: string }"><article><h2 data-sn-text="t"></h2><slot></slot></article></template><style>article { margin: 0 }</style>',
  'x-count': '<template><div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></div></template>',
};
const DOCS: Record<string, unknown> = {
  one: { children: [{ type: 'text', value: 'plain' }] },
  two: { children: [{ type: 'link', url: '/a', children: [{ type: 'text', value: 'a' }, { type: 'link', url: '/b', children: [{ type: 'text', value: 'b' }] }] }] },
  three: { children: [] },
};

function options(extra: Partial<CompileOptions> = {}): CompileOptions {
  const files: Record<string, string> = {};
  for (const [k, s] of Object.entries(C)) files[`/p/src/components/${k}.html`] = s;
  for (const [k, d] of Object.entries(DOCS)) files[`/p/content/docs/${k}.json`] = JSON.stringify({ slug: k, title: `The ${k}`, doc: d });
  return {
    file: '/p/blog/post.html', root: '/p', dev: false, prerender: true, componentNames: Object.keys(C),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (f) => { if (f in files) return files[f]!; throw new Error(f); },
    listFiles: (d) => Object.keys(files).filter((f) => f.startsWith(d.replace(/\/$/, '') + '/')),
    ...extra,
  };
}
const text = (r: CompileResult) => JSON.stringify({ ...r, check: undefined }, (_, v) => (typeof v === 'function' ? '[fn]' : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v));
const template = (body: string, head = '<title data-sn-text="d.title"></title>') => `<!doctype html><html lang="en" data-sn-path="/blog/:slug" data-sn-for="d in docs"><head>${head}</head><body><sn-resource name="docs" src="file:/content/docs/*.json"></sn-resource>${body}</body></html>`;

const saved = { one: process.env.SN_ONE_PASS, audit: process.env.SN_ONE_PASS_AUDIT, walk: process.env.SN_FROM_WALK };
// (stage 5, B1, takes a template's entries and a page of its own from their first pass's walk where it can: this file is
// about the routes before it, so it is off here; test/compiler/from-walk.test.ts has it on)
beforeEach(() => { process.env.SN_FROM_WALK = '0'; });
afterEach(() => {
  if (saved.walk === undefined) delete process.env.SN_FROM_WALK; else process.env.SN_FROM_WALK = saved.walk;
  for (const [k, v] of [['SN_ONE_PASS', saved.one], ['SN_ONE_PASS_AUDIT', saved.audit]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

/** the routes compiling `f` took: second passes from a kept expansion, and the reasons of those that parsed the page again */
function routes<T>(f: () => T): { result: T; kept: number; again: Record<string, number> } {
  const env = ['SN_LINK_AUDIT', 'SN_RENDER_AUDIT', 'SN_UNITS_SHIFT_AUDIT'].map((k) => [k, process.env[k]] as const);
  for (const [k] of env) delete process.env[k];
  try {
    const kept = PASS_STATS.kept, before = new Map(PASS_STATS.again);
    const result = f();
    const again: Record<string, number> = {};
    for (const [k, n] of PASS_STATS.again) if (n > (before.get(k) ?? 0)) again[k] = n - (before.get(k) ?? 0);
    return { result, kept: PASS_STATS.kept - kept, again };
  } finally { for (const [k, v] of env) if (v !== undefined) process.env[k] = v; }
}

/** every entry of a template compiled with the route off and on (a kept template each way): the same; the routes taken */
function entries(html: string, extra: Partial<CompileOptions> = {}) {
  const o = options(extra);
  const list = compile(html, o).pages!.entries;
  expect(list.length).toBeGreaterThan(0);
  process.env.SN_ONE_PASS = '0';
  const offTemplates = new Map();
  const off = list.map((e) => compile(html, { ...o, page: e, templates: offTemplates }));
  delete process.env.SN_ONE_PASS;
  const templates = new Map();
  const on = routes(() => list.map((e) => compile(html, { ...o, page: e, templates })));
  on.result.forEach((r, i) => expect(text(r)).toBe(text(off[i]!)));
  return { out: on.result, kept: on.kept, again: on.again, n: list.length };
}

describe('a template\'s entries: the second pass from the kept expansion', () => {
  test('a tree over constants, rendered per entry', () => {
    const r = entries(template('<main><h1 data-sn-text="d.title"></h1><x-doc data-sn-with="{ doc: d.doc }"></x-doc></main>'));
    expect(r.kept).toBe(r.n);
    expect(r.again).toEqual({});
    expect(r.out.map((x) => x.html).join('')).toContain('<a href="/a">');
  });

  test('a page with live parts beside the rendered rows (state, a handler, scoped styles, slot content)', () => {
    const r = entries(template('<x-card data-sn-with="{ t: d.title }"><x-doc data-sn-with="{ doc: d.doc }"></x-doc></x-card><x-count></x-count><p data-sn-state="{ k: 1 }" data-sn-text="d.slug + k"></p>'));
    expect(r.kept).toBe(r.n);
    expect(r.out[0]!.html).toContain('data-sn=');
  });

  test('a layout and a decided branch at the top', () => {
    const files = { '/p/src/layouts/base-page.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><header>h</header><slot></slot></body></html>' };
    const o = options();
    const read = o.readFile;
    const html = '<base-page data-sn-path="/blog/:slug" data-sn-for="d in docs"><sn-resource name="docs" src="file:/content/docs/*.json"></sn-resource><template data-sn-if="d.doc.children.length"><x-doc data-sn-with="{ doc: d.doc }"></x-doc></template><template data-sn-else><p>empty</p></template></base-page>';
    const r = entries(html, { readFile: (f) => (f in files ? files[f as keyof typeof files] : read(f)) });
    expect(r.kept).toBe(r.n);
    expect(r.out.map((x) => x.html).join('')).toContain('<p>empty</p>');
  });
});

describe('second passes that parse and expand the page again, counted by reason', () => {
  test('the route off (`SN_ONE_PASS=0`)', () => {
    const html = template('<x-doc data-sn-with="{ doc: d.doc }"></x-doc>');
    const o = options();
    const list = compile(html, o).pages!.entries;
    process.env.SN_ONE_PASS = '0';
    const templates = new Map();
    const r = routes(() => list.map((e) => compile(html, { ...o, page: e, templates })));
    expect(r.kept).toBe(0);
    expect(r.again).toEqual({ off: list.length });
  });

  test('a page of its own (not a template\'s entry)', () => {
    const html = '<!doctype html><html><head></head><body><template data-sn-for="x in [1, 2]"><i data-sn-text="x"></i></template></body></html>';
    process.env.SN_ONE_PASS = '0';
    const off = compile(html, options({ file: '/p/index.html' }));
    delete process.env.SN_ONE_PASS;
    const r = routes(() => compile(html, options({ file: '/p/index.html' })));
    expect(text(r.result)).toBe(text(off));
    expect(r.kept).toBe(0);
    expect(r.again).toEqual({ 'a page of its own': 1 });
  });

  test('an entry its template\'s kept walk does not serve (a constant class the layout reads): compiled alone', () => {
    const html = template('<x-doc data-sn-with="{ doc: d.doc }"></x-doc><p data-sn-class="{ wide: d.slug === \'one\' }">x</p>');
    const o = options({ styles: [{ css: '.wide { display: none }' }] } as Partial<CompileOptions>);
    const list = compile(html, o).pages!.entries;
    process.env.SN_ONE_PASS = '0';
    const off = list.map((e) => compile(html, { ...o, page: e, templates: new Map() }));
    delete process.env.SN_ONE_PASS;
    const templates = new Map();
    const r = routes(() => list.map((e) => compile(html, { ...o, page: e, templates })));
    r.result.forEach((x, i) => expect(text(x)).toBe(text(off[i]!)));
    expect(r.kept).toBe(0);
    expect(r.again).toEqual({ 'an entry compiled alone': list.length });
  });

  test('an entry compiled without kept templates (`templates` not given)', () => {
    const html = template('<x-doc data-sn-with="{ doc: d.doc }"></x-doc>');
    const o = options();
    const list = compile(html, o).pages!.entries;
    const r = routes(() => list.map((e) => compile(html, { ...o, page: e })));
    expect(r.kept).toBe(0);
    expect(r.again).toEqual({ 'an entry, no kept templates': list.length });
  });

  test('under the audit (`SN_ONE_PASS_AUDIT=1`): the route compiled the old way beside it, and the same', () => {
    process.env.SN_ONE_PASS_AUDIT = '1';
    const r = entries(template('<main><h1 data-sn-text="d.title"></h1><x-doc data-sn-with="{ doc: d.doc }"></x-doc></main>'));
    expect(r.kept).toBe(r.n);
  });
});
