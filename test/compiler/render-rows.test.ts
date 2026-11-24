// Rows rendered at build time (docs/proposals/redesign-notes/stage1-render.md): a loop the first pass unrolls whose
// rows are static through and through is rendered from the first pass's compiled templates and spliced into the
// second pass, which compiles nothing there. Each page here is compiled with rendering on and off (`SN_RENDER=0`):
// the two results must be the same, every field, and the test says whether the rows took the fast route.
import { afterEach, describe, expect, test } from 'vitest';
import { compile, type CompileOptions, type CompileResult, type ImageHost, type ImageInfo, type ImageVariant } from '../../src/compiler/index.js';
import { RENDER_STATS, compileParts, withoutEmptySlots, type CompiledParts } from '../../src/compiler/compile.js';
import { mapFns, type Binding, type IR } from '../../src/ir.js';

const C: Record<string, string> = {
  'tag-list': '<template data-sn-props="{ tags: string[] }"><ul><template data-sn-for="t in tags" data-sn-key="t"><li data-sn-text="t"></li></template></ul></template>',
  'x-badge': '<template data-sn-props="{ on: boolean; label: string }"><b class="badge" data-sn-class="{ on }" data-sn-text="label"></b></template>',
  'x-tree': '<template data-sn-props="{ node: { label: string; kids: any[] } }"><li><span data-sn-text="node.label"></span><ul><template data-sn-for="k in node.kids"><x-tree data-sn-with="{ node: k }"></x-tree></template></ul></li></template>',
  // a library's dispatch: a choice per node, a tree slot with a default in one candidate (tree-fills-static.test.ts)
  'x-doc': '<template data-sn-props="{ doc: any; link: Slot<{ url: string }> }"><div><template data-sn-for="n in doc.children"><sn-component use="{ text: \'x-text\', link: \'x-link\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>',
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-pic': '<template data-sn-props="{ src: string; w: number }"><figure><img alt="" class="p" data-sn-attr="{ src: src, title: \'w\' + w }" data-sn-class="{ wide: w > 1 }" data-sn-style="{ opacity: w / 2 }"><img alt="still" src="./img/a.jpg"></figure></template>',
  // scoped styles: a card with slot content, a recursive tree through it, a dispatch whose cases are styled (one whose root is another component)
  's-card': '<template data-sn-props="{ t: string }"><article class="card" data-sn-attr="{ title: t }"><h3 data-sn-text="t"></h3><slot></slot></article></template><style>.card { color: red } h3 { margin: 0 }</style>',
  's-tree': '<template data-sn-props="{ node: any }"><li class="n"><s-card data-sn-with="{ t: node.label }"><em data-sn-text="node.label"></em></s-card><ul><template data-sn-for="k in node.kids"><s-tree data-sn-with="{ node: k }"></s-tree></template></ul></li></template><style>.n { padding: 0 }</style>',
  's-doc': '<template data-sn-props="{ doc: any }"><div><template data-sn-for="n in doc.children"><sn-component use="{ text: \'s-text\', link: \'s-wrap\', list: \'s-list\', img: \'s-img\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>',
  's-text': '<template data-sn-props="{ node: any }"><span class="t" data-sn-text="node.value"></span></template><style>.t { color: blue }</style>',
  's-wrap': '<template data-sn-props="{ node: any }"><s-text data-sn-with="{ node: { value: node.url } }"></s-text></template><style>.w { color: green }</style>',
  's-img': '<template data-sn-props="{ node: any }"><img data-sn-attr="{ src: node.url, alt: \'i\' }"></template><style>img { border: 0 }</style>',
  's-list': '<template data-sn-props="{ node: any }"><ul><template data-sn-for="c in node.items"><s-card data-sn-with="{ t: c }"><i data-sn-text="c"></i></s-card></template></ul></template>',
  // a styled chain root, as the root of another component's tag (its branches its own markup, in slot content or not)
  's-chain': '<template data-sn-props="{ x: any }"><template data-sn-if="x.on"><i data-sn-text="x.t"></i></template><template data-sn-else><u data-sn-text="x.t + \'!\'"></u></template></template><style>u { color: red }</style>',
  's-tagged': '<template data-sn-props="{ x: any }"><s-chain class="t" data-sn-with="{ x }"></s-chain></template>',
  'x-a': '<template data-sn-props="{ u: string }"><a data-sn-attr="{ href: u }">l</a></template>',
  'x-pick': '<template data-sn-props="{ k: string }"><div><sn-component use="{ text: \'x-text\', em: \'x-em\' }[k]" data-sn-with="{ node: { value: k } }"></sn-component></div></template>',
  'x-em': '<template data-sn-props="{ node: any }"><em class="e" data-sn-class="{ on: node.value > \'a\' }" data-sn-text="node.value"></em></template>',
  'x-bad': '<template data-sn-props="{ k: string }"><div><sn-component use="{ t: \'x-text\', b: \'x-badge\' }[k]" data-sn-with="{ node: { value: k } }"></sn-component></div></template>',
  'x-ided': '<template><p id="i">i</p></template>',
  'x-pager': '<template><a href="?page=2">2</a></template>',
  'x-link': '<template data-sn-props="{ node: any }"><slot name="link" data-sn-with="{ url: node.url }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="{ text: \'x-text\', link: \'x-link\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></a></slot></template>',
};
const DOC = { children: [{ type: 'text', value: 'see ' }, { type: 'link', url: '/a', children: [{ type: 'text', value: 'a' }] }, { type: 'text', value: '!' }] };

