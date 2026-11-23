// The first pass's evaluation, made cheaper (docs/proposals/redesign-notes/evaluation.md): what it derives from the
// program once instead of per row or per entry, a row's scope as a plain object, a choice's candidates it does not
// render recorded as one entry. Each case is compiled with rows rendered and not (`SN_RENDER=0`, where the second pass
// compiles every row with what the worklist decided, by key), and a template's entries through one kept template and
// each alone: the results must be the same, every field.
import { afterEach, describe, expect, test } from 'vitest';
import { compile, type CompileOptions, type CompileResult } from '../../src/compiler/index.js';
import { caseCode, decidedEntries, failsFirst, frozenPlain, rowProgram, StyleWrites, writeFirstPaint } from '../../src/compiler/compile.js';

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

const was = process.env.SN_RENDER, wasFn = process.env.SN_ROW_FN;
afterEach(() => {
  if (was === undefined) delete process.env.SN_RENDER; else process.env.SN_RENDER = was;
  if (wasFn === undefined) delete process.env.SN_ROW_FN; else process.env.SN_ROW_FN = wasFn;
});

/** a page compiled with a row's values one call per template (`rowProgram`) and one call per value (`SN_ROW_FN=0`), rows rendered and not: the same */
function routes(html: string, extra: Partial<CompileOptions> = {}) {
  process.env.SN_ROW_FN = '0';
  const one = both(html, extra);
  delete process.env.SN_ROW_FN;
  expect(both(html, extra)).toBe(one);
  return one;
}

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

describe('a helper\'s result frozen already (`frozenPlain`): shared, not copied', () => {
  const deep = <T>(v: T): T => { if (v && typeof v === 'object') { for (const x of Object.values(v)) deep(x); Object.freeze(v); } return v; };
  test('what a copy would be, as it is: frozen plain data at every depth, without a getter, a symbol, a hole, a cycle', () => {
    expect(frozenPlain(deep({ a: [1, { b: 'x' }], c: null, d: undefined }))).toBe(true);
    const shared = deep({ x: 1 });
    expect(frozenPlain(deep({ a: shared, b: [shared, shared] }))).toBe(true);
    expect(frozenPlain({ a: 1 })).toBe(false);
    expect(frozenPlain(Object.freeze({ a: Object.freeze({ b: [1] }) }))).toBe(false);
    expect(frozenPlain(deep(Object.defineProperty({}, 'g', { get: () => 1, enumerable: true })))).toBe(false);
    expect(frozenPlain(deep(Object.defineProperty({ a: 1 }, 'h', { value: 2, enumerable: false })))).toBe(false);
    expect(frozenPlain(deep({ [Symbol('s')]: 1 }))).toBe(false);
    // eslint-disable-next-line no-sparse-arrays
    expect(frozenPlain(deep([1, , 3]))).toBe(false);
    expect(frozenPlain(deep(Object.assign([1, 2], { extra: 1 })))).toBe(false);
    expect(frozenPlain(deep(Object.assign(Object.create(null), { a: 1 })))).toBe(false);
    expect(frozenPlain(deep(new Date(0)))).toBe(false);
    const cyc: { self?: unknown } = {};
    cyc.self = cyc;
    expect(frozenPlain(Object.freeze(cyc))).toBe(false);
  });
  test('a helper that hands out one frozen tree per argument (`memo()`): each entry as with a helper that makes a new one', async () => {
    const { memo } = await import('../../src/memo.js');
    const make = (s: string) => ({ type: 'root', children: s.split(' ').map((w) => ({ type: 'text', value: w })) });
    const html = template('<main><ul><template data-sn-for="n in words(d.title).children"><li data-sn-text="n.value"></li></template></ul></main>');
    const run = (words: (s: string) => unknown) => {
      const o = options({ helpers: { module: '/h.js', names: ['words'], namespaces: {} }, helperValues: { words }, helperFold: new Map([['words', { fold: true }]]) });
      const list = compile(html, o).pages!.entries;
      const templates = new Map();
      return [0, 1].flatMap(() => list.map((e) => text(compile(html, { ...o, page: e, templates }))));
    };
    const fresh = run(make), shared = run(memo(make));
    expect(shared).toEqual(fresh);
    expect(fresh[0]).toContain('<li>The</li><li>one</li>');
  });
});

