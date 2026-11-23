// The first pass's evaluation, made cheaper (docs/proposals/redesign-notes/evaluation.md): what it derives from the
// program once instead of per row or per entry, a row's scope as a plain object, a choice's candidates it does not
// render recorded as one entry. Each case is compiled with rows rendered and not (`SN_RENDER=0`, where the second pass
// compiles every row with what the worklist decided, by key), and a template's entries through one kept template and
// each alone: the results must be the same, every field.
import { afterEach, describe, expect, test } from 'vitest';
import { compile, type CompileOptions, type CompileResult } from '../../src/compiler/index.js';
import { decidedEntries, failsFirst } from '../../src/compiler/compile.js';

const C: Record<string, string> = {
  'x-doc': '<template data-sn-props="{ doc: any }"><div class="doc"><template data-sn-for="n in doc.children"><sn-component use="{ text: \'x-text\', link: \'x-link\', em: \'x-em\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>',
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-em': '<template data-sn-props="{ node: any }"><em data-sn-style="{ color: node.color, \'font-weight\': node.weight, margin: null }" data-sn-attr="{ title: node.title, lang: null }" data-sn-text="node.value"></em></template>',
  'x-link': '<template data-sn-props="{ node: any }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="{ text: \'x-text\', link: \'x-link\', em: \'x-em\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></a></template>',
  'x-pick': '<template data-sn-props="{ k: string; doc: any }"><section><sn-component use="{ doc: \'x-doc\', text: \'x-text\' }[k]" data-sn-with="{ doc, node: { value: k } }"></sn-component></section></template>',
};
const DOCS: Record<string, unknown> = {
  one: { children: [{ type: 'text', value: 'plain' }, { type: 'em', value: 'e', color: 'red', weight: null, title: 't' }] },
  two: { children: [{ type: 'link', url: '/a', children: [{ type: 'text', value: 'a' }, { type: 'em', value: 'b', color: null, weight: 700 }, { type: 'link', url: '/b', children: [{ type: 'text', value: 'b' }] }] }] },
  three: { children: [] },
};
// nested lists whose rows' names shadow each other: an item and an index of every level
const GRID = { rows: [{ name: 'a', cells: [{ name: 'a1', cells: [1, 2] }, { name: 'a2', cells: [] }] }, { name: 'b', cells: [{ name: 'b1', cells: [3] }] }] };