const photo: ImageInfo = { width: 1600, height: 1067, alpha: false, kind: 'photo', color: '#8a7f6e', bytes: 200_000, hash: 'abc' };
const tiny: ImageInfo = { ...photo, width: 40, height: 40, bytes: 900, hash: 't' };
const imgs: Record<string, ImageInfo> = { '/p/img/a.jpg': photo, '/p/src/components/img/a.jpg': { ...photo, hash: 'c' }, '/p/img/t.png': tiny };
const host: ImageHost = { info: (f) => imgs[f] ?? null, url: (v: ImageVariant) => `/i/${v.hash}-${v.width}.${v.format}` };

const options = (extra: Partial<CompileOptions> = {}): CompileOptions => {
  const files: Record<string, string> = { '/p/doc.json': JSON.stringify(DOC) };
  for (const [k, s] of Object.entries(C)) files[`/p/src/components/${k}.html`] = s;
  return {
    file: '/p/index.html', root: '/p', dev: false, prerender: true, componentNames: Object.keys(C),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
    ...extra,
  };
};
const page = (body: string) => `<!doctype html><html><head></head><body><sn-resource name="doc" src="file:./doc.json"></sn-resource>${body}</body></html>`;
const text = (r: CompileResult) => JSON.stringify(r, (_, v) => (typeof v === 'function' ? '[fn]' : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v));
const was = process.env.SN_RENDER;
afterEach(() => { if (was === undefined) delete process.env.SN_RENDER; else process.env.SN_RENDER = was; });

/**
 * One compile, counted: how many loops its second pass spliced in, and why others were not rendered. The process-wide
 * counters move with every compile, and `SN_LINK_AUDIT=1` compiles each page several times more, so the counted
 * compile runs without it (the audited one runs beside it, in `both`).
 */
function counted<T>(f: () => T): { result: T; spliced: number; why: string[] } {
  const link = process.env.SN_LINK_AUDIT;
  delete process.env.SN_LINK_AUDIT;
  try {
    const n = RENDER_STATS.spliced, before = new Map([...RENDER_STATS.fallback].map(([k, v]) => [k, v.loops]));
    const result = f();
    const why = [...RENDER_STATS.fallback].filter(([k, v]) => v.loops > (before.get(k) ?? 0)).map(([k]) => k);
    return { result, spliced: RENDER_STATS.spliced - n, why };
  } finally { if (link !== undefined) process.env.SN_LINK_AUDIT = link; }
}

/** the page compiled with rendering off and on (under the audits the run has on, and once counted): the same result; the route the rows took */
function both(body: string, extra: Partial<CompileOptions> = {}) {
  process.env.SN_RENDER = '0';
  const off = compile(page(body), options(extra));
  delete process.env.SN_RENDER;
  const audited = compile(page(body), options(extra));
  expect(text(audited)).toBe(text(off));
  const { result: on, spliced, why } = counted(() => compile(page(body), options(extra)));
  expect(text(on)).toBe(text(off));
  return { out: on, spliced, why, body: /<body>([\s\S]*?)<\/body>/.exec(on.html)![1]! };
}

