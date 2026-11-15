// Constant trees, step 7 of docs/proposals/component-libraries.md: loops over constants unrolled at any depth,
// `data-sn-if`s and `<sn-component use>` decided per unrolled copy and per use, all found by one worklist in the
// first pass, so the page is compiled at most twice whatever the depth (spec.md, Build-time constants).
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions, type ImageHost, type ImageInfo, type ImageVariant } from '../../src/compiler/index.js';

const options = (files: Record<string, string> = {}, extra: Partial<CompileOptions> = {}): CompileOptions => ({
  file: '/p/index.html', root: '/p', dev: false, prerender: true,
  helpers: { module: '/h.js', names: ['fmt'], namespaces: {} },
  componentNames: Object.keys(files).map((f) => f.slice(f.lastIndexOf('/') + 1, -5)),
  readFile: (p: string) => { if (p in files) return files[p]!; throw new Error('missing'); },
  ...extra,
});
const build = (body: string, files: Record<string, string> = {}, extra: Partial<CompileOptions> = {}) => compile(`<!doctype html><html><head></head><body>${body}</body></html>`, options(files, extra));
const bodyOf = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
const irOf = (module: string) => JSON.parse(/const ir = (\{.*\});/.exec(module)![1]!);
/** the page's body, with nothing left for the page module */
const unrolled = (body: string, files?: Record<string, string>) => {
  const out = build(body, files);
  expect(out.diagnostics).toEqual([]);
  const ir = irOf(out.module);
  expect(ir.templates).toEqual([]);
  expect(ir.roots).toEqual([]);
  return bodyOf(out.html);
};
const GROUPS = "[{ n: 'a', kids: [1, 2] }, { n: 'b', kids: [3] }]";

describe('nested loops over constants', () => {
  test('two levels: the inner list reads the outer item; both indexes', () => {
    expect(unrolled(`<template data-sn-for="(g, i) in ${GROUPS}"><h2 data-sn-text="g.n"></h2><ul><template data-sn-for="(k, j) in g.kids"><li data-sn-text="g.n + k + i + j"></li></template></ul></template>`))
      .toBe('<h2>a</h2><ul><li>a100</li><li>a201</li></ul><h2>b</h2><ul><li>b310</li></ul>');
  });

  test('an inner loop at the top of the outer row: its rows are the outer row\'s top too', () => {
    expect(unrolled(`<ul><template data-sn-for="g in ${GROUPS}"><template data-sn-for="k in g.kids"><li data-sn-text="g.n + k"></li></template></template></ul>`))
      .toBe('<ul><li>a1</li><li>a2</li><li>b3</li></ul>');
  });

  test('three levels, from state nothing writes', () => {
    expect(unrolled('<div data-sn-state="{ t: [[[1, 2], [3]], [[4]]] }"><template data-sn-for="a in t"><section><template data-sn-for="b in a"><p><template data-sn-for="c in b"><i data-sn-text="c"></i></template></p></template></section></template></div>'))
      .toBe('<div><section><p><i>1</i><i>2</i></p><p><i>3</i></p></section><section><p><i>4</i></p></section></div>');
  });

  test('a component in the rows, with a loop of its own over its prop', () => {
    const files = { '/p/src/components/tag-list.html': '<template data-sn-component="{ tags: string[] }"><ul><template data-sn-for="t in tags" data-sn-key="t"><li data-sn-text="t"></li></template></ul></template>' };
    expect(unrolled(`<template data-sn-for="g in [{ tags: ['x', 'y'] }, { tags: [] }]"><tag-list data-sn-prop="{ tags: g.tags }"></tag-list></template>`, files))
      .toBe('<ul><li>x</li><li>y</li></ul><ul></ul>');
  });

  test('a branch decided at build time: the loop in it is unrolled in the same compile', () => {
    expect(unrolled('<div data-sn-state="{ open: true }"><template data-sn-if="open"><ul><template data-sn-for="y in [1, 2]" data-sn-key="y"><li data-sn-text="y"></li></template></ul></template></div>'))
      .toBe('<div><ul><li>1</li><li>2</li></ul></div>');
  });

  test('an inner loop that is not constant keeps the outer one a template', () => {
    const out = build(`<sn-resource name="r" src="/api/r"></sn-resource><template data-sn-for="g in ${GROUPS}"><ul><template data-sn-for="x in r" data-sn-key="x"><li data-sn-text="x"></li></template></ul></template>`);
    expect(irOf(out.module).templates).toHaveLength(2);
  });
});