describe('a case\'s props as code (`caseCode`)', () => {
  test('one string per case for as long as its props are the same; another case, or changed props, its own', () => {
    const a = { props: '{ node: $.$p1.n }' }, b = { props: '{ node: $.$p1.n }' };
    const first = caseCode(a);
    expect(first).toBe('($) => ({ node: $.$p1.n })');
    expect(caseCode(a)).toBe(first);
    expect(caseCode(b)).toBe(first);
    a.props = '{ node: $.$p2.n }';
    expect(caseCode(a)).toBe('($) => ({ node: $.$p2.n })');
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
  test('an element\'s style bindings written at once (`StyleWrites`): what writing them one at a time writes, attribute by attribute', () => {
    // (random sequences: properties in another case, the same property again, values with a `;` or a space at an end,
    // `null`; the element with no style, an empty one, one with declarations; other attributes written in between)
    let seed = 7;
    const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
    const names = ['color', 'Color', 'margin', 'font-weight', 'width', 'x'];
    const values = [null, null, 'red', '0', '1px ', ' 2px', 'a; b', 'a:b', ''];
    const starts = [null, '', ' ', 'color: blue', 'padding:0;', 'a: b; ;margin : 1', ';'];
    type El = Parameters<typeof writeFirstPaint>[0];
    const el = (style: string | null) => ({ nodeName: 'i', tagName: 'i', attrs: [{ name: 'id', value: 'x' }, ...(style === null ? [] : [{ name: 'style', value: style }]), { name: 'lang', value: 'en' }], childNodes: [] }) as unknown as El;
    for (let round = 0; round < 3000; round++) {
      const start = starts[rnd(starts.length)]!, a = el(start), b = el(start), s = new StyleWrites(b);
      for (let k = rnd(12); k >= 0; k--) {
        if (rnd(4) === 0) {
          const v = rnd(2) ? null : 't' + k;
          writeFirstPaint(a, 'attr', 'title', v, true);
          writeFirstPaint(b, 'attr', 'title', v, true);
          continue;
        }
        const n = names[rnd(names.length)]!, v = values[rnd(values.length)]!;
        writeFirstPaint(a, 'style', n, v, true);
        s.write(n, v);
      }
      s.done();
      expect(b.attrs).toEqual(a.attrs);
    }
  });
  test('a template\'s elements copied in every row, each its own (ids, uses)', () => {
    const body = both(page('<x-doc data-sn-with="{ doc }"></x-doc><x-doc data-sn-with="{ doc }"></x-doc>'));
    expect(body.split('<a href="/b"><span>b</span></a>').length).toBe(3);
  });
});

describe('a row\'s values in one call per template (`rowProgram`)', () => {
  const fold = { helpers: { module: '/h.js', names: ['shout'], namespaces: {} }, helperValues: { shout: (s: string) => s.toUpperCase() }, helperFold: new Map([['shout', { fold: true }]]) } as Partial<CompileOptions>;
  test('each value at its place, FAIL for one that throws, a block body called, an expression in place', () => {
    const f = rowProgram(['k'], [7], { size: 5 }, [[1, '($) => ($.a.b + k)'], [2, '($) => { return $.a.c; }'], [3, '($) => ($.missing.x)'], [4, '($) => ($.a)']])!;
    const o = f({ a: { b: 1, c: 2 } });
    expect([o[0], o[1], o[2], typeof o[3], o[4]]).toEqual([undefined, 8, 2, 'symbol', { b: 1, c: 2 }]);
    expect(1 in o).toBe(true);
    expect(0 in o).toBe(false);
  });
  test('a value that throws is FAIL for that binding alone: the row\'s others are written', () => {
    const body = routes(page(`<ul><template data-sn-for="r in grid.rows"><li data-sn-attr="{ title: r.cells[1].name, lang: r.name }" data-sn-text="r.cells[0].name"></li></template></ul>`));
    expect(body).toContain('title="a2"');
  });
  test('a helper\'s call among the row\'s values: a call of its own, in its place; an undefined text; branches in the row', () => {
    const body = routes(page(`<ul><template data-sn-for="(r, i) in grid.rows"><li data-sn-attr="{ title: shout(r.name), lang: r.name }" data-sn-text="r.none"></li><template data-sn-if="i"><b data-sn-text="shout(r.name) + r.cells.length"></b></template><template data-sn-else><i data-sn-text="r.name"></i><template data-sn-text="r.nothing"></template></template></template></ul>`), fold);
    expect(body).toContain('<li title="A" lang="a"></li><i>a</i>');
    expect(body).toContain('<li title="B" lang="b"></li><b>B1</b>');
  });
  test('choices in rows and a tree, every value as before', () => {
    for (const d of ['one', 'two']) routes(page(`<sn-resource name="d" src="file:/content/docs/${d}.json"></sn-resource><x-doc data-sn-with="{ doc: d.doc }"></x-doc>`));
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