describe('rendered rows: the same page as compiled rows, without compiling them', () => {
  test('a loop of plain rows', () => {
    const r = both('<ul><template data-sn-for="x in [1, 2, 3]"><li data-sn-text="x"></li></template></ul>');
    expect(r.spliced).toBe(1);
    expect(r.body).toBe('<ul><li>1</li><li>2</li><li>3</li></ul>');
  });

  test('nested loops, both indexes', () => {
    const r = both('<template data-sn-for="(g, i) in [{ n: \'a\', kids: [1, 2] }, { n: \'b\', kids: [3] }]"><h2 data-sn-text="g.n"></h2><ul><template data-sn-for="(k, j) in g.kids"><li data-sn-text="g.n + k + i + j"></li></template></ul></template>');
    expect(r.spliced).toBe(1);
    expect(r.body).toBe('<h2>a</h2><ul><li>a100</li><li>a201</li></ul><h2>b</h2><ul><li>b310</li></ul>');
  });

  test('an if / else-if / else chain in a row', () => {
    const r = both('<template data-sn-for="x in [1, 2, 3]"><template data-sn-if="x === 1"><b>one</b></template><template data-sn-else><template data-sn-if="x === 2"><i>two</i></template><template data-sn-else><u data-sn-text="x"></u></template></template></template>');
    expect(r.spliced).toBe(1);
    expect(r.body).toBe('<b>one</b><i>two</i><u>3</u>');
  });

  test('a component per row, with a loop of its own over its prop', () => {
    const r = both('<template data-sn-for="g in [{ tags: [\'x\', \'y\'] }, { tags: [] }]"><tag-list data-sn-with="{ tags: g.tags }"></tag-list></template>');
    expect(r.spliced).toBe(1);
    expect(r.body).toBe('<ul><li>x</li><li>y</li></ul><ul></ul>');
  });

  test('a recursive component over constant data: each level an instance of its definition', () => {
    const tree = "{ label: 'a', kids: [{ label: 'b', kids: [{ label: 'c', kids: [] }] }, { label: 'd', kids: [] }] }";
    const r = both(`<ul><template data-sn-for="t in [${tree}]"><x-tree data-sn-with="{ node: t }"></x-tree></template></ul>`);
    expect(r.spliced).toBe(1);
    expect(r.body).toBe('<ul><li><span>a</span><ul><li><span>b</span><ul><li><span>c</span><ul></ul></li></ul></li><li><span>d</span><ul></ul></li></ul></li></ul>');
  });

  test('<sn-component use> choices per row, and a tree slot\'s default in a candidate', () => {
    const r = both('<x-doc data-sn-with="{ doc }"></x-doc>');
    expect(r.spliced).toBe(1);
    expect(r.body).toBe('<div><span>see </span><a href="/a"><span>a</span></a><span>!</span></div>');
  });

  test('text nodes: bound, literal, empty, at the top of a row and after an element', () => {
    const r = both('<p><template data-sn-for="x in [\'a\', \'\', \'c\']"><template data-sn-text="x"></template><template data-sn-text="\' \'"></template><i data-sn-text="x"></i><template data-sn-text="x + \'!\'"></template></template></p>');
    expect(r.spliced).toBe(1);
    expect(r.body).toBe('<p>a <i>a</i>a! <i></i>!c <i>c</i>c!</p>');
  });

  test('attr, class, style and show paints, on a component\'s root too', () => {
    const r = both('<template data-sn-for="x in [{ on: true, w: 1 }, { on: false, w: 2 }]"><p class="k" data-sn-attr="{ title: \'t\' + x.w, hidden: false }" data-sn-class="{ on: x.on, off: !x.on }" data-sn-style="{ width: x.w + \'px\' }" data-sn-show="x.on"></p><x-badge data-sn-with="{ on: x.on, label: \'L\' + x.w }"></x-badge></template>');
    expect(r.spliced).toBe(1);
    expect(r.body).toContain('<b class="badge on">L1</b>');
  });

  test('a build\'s minifier (the browser\'s own styles): written text as written, the white space between rows as compiled rows leave it', () => {
    const minify = { minify: { styles: [] } } as Partial<CompileOptions>;
    const r = both(`<div>
  <template data-sn-for="x in [' a  b ', '', 'c\\n']">
    <p data-sn-text="x"></p>
    <p> <template data-sn-text="x"></template> </p>
    <span>  <template data-sn-text="x"></template>  </span>
  </template>
</div><ul>
<template data-sn-for="x in [1, 2]">
  <li> <x-badge data-sn-with="{ on: x > 1, label: ' L ' }"></x-badge> </li>
</template>
</ul>`, minify);
    expect(r.spliced).toBe(2);
    expect(r.body).toContain('<p> a  b </p>');
  });

  test('a binding constant in every row (painted into the template by the first pass) in its place among the row\'s', () => {
    const r = both('<template data-sn-for="x in [1, 2]"><p data-sn-attr="{ title: x }" data-sn-class="{ on: true }" data-sn-style="{ color: \'red\', width: x + \'px\' }"></p></template>');
    expect(r.spliced).toBe(1);
    expect(r.body).toBe('<p title="1" class="on" style="color: red; width: 1px"></p><p title="2" class="on" style="color: red; width: 2px"></p>');
  });

  test('a build\'s minifier: style, show, hidden and contenteditable paints read as the bindings they were', () => {
    const minify = { minify: { styles: [] } } as Partial<CompileOptions>;
    const r = both(`<div>
  <template data-sn-for="x in [{ d: 'block', on: true }, { d: 'inline', on: false }]">
    <div data-sn-style="{ display: x.d, color: 'red' }"> <b>a</b> </div>
    <p data-sn-show="x.on"> <i data-sn-text="x.d"></i> </p>
    <section data-sn-attr="{ hidden: !x.on, title: x.d }"> <span> s </span> </section>
    <p data-sn-attr="{ contenteditable: x.on ? 'true' : null }">  two  spaces  </p>
    <x-badge data-sn-with="{ on: x.on, label: ' L ' }"></x-badge>
  </template>
</div>`, minify);
    expect(r.spliced).toBe(1);
    expect(r.why).toEqual([]);
    expect(r.body).toContain('<div style="display: block; color: red"> <b>a</b> </div>');
  });

  test('a build\'s minifier: a written text at the block\'s end is the element it was, the white space after it the markup\'s', () => {
    // (the second pass merges the block's texts with the page's beside it: not the one a binding wrote, `WRITTEN`)
    const r = both('<div id="o">\n    <template data-sn-for="x in [{ t: \'T\' }]"><p>a</p>\n  <template data-sn-text="x.t"></template> \n</template>\n  </div>', { minify: { styles: [] } } as Partial<CompileOptions>);
    expect(r.spliced).toBe(1);
    expect(r.body).toContain('<div id="o"><p>a</p>T</div>');
  });

  test('images: a bound `src` and a written one, in rows and in a component, rewritten as the compiled rows are', () => {
    const r = both(`<template data-sn-for="x in ['img/a.jpg', 'img/t.png']"><p><img alt="" data-sn-attr="{ src: x, title: x }" data-sn-class="{ on: true }"><img alt="w" src="img/a.jpg"></p></template>
<template data-sn-for="(x, i) in ['img/a.jpg', 'img/t.png']"><x-pic data-sn-with="{ src: x, w: i + 1 }"></x-pic></template><b data-sn-state="{ n: 1 }" data-sn-text="n"></b>`, { images: host });
    expect(r.spliced).toBe(2);
    expect(r.why).toEqual([]);
    expect(r.body).toContain('<picture><source type="image/avif"');
    expect(r.out.images!.variants.length).toBeGreaterThan(0);
  });

  test('images with a build\'s minifier', () => {
    const r = both('<div>\n<template data-sn-for="x in [\'img/a.jpg\']">\n <img alt="" data-sn-attr="{ src: x }"> <span> a </span>\n</template>\n</div>', { images: host, minify: { styles: [] } } as Partial<CompileOptions>);
    expect(r.spliced).toBe(1);
  });

  describe('a page with stylesheets: the layout, the space plan and the minifier read the rows as the old route has them', () => {
    const css = (text: string) => ({ styles: [{ css: text, file: '/p/a.css' }] }) as never as Partial<CompileOptions>;
    const sheet = '.wide { display: grid; grid-template-columns: repeat(3, 1fr) } .grid { display: grid; grid-template-columns: repeat(auto-fill, 200px) } li { display: block } .on { white-space: pre } p { max-width: 600px }';

    test('plain rows', () => {
      const r = both('<ul><template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template></ul>', css('li { display: block }'));
      expect(r.spliced).toBe(1);
    });

    test('a class a selector names and a style: written before the layout (`prefold`), the element left with its other bindings', () => {
      const r = both(`<div data-sn-state="{ n: 0 }"><template data-sn-for="x in [{ w: true, t: 'a' }, { w: false, t: 'b' }]">
  <section data-sn-class="{ wide: x.w, plain: !x.w }" data-sn-attr="{ title: x.t }" data-sn-style="{ color: x.w ? 'red' : null }"> <i data-sn-text="x.t"></i> </section>
  <p class="k" data-sn-class="{ on: x.w }"> <x-badge data-sn-with="{ on: x.w, label: x.t }"></x-badge>  </p>
</template><ul class="grid"><template data-sn-for="k in [n]"><li data-sn-text="k"></li></template></ul><b data-sn-text="n"></b><button data-sn-on-click="n++">+</button></div>`, { ...css(sheet), minify: true } as Partial<CompileOptions>);
      expect(r.spliced).toBe(1);
      expect(r.why).toEqual([]);
      expect(r.body).toContain('<section class="wide" style="color: red" title="a">');
    });

    test('images in rows, sized by the stylesheets', () => {
      const r = both('<div class="grid"><template data-sn-for="x in [\'img/a.jpg\', \'img/a.jpg\']"><figure><img alt="" data-sn-attr="{ src: x }" data-sn-class="{ wide: false }"></figure></template></div>', { images: { ...host, styles: [{ css: sheet, file: '/p/a.css' }] }, ...css(sheet) } as Partial<CompileOptions>);
      expect(r.spliced).toBe(1);
      expect(r.body).toContain('sizes=');
    });
  });

  describe('scoped styles: the marks the old route writes, and the ones it does not', () => {
    test('a styled component used in the rows: each copy of its root marked as the original (`rootCopies`), slot content not', () => {
      const r = both('<template data-sn-for="x in [\'a\', \'b\']"><s-card data-sn-with="{ t: x }"><b data-sn-text="x"></b></s-card></template><s-card data-sn-with="{ t: \'z\' }"><b>z</b></s-card>');
      expect(r.spliced).toBe(1);
      expect(r.body).toContain('<article class="card" data-sn-c="s-card" title="a"><h3>a</h3><b>a</b></article>');
      expect(r.body).toContain('<article class="card" data-sn-c="s-card" title="z">');
    });

    test('a choice\'s case in slot content whose root is a styled chain through a tag: the branch is the chain\'s own markup, marked', () => {
      const r = both('<template data-sn-for="x in [{ k: \'t\', t: \'T\', on: false }]"><s-card data-sn-with="{ t: \'c\' }"><sn-component use="{ t: \'s-tagged\' }[x.k]" data-sn-with="{ x }"></sn-component></s-card></template>');
      expect(r.spliced).toBe(1);
      expect(r.body).toContain('<u class="t" data-sn-c="s-chain">T!</u>');
    });

    test('a recursive styled tree: each instance marked, its slot content and the cards in its rows as the old route has them', () => {
      const tree = "{ label: 'a', kids: [{ label: 'b', kids: [{ label: 'c', kids: [] }] }, { label: 'd', kids: [] }] }";
      const r = both(`<ul><template data-sn-for="t in [${tree}]"><s-tree data-sn-with="{ node: t }"></s-tree></template></ul>`);
      expect(r.spliced).toBe(1);
      expect(r.why).toEqual([]);
      expect(r.body).toContain('data-sn-c="s-tree"');
    });

    test('a dispatch over styled cases, one whose root is another component (`data-sn-r`), on a page with stylesheets and a minifier', () => {
      const r = both('<s-doc data-sn-with="{ doc }"></s-doc>', { styles: [{ css: '.t { display: block }', file: '/p/a.css' }], minify: true } as never);
      expect(r.spliced).toBe(1);
      expect(r.why).toEqual([]);
      expect(r.body).toContain('data-sn-r="s-wrap"');
    });

    test('a styled component in a loop inside an instance: its copies marked as the original, the instance too', () => {
      const r = both('<s-doc data-sn-with="{ doc: { children: [{ type: \'list\', items: [\'p\', \'q\'] }, { type: \'text\', value: \'x\' }] } }"></s-doc>');
      expect(r.spliced).toBe(1);
      expect(r.why).toEqual([]);
      expect(r.body).toContain('<ul data-sn-c="s-list"><article class="card" data-sn-c="s-card" title="p">');
    });

    test('an image as an instance\'s root: marked after the image pipeline', () => {
      const r = both('<s-doc data-sn-with="{ doc: { children: [{ type: \'img\', url: \'img/a.jpg\' }, { type: \'img\', url: \'img/t.png\' }] } }"></s-doc>', { images: host });
      expect(r.spliced).toBe(1);
      expect(r.why).toEqual([]);
      expect(r.body).toContain('decoding="async" data-sn-c="s-img"');
    });

    test('a fill on a page with scoped styles: its top elements the caller\'s slot content (`data-sn-s`)', () => {
      const r = both('<x-doc data-sn-with="{ doc }"><a slot="link" class="L" data-sn-attr="{ href: $slot.url }">link</a></x-doc><s-card data-sn-with="{ t: \'z\' }"></s-card>');
      expect(r.spliced).toBe(1);
      expect(r.why).toEqual([]);
      expect(r.body).toContain('<a class="L" data-sn-s="" href="/a">');
    });
  });

  test('rows reading the page\'s state (constant): frozen as the old route freezes what it drops (`fixedState`)', () => {
    const r = both('<div data-sn-state="{ k: 1, n: 0 }"><template data-sn-for="x in [1, 2]"><p data-sn-text="x + k"></p></template><button data-sn-on-click="n++" data-sn-text="n"></button></div>');
    expect(r.spliced).toBe(1);
  });

  describe('fills of a tree slot: the caller\'s markup, with `$slot`', () => {
    test('a plain fill', () => {
      const r = both('<x-doc data-sn-with="{ doc }"><a slot="link" class="L" data-sn-attr="{ href: $slot.url }">link</a></x-doc>');
      expect(r.spliced).toBe(1);
      expect(r.body).toContain('<a class="L" href="/a">link</a>');
    });

    test('a fill that places the children (`<slot>`), with the caller\'s constant state and text', () => {
      const r = both('<div data-sn-state="{ k: \'K\' }"><x-doc data-sn-with="{ doc }"><a slot="link" class="L" data-sn-attr="{ href: $slot.url, title: k }"><b data-sn-text="k + $slot.url"></b><slot></slot></a></x-doc></div>');
      expect(r.spliced).toBe(1);
      expect(r.why).toEqual([]);
    });

    test('a fill chain (`<template slot data-sn-if>` and its else), on a page with stylesheets and a minifier', () => {
      const r = both(`<x-doc data-sn-with="{ doc }">
  <template slot="link" data-sn-if="$slot.url === '/a'"><a class="A" data-sn-attr="{ href: $slot.url }"> <slot></slot> </a></template>
  <template data-sn-else><span class="B" data-sn-text="$slot.url"></span></template>
</x-doc>`, { styles: [{ css: 'a { display: block }', file: '/p/a.css' }], minify: true } as never);
      expect(r.spliced).toBe(1);
      expect(r.why).toEqual([]);
    });
  });

  describe('a choice outside any loop (`<sn-component use>` decided at build time): its case rendered where it is', () => {
    test('on the page, and in a component used twice (each use its own case)', () => {
      const r = both('<sn-component use="{ t: \'x-text\' }[\'t\']" data-sn-with="{ node: { value: \'hi\' } }"></sn-component><x-doc data-sn-with="{ doc: { children: [{ type: \'text\', value: \'a\' }] } }"></x-doc><p data-sn-text="$url.q"></p><x-pick data-sn-with="{ k: \'text\' }"></x-pick><x-pick data-sn-with="{ k: \'em\' }"></x-pick>');
      expect(r.spliced).toBe(4);
      expect(r.why).toEqual([]);
      expect(r.body).toContain('<span>hi</span><div><span>a</span></div><p data-sn="');
      expect(r.body).toContain('<div><span>text</span></div><div><em class="e on">em</em></div>');
    });

    test('a case with a recursive tree and a tree slot\'s default, on a page with scoped styles and a minifier', () => {
      const r = both('<sn-component use="{ d: \'s-doc\' }[\'d\']" data-sn-with="{ doc: { children: [{ type: \'text\', value: \'a\' }, { type: \'link\', url: \'/u\' }] } }"></sn-component><s-tree data-sn-with="{ node: { label: \'r\', kids: [{ label: \'k\', kids: [] }] } }"></s-tree>', { minify: true } as never);
      expect(r.why).toEqual([]);
      expect(r.spliced).toBeGreaterThan(0);
    });
  });

  describe('links on a page that reads them (`$url`, axis lists): what the build sees of each, from the rows', () => {
    test('same-page links: a static `href` and bound ones (`data-sn-attr`, `data-sn-href`), in rows and in an instance', () => {
      const r = both('<p data-sn-text="$url.q"></p><template data-sn-for="x in [\'a\', \'b\']"><a href="/other.html">o</a><a data-sn-attr="{ href: \'?q=\' + x }" data-sn-text="x"></a><a data-sn-href="/x/{x}">x</a><x-a data-sn-with="{ u: \'?q=\' + x }"></x-a></template>');
      expect(r.spliced).toBe(1);
      expect(r.why).toEqual([]);
      expect(r.out.module).toContain('query-links');
    });

    test('SN519: a pager link in the rows that drops a parameter the page reads, reported where it was written', () => {
      const r = both('<sn-resource name="a" src="/api/a?tag={$url.tag}" select="a" key="id" paginate="{ numbered: true, size: 2, model: $url.page }"></sn-resource><p data-sn-text="a.length"></p><template data-sn-for="n in [1, 2]"><a href="?page=2" data-sn-text="n"></a></template>');
      expect(r.spliced).toBe(1);
      expect(r.out.diagnostics.filter((d) => d.code === 'SN519')).toHaveLength(2);
    });

    test('a link in rows over an axis list, and in rows nested in them: marked with each row\'s entry', () => {
      const files: Record<string, string> = { '/p/doc.json': JSON.stringify(DOC), '/p/t.json': JSON.stringify([{ key: 'acme', name: 'Acme', kids: [1, 2] }, { key: 'globex', name: 'Globex', kids: [3] }]) };
      for (const [k, s] of Object.entries(C)) files[`/p/src/components/${k}.html`] = s;
      const r = both('<sn-resource name="tenants" src="file:./t.json"></sn-resource><template data-sn-for="t in tenants"><a href="/about.html" data-sn-text="t.name"></a><ul><template data-sn-for="k in t.kids"><li><a data-sn-attr="{ href: \'/k/\' + k }" data-sn-class="{ on: k > 1 }" data-sn-text="k"></a></li></template></ul></template>',
        { axisLists: ['file:./t.json'], readFile: (f) => { if (f in files) return files[f]!; throw new Error(f); } });
      expect(r.spliced).toBe(1);
      expect(r.body).toContain('<a href="/about.html" data-sinter-pt="file%3A.%2Ft.json acme">Acme</a>');
      expect(r.body).toContain('<a data-sinter-pt="file%3A.%2Ft.json acme" href="/k/2" class="on">2</a>');
    });
  });

  test('ids written in the rows\' markup: declared as the old route declares its copies (`page.ids`, the dialogs)', () => {
    const r = both('<template data-sn-for="x in [1, 2]"><p id="one" data-sn-text="x"></p><dialog id="d"><x-ided></x-ided></dialog></template>');
    expect(r.spliced).toBe(1);
    expect(r.body).toBe('<p id="one">1</p><dialog id="d"><p id="i">i</p></dialog><p id="one">2</p><dialog id="d"><p id="i">i</p></dialog>');
  });

  test('the ids of what follows the rows are those the compiled rows leave', () => {
    const r = both('<template data-sn-for="x in [1, 2]"><i data-sn-text="x"></i><template data-sn-text="x"></template></template><div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></div>');
    expect(r.spliced).toBe(1);
    // (the resource is 0; each row's `<i>` and text node took one, dropped with their bindings)
    expect(r.body).toContain('<div data-sn="5"><button data-sn="6">0</button></div>');
  });

  test('a page per entry (`<html data-sn-for>`, a kept first pass): rendered per entry, each its own tree', () => {
    const docs: Record<string, unknown> = {
      'one': { children: [{ type: 'text', value: 'plain' }] },
      'two': { children: [{ type: 'link', url: '/a', children: [{ type: 'text', value: 'a' }, { type: 'link', url: '/b', children: [{ type: 'text', value: 'b' }] }] }] },
      'three': { children: [] },
    };
    const files: Record<string, string> = {};
    for (const [k, s] of Object.entries(C)) files[`/p/src/components/${k}.html`] = s;
    for (const [k, d] of Object.entries(docs)) files[`/p/content/docs/${k}.json`] = JSON.stringify({ slug: k, doc: d });
    const o = options({
      file: '/p/blog/post.html', readFile: (f) => { if (f in files) return files[f]!; throw new Error(f); },
      listFiles: (d) => Object.keys(files).filter((f) => f.startsWith(d.replace(/\/$/, '') + '/')),
    });
    const html = '<!doctype html><html lang="en" data-sn-path="/blog/:slug" data-sn-for="d in docs"><head><title data-sn-text="d.slug"></title></head><body><sn-resource name="docs" src="file:/content/docs/*.json"></sn-resource><x-doc data-sn-with="{ doc: d.doc }"></x-doc></body></html>';
    const entries = compile(html, o).pages!.entries;
    expect(entries).toHaveLength(3);
    const templates = new Map();
    for (const e of entries) {
      process.env.SN_RENDER = '0';
      const off = compile(html, { ...o, page: e });
      delete process.env.SN_RENDER;
      const { result: on, spliced } = counted(() => compile(html, { ...o, page: e, templates }));
      expect(text(on)).toBe(text(off));
      expect(spliced).toBe(1);
    }
    expect([...templates.values()][0]).toMatchObject({ hits: 3 });
  });
});