describe('decided per unrolled copy', () => {
  test('a `data-sn-if` that reads the row, with its `data-sn-else`', () => {
    expect(unrolled("<template data-sn-for=\"x in [{ on: true, t: 'A' }, { on: false, t: 'B' }]\"><template data-sn-if=\"x.on\"><b data-sn-text=\"x.t\"></b></template><template data-sn-else><i data-sn-text=\"x.t\"></i></template></template>"))
      .toBe('<b>A</b><i>B</i>');
  });

  test('a branch is markup of the row: a loop in it is unrolled with the row', () => {
    expect(unrolled(`<template data-sn-for="g in ${GROUPS}"><template data-sn-if="g.kids.length > 1"><p><template data-sn-for="k in g.kids"><i data-sn-text="k"></i></template></p></template></template>`))
      .toBe('<p><i>1</i><i>2</i></p>');
  });

  test('a branch with what needs the page module keeps the loop a template', () => {
    const out = build('<div data-sn-state="{ n: 0 }"><template data-sn-for="x in [true]" data-sn-key="x"><template data-sn-if="x"><button data-sn-on-click="n++">+</button></template></template></div>');
    expect(irOf(out.module).templates.length).toBeGreaterThan(0);
  });

  const blocks = {
    '/p/src/components/x-hero.html': '<template data-sn-component="{ v: string }"><h1 data-sn-text="v"></h1></template>',
    '/p/src/components/x-note.html': '<template data-sn-component="{ v: string }"><aside data-sn-text="v"></aside></template>',
  };

  test('`<sn-component use>` per use: only the candidate it renders is left', () => {
    const files = { ...blocks, '/p/src/components/one-block.html': '<template data-sn-component="{ kind: string }"><div><sn-component use="`x-${kind}`" data-sn-prop="{ v: kind }"></sn-component></div></template>' };
    const out = build("<one-block data-sn-prop=\"{ kind: 'hero' }\"></one-block><one-block data-sn-prop=\"{ kind: 'note' }\"></one-block>", files);
    expect(out.diagnostics).toEqual([]);
    // one choice node per use, each with the one case it renders (before: both candidates in each)
    const choices = irOf(out.module).roots.filter((n: { b: Array<{ k: string }> }) => n.b.some((b) => b.k === 'ch'));
    expect(choices.map((n: { b: Array<{ c: number[] }> }) => n.b[0]!.c.length)).toEqual([1, 1]);
    expect(bodyOf(out.html)).toContain('<template id="sn-t-0"><h1></h1></template><template id="sn-t-1"><aside></aside></template>');
  });

  test('`<sn-component use>` in rows: a row that renders none of its candidates is markup; one that renders one keeps the loop a template, its definition rendering at run time', () => {
    expect(unrolled("<template data-sn-for=\"k in ['z', 'q']\" data-sn-key=\"k\"><sn-component use=\"`x-${k}`\" data-sn-prop=\"{ v: k }\"></sn-component><template data-sn-else><s data-sn-text=\"k\"></s></template></template>", blocks))
      .toBe('<s>z</s><s>q</s>');
    const out = build("<template data-sn-for=\"k in ['hero', 'note']\" data-sn-key=\"k\"><sn-component use=\"`x-${k}`\" data-sn-prop=\"{ v: k }\"></sn-component></template>", blocks);
    expect(irOf(out.module).templates.length).toBeGreaterThan(0);
  });
});