function options(extra: Partial<CompileOptions> = {}): CompileOptions {
  const files: Record<string, string> = { '/p/grid.json': JSON.stringify(GRID), '/p/doc.json': JSON.stringify(DOCS.two) };
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
const page = (body: string) => `<!doctype html><html lang="en"><head></head><body><sn-resource name="grid" src="file:/grid.json"></sn-resource><sn-resource name="doc" src="file:/doc.json"></sn-resource>${body}</body></html>`;
const template = (body: string) => `<!doctype html><html lang="en" data-sn-path="/blog/:slug" data-sn-for="d in docs"><head><title data-sn-text="d.title"></title></head><body><sn-resource name="docs" src="file:/content/docs/*.json"></sn-resource>${body}</body></html>`;

const was = process.env.SN_RENDER;
afterEach(() => { if (was === undefined) delete process.env.SN_RENDER; else process.env.SN_RENDER = was; });

/** a page compiled with rows rendered and not: the same */
function both(html: string, extra: Partial<CompileOptions> = {}) {
  process.env.SN_RENDER = '0';
  const off = compile(html, options(extra));
  delete process.env.SN_RENDER;
  const on = compile(html, options(extra));
  expect(text(on)).toBe(text(off));
  return /<body>([\s\S]*?)<\/body>/.exec(on.html)![1]!;
}

/** every entry of a template through one kept template, and each alone (rendered and not): the same */
function entries(html: string) {
  const o = options();
  const list = compile(html, o).pages!.entries;
  expect(list.length).toBe(3);
  const alone = list.map((e) => compile(html, { ...o, page: e }));
  process.env.SN_RENDER = '0';
  const off = list.map((e) => compile(html, { ...o, page: e }));
  delete process.env.SN_RENDER;
  const templates = new Map();
  // (twice over: a kept template evaluates every entry again from what it kept)
  for (let round = 0; round < 2; round++) {
    const kept = list.map((e) => compile(html, { ...o, page: e, templates }));
    kept.forEach((r, i) => { expect(text(r)).toBe(text(alone[i]!)); expect(text(r)).toBe(text(off[i]!)); });
  }
  return alone.map((r) => /<body>([\s\S]*?)<\/body>/.exec(r.html)![1]!);
}

describe('a row\'s scope', () => {
  test('nested rows: each name is the innermost row\'s, an outer row\'s item and index read through', () => {
    const body = both(page(`<ul><template data-sn-for="(r, i) in grid.rows"><li><template data-sn-for="(r, j) in r.cells"><b data-sn-attr="{ title: i + '.' + j }" data-sn-text="r.name"></b><template data-sn-for="(c, i) in r.cells"><i data-sn-text="c + ':' + i + ':' + j"></i></template></template></li></template></ul>`));
    expect(body).toContain('<b title="0.0">a1</b><i>1:0:0</i><i>2:1:0</i><b title="0.1">a2</b>');
    expect(body).toContain('<b title="1.0">b1</b><i>3:0:0</i>');
  });
  test('a row\'s name that is a property of every object (`constructor`) is the row\'s', () => {
    const body = both(page(`<ul><template data-sn-for="constructor in grid.rows"><li data-sn-text="constructor.name"></li></template></ul>`));
    expect(body).toContain('<li>a</li><li>b</li>');
  });
});

describe('a kept template\'s program, read once for its entries (`evalProgram`)', () => {
  // (a helper the static check lets fold: its calls run at build time, per entry, through the table compiled once)
  const fold = { helpers: { module: '/h.js', names: ['shout'], namespaces: {} }, helperValues: { shout: (s: string) => s.toUpperCase() }, helperFold: new Map([['shout', { fold: true }]]) } as Partial<CompileOptions>;
  test('each entry\'s own values through the one table: a helper\'s call, a text, rows', () => {
    const html = template('<main><h1 data-sn-text="shout(d.title)"></h1><p data-sn-text="d.slug"></p><ul><template data-sn-for="n in d.doc.children"><li data-sn-text="shout(n.value ?? n.url)"></li></template></ul></main>');
    const o = options(fold);
    const list = compile(html, o).pages!.entries;
    const alone = list.map((e) => compile(html, { ...o, page: e }));
    const templates = new Map();
    for (let round = 0; round < 2; round++) list.map((e) => compile(html, { ...o, page: e, templates })).forEach((r, i) => expect(text(r)).toBe(text(alone[i]!)));
    expect(alone.map((r) => /<h1>(.*?)<\/h1>/.exec(r.html)?.[1])).toEqual(['THE ONE', 'THE THREE', 'THE TWO']);
    expect(alone[0]!.html).toContain('<li>PLAIN</li><li>E</li>');
  });
});

describe('an expression that fails at its first step (`failsFirst`)', () => {
  test('a first read of a name the evaluation never answers: a prop, the URL; not a state, a file, `$build`', () => {
    for (const c of ['($) => ($.$p12.node.style.color)', '($) => ($.$p3 ? 1 : 2)', '($) => ($.$url.q.length)', '($) => ($.$slot.node)']) expect(failsFirst(c)).toBe(true);
    for (const c of ['($) => ($.$s3.n)', '($) => ($.$r.doc)', '($) => ($.$meta.doc.loading)', '($) => ($.$build && $.$p1)', '($) => ($.$w(() => 1))', '($) => (1 + $.$p1)', '($) => (shout($.$p1))', '($) => (($.$p1))']) expect(failsFirst(c)).toBe(false);
  });
  test('a definition\'s bindings on a page of its own: what the page writes is the same', () => {
    const body = both(page('<x-doc data-sn-with="{ doc }"></x-doc><x-em data-sn-with="{ node: { value: \'v\', color: \'red\' } }"></x-em>'));
    expect(body).toContain('<em style="color: red">v</em>');
  });
});

describe('rendering a row', () => {
  test('styles and attributes written on a row\'s copy: none yet, an empty one, one there, removed', () => {
    const body = both(page(`<ul><template data-sn-for="(r, i) in grid.rows"><li><i data-sn-style="{ color: i ? 'red' : null, margin: null }">a</i><i style="" data-sn-style="{ color: null }">b</i><i style="padding: 0" data-sn-style="{ color: i ? null : 'blue', 'font-weight': 700 }">c</i><b title="x" lang="en" data-sn-attr="{ title: i ? r.name : null, lang: null, dir: null }">d</b></li></template></ul>`));
    expect(body).toContain('<li><i>a</i><i>b</i><i style="padding: 0; color: blue; font-weight: 700">c</i><b>d</b></li>');
    expect(body).toContain('<li><i style="color: red">a</i><i>b</i><i style="padding: 0; font-weight: 700">c</i><b title="b">d</b></li>');
  });
  test('a template\'s elements copied in every row, each its own (ids, uses)', () => {
    const body = both(page('<x-doc data-sn-with="{ doc }"></x-doc><x-doc data-sn-with="{ doc }"></x-doc>'));
    expect(body.split('<a href="/b"><span>b</span></a>').length).toBe(3);
  });
});

describe('choices in rows', () => {
  test('the candidates a choice does not render, at every depth, rendered and not', () => {
    const body = both(page('<x-doc data-sn-with="{ doc }"></x-doc>'));
    expect(body).toContain('<a href="/a"><span>a</span><em style="font-weight: 700">b</em><a href="/b"><span>b</span></a></a>');
  });
  test('a choice outside any row whose case holds choices in its rows', () => {
    const body = both(page('<section><sn-component use="{ doc: \'x-doc\', text: \'x-text\' }[doc.children.length ? \'doc\' : \'text\']" data-sn-with="{ doc, node: { value: \'none\' } }"></sn-component></section>'));
    // (its case's rows are left to the browser here, as before: what is checked is that both ways agree)
    expect(body).toContain('<section><div class="doc">');
  });
  test('a template\'s entries: each entry\'s own picks, through one kept template', () => {
    const [one, three, two] = entries(template('<main><x-doc data-sn-with="{ doc: d.doc }"></x-doc></main>'));
    expect(one).toContain('<span>plain</span><em title="t" style="color: red">e</em>');
    expect(two).toContain('<a href="/a"><span>a</span>');
    expect(three).toContain('<div class="doc"></div>');
  });
  test('the decisions they stand for, spelled out in order (`decidedEntries`)', () => {
    const keys = new Map([['a', 'k|use:a'], ['b', 'k|use:b'], ['c', 'k|use:c']]);
    const d = ['$r.doc'];
    expect([...decidedEntries([['x', true, d], { prefix: 'p#0/', keys, picked: 'b', d }, { prefix: 'q#1/', keys, picked: null, d }])]).toEqual([
      ['x', true, d], ['p#0/k|use:a', false, d], ['p#0/k|use:c', false, d], ['q#1/k|use:a', false, d], ['q#1/k|use:b', false, d], ['q#1/k|use:c', false, d],
    ]);
  });
});