describe('rows left to the second pass, as before', () => {
  test('a handler in a row (one a static tree keeps)', () => {
    const r = both('<template data-sn-for="x in [1, 2]"><button data-sn-on-click="$el.focus()" data-sn-text="x"></button></template>');
    expect(r.spliced).toBe(0);
    expect(r.why).toContain('handler');
  });

  test('state in a row: the loop is not unrolled at all', () => {
    const r = both('<template data-sn-for="x in [1, 2]"><p data-sn-state="{ n: x }" data-sn-text="n"></p></template>');
    expect(r.spliced).toBe(0);
  });

  test('a value that is not written ahead (a refused URL) stays a binding', () => {
    const r = both('<template data-sn-for="x in [\'javascript:alert(1)\']"><a data-sn-attr="{ href: x }">x</a></template>');
    expect(r.spliced).toBe(0);
    expect(r.why).toContain('not written ahead');
  });

  test('a text node that fails at build time stays a binding', () => {
    const r = both('<template data-sn-for="x in [{ a: null }]"><p><template data-sn-text="x.a.b"></template></p></template>');
    expect(r.spliced).toBe(0);
    expect(r.why).toContain('text');
  });

  test('an id in the markup of a choice\'s case in the rows (SN209 counts the uses its expansion makes)', () => {
    const r = both('<template data-sn-for="x in [1, 2]"><sn-component use="{ i: \'x-ided\' }[\'i\']"></sn-component></template>');
    expect(r.spliced).toBe(0);
    expect(r.why).toContain('an id');
  });

  test('a pager link (SN519) in an instance in the rows: the old route words its report with the instance\'s chain', () => {
    const r = both('<sn-resource name="a" src="/api/a?tag={$url.tag}" select="a" key="id" paginate="{ numbered: true, size: 2, model: $url.page }"></sn-resource><p data-sn-text="a.length"></p><template data-sn-for="n in [\'?page=2\']"><sn-component use="{ p: \'x-pager\' }[\'p\']"></sn-component></template>');
    expect(r.spliced).toBe(0);
    expect(r.why).toContain('links');
    expect(r.out.diagnostics.filter((d) => d.code === 'SN519')).toHaveLength(1);
  });

  test('a choice outside loops whose candidates are reported on (SN313): the old route reports it again on the case it expands', () => {
    const r = both('<x-bad data-sn-with="{ k: \'b\' }"></x-bad><x-bad data-sn-with="{ k: \'t\' }"></x-bad>');
    // (the one whose case is reported on is left; the other is rendered)
    expect(r.spliced).toBe(1);
    expect(r.why).toContain('diagnostics');
    expect(r.out.diagnostics.map((d) => d.code)).toContain('SN313');
  });

});