describe('uses', () => {
  const files = {
    '/p/src/components/x-list.html': '<template data-sn-component="{ items: string[]; open: boolean }"><ul><template data-sn-if="open"><li>open</li></template><template data-sn-for="i in items" data-sn-key="i"><li data-sn-text="i"></li></template></ul></template>',
  };

  test('uses that disagree: each decided and unrolled on its own', () => {
    expect(unrolled("<div data-sn-state=\"{ a: ['x'], b: ['y', 'z'] }\"><x-list data-sn-prop=\"{ items: a, open: true }\"></x-list>\n<x-list data-sn-prop=\"{ items: b, open: false }\"></x-list></div>", files))
      .toBe('<div><ul><li>open</li><li>x</li></ul>\n<ul><li>y</li><li>z</li></ul></div>');
  });

  test('two uses on one line: told apart by where each tag is', () => {
    expect(unrolled("<div data-sn-state=\"{ a: ['x'], b: ['y', 'z'] }\"><x-list data-sn-prop=\"{ items: a, open: false }\"></x-list><x-list data-sn-prop=\"{ items: b, open: true }\"></x-list></div>", files))
      .toBe('<div><ul><li>x</li></ul><ul><li>open</li><li>y</li><li>z</li></ul></div>');
  });

  test('in the rows of a loop, a component\'s template is decided per row', () => {
    expect(unrolled("<template data-sn-for=\"r in [{ xs: ['p'], o: true }, { xs: [], o: false }]\"><x-list data-sn-prop=\"{ items: r.xs, open: r.o }\"></x-list></template>", files))
      .toBe('<ul><li>open</li><li>p</li></ul><ul></ul>');
  });
});

describe('limits', () => {
  const kept = (body: string) => irOf(build(body).module).templates.length;
  const list = (n: number, of: string) => `[${Array.from({ length: n }, () => of).join(', ')}]`;

  test('at most 1,000 items per list, at every level', () => {
    expect(kept(`<template data-sn-for="x in ${list(1000, '1')}" data-sn-key="x"><b data-sn-text="x"></b></template>`)).toBe(0);
    expect(kept(`<template data-sn-for="x in ${list(1001, '1')}" data-sn-key="x"><b data-sn-text="x"></b></template>`)).toBe(1);
    // an inner list over the limit keeps the outer loop a template too
    expect(kept(`<template data-sn-for="g in [${list(1001, '1')}]"><p><template data-sn-for="x in g" data-sn-key="x"><b data-sn-text="x"></b></template></p></template>`)).toBe(2);
  });

  test('at most 10,000 rows per page, at every depth: a loop that would cross it stays a template', () => {
    const inner = list(500, '1');
    expect(kept(`<template data-sn-for="g in ${list(19, inner)}"><p><template data-sn-for="x in g" data-sn-key="x"><b data-sn-text="x"></b></template></p></template>`)).toBe(0);
    expect(kept(`<template data-sn-for="g in ${list(20, inner)}"><p><template data-sn-for="x in g" data-sn-key="x"><b data-sn-text="x"></b></template></p></template>`)).toBe(2);
  });
});

describe('the constant pre-pass at depth', () => {
  const photo: ImageInfo = { width: 1600, height: 1067, alpha: false, kind: 'photo', color: '#8a7f6e', bytes: 200_000, hash: 'abc' };
  const url = (v: ImageVariant) => `/i/${v.width}.${v.format}`;
  const host: ImageHost = { info: (f) => (f === '/p/img/a.jpg' ? photo : undefined), url };

  test('an image in a nested row is optimized; a class in one counts for its box', () => {
    const css = [{ file: '/p/s.css', css: 'img { width: 100px; height: 67px } .big img { width: 300px; height: 200px }' }];
    const out = build(`<template data-sn-for="g in [{ big: true, pics: ['img/a.jpg'] }, { big: false, pics: ['img/a.jpg'] }]"><div data-sn-class="{ big: g.big }"><template data-sn-for="p in g.pics" data-sn-key="p"><img alt="" data-sn-attr="{ src: p }"></template></div></template>`, {}, { images: { ...host, styles: css }, styles: css });
    expect(out.diagnostics).toEqual([]);
    const [a, b] = bodyOf(out.html).split('</div>');
    expect(a).toContain('<div class="big"><picture>');
    expect(a).toContain('sizes="(max-width: 300px) 100vw, 300px"');
    expect(b).toContain('sizes="(max-width: 100px) 100vw, 100px"');
  });
});