/**
 * Dev builds render rows too. Dev does not compact its tables (`compactTables` is builds only), so the old route leaves
 * a `'0'` in the function table for each function it compiled in the rows and dropped, and every later function's
 * index (and its key in the dev `at` maps) counts them; rendered rows leave no such slot. So the two results are
 * compared here without the slots, the functions numbered again in their order (and what holds their numbers: the IR's
 * fields, the `at` maps' keys, the source map's sites), written out apart from the audit's `withoutEmptySlots`.
 */
describe('dev builds: rendered, the same as the old route but for its empty slots', () => {
  const dev = { dev: true, sourcemap: true };
  const slotsOut = (r: CompiledParts): CompiledParts => {
    const map = new Map<number, number>();
    r.fns.forEach((c, i) => { if (c !== '0') map.set(i, map.size); });
    const ir = JSON.parse(JSON.stringify(r.ir)) as IR;
    mapFns(ir, (i) => map.get(i) ?? -1);
    const keys = (o: { at?: Record<number, string> }) => { if (o.at) o.at = Object.fromEntries(Object.entries(o.at).map(([k, v]) => [map.get(+k) ?? -1, v])); };
    ir.resources.forEach(keys); ir.actions.forEach(keys);
    for (const s of ir.syncs ?? []) s.events.forEach(keys);
    for (const nd of [...ir.roots, ...ir.templates.flatMap((t) => t?.nodes ?? [])]) nd.b.forEach(keys);
    const kept = <T>(xs: T[]) => xs.filter((_, i) => map.has(i));
    return { ...r, ir, fns: kept(r.fns), ...(r.sources ? { sources: { ...r.sources, fns: kept(r.sources.fns) } } : {}) };
  };
  const parts = (body: string) => {
    process.env.SN_RENDER = '0';
    const off = compileParts(page(body), options(dev));
    delete process.env.SN_RENDER;
    const { result: on, spliced, why } = counted(() => compileParts(page(body), options(dev)));
    expect(text(slotsOut(on) as unknown as CompileResult)).toBe(text(slotsOut(off) as unknown as CompileResult));
    // (the audit's own comparison says the same)
    expect(text(withoutEmptySlots(on) as unknown as CompileResult)).toBe(text(withoutEmptySlots(off) as unknown as CompileResult));
    return { on, off, spliced, why };
  };
  /** the binding whose function's code has `code`, and its function's index */
  const bindingOf = (r: CompiledParts, code: string) => [...r.ir.roots, ...r.ir.templates.flatMap((t) => t?.nodes ?? [])].flatMap((n) => n.b).find((b) => b.f !== undefined && r.fns[b.f]!.includes(code))! as Binding & { at?: Record<number, string> };

  test('a loop before a live binding: no slots for the rows, and the binding at its own place under its new number', () => {
    const body = '<ul><template data-sn-for="x in [1, 2, 3]"><li data-sn-text="x * 2" data-sn-class="{ a: x > 1 }"></li></template></ul><p data-sn-text="$url.q"></p>';
    const { on, off, spliced } = parts(body);
    expect(spliced).toBe(1);
    expect(off.fns.filter((c) => c === '0').length).toBeGreaterThan(on.fns.filter((c) => c === '0').length);
    const a = bindingOf(on, '$url.q'), b = bindingOf(off, '$url.q');
    expect(a.f).toBeLessThan(b.f!);
    // where it was written: the `data-sn-text` of the `<p>`, in the `at` map (by its own index) and the source map
    const col = page(body).indexOf('$url.q') + 1;
    expect(a.at).toEqual({ [a.f!]: `/p/index.html:1:${col}` });
    expect(b.at).toEqual({ [b.f!]: `/p/index.html:1:${col}` });
    expect(on.sources!.fns[a.f!]).toMatchObject({ file: '/p/index.html', line: 1, col });
    // and the page module: the same markup, its table without the rows' slots
    process.env.SN_RENDER = '0';
    const m0 = compile(page(body), options(dev));
    delete process.env.SN_RENDER;
    const m1 = compile(page(body), options(dev));
    expect(m1.html).toBe(m0.html);
    expect(m1.module!.split('\n').filter((l) => l.trim() === '0,').length).toBeLessThan(m0.module!.split('\n').filter((l) => l.trim() === '0,').length);
  });

  test('rows of components, nested loops and a choice, with live markup on both sides', () => {
    const r = parts(`<p data-sn-text="$url.a"></p><template data-sn-for="g in [{ tags: ['x', 'y'] }, { tags: [] }]"><tag-list data-sn-with="{ tags: g.tags }"></tag-list><x-pick data-sn-with="{ k: 'em' }"></x-pick></template><x-doc data-sn-with="{ doc }"></x-doc><b data-sn-text="$url.b"></b>`);
    expect(r.spliced).toBeGreaterThan(0);
    // (the binding after the blocks: its own site, under its own number in each)
    const a = bindingOf(r.on, '$url.b'), b = bindingOf(r.off, '$url.b');
    expect(a.f).toBeLessThan(b.f!);
    expect(Object.keys(a.at!)).toEqual([String(a.f)]);
    expect(Object.keys(b.at!)).toEqual([String(b.f)]);
    expect(Object.values(a.at!)).toEqual(Object.values(b.at!));
  });

  test('a rendered block as its parent\'s and the page\'s last markup: every function at the site the old route gives it', () => {
    // (the walk leaves its site at the block's template, where the rows were written: what is compiled after it with
    // no site of its own is there, not at whatever element came before; `parts` compares the source maps and `at` maps)
    const body = '<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n">+</button><template data-sn-for="x in [1, 2]"><i data-sn-text="x"></i></template></div><template data-sn-for="y in [3]"><u data-sn-text="y"></u></template>';
    const { on, spliced } = parts(body);
    expect(spliced).toBe(2);
    const sites = on.sources!.fns.filter((s, i) => on.fns[i] !== '0' && s !== null);
    expect(sites.length).toBeGreaterThan(0);
    for (const s of sites) expect(s).toMatchObject({ file: '/p/index.html', line: 1 });
  });
});
