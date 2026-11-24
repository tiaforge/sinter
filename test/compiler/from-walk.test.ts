// Stage 5, step B1 (docs/proposals/redesign-notes/stage5-b1.md): a page whose second pass applies only branches decided
// at the page's level takes the second pass's result from its first pass's walk (`fromWalk`). Each case is compiled
// with the route off (`SN_FROM_WALK=0`) and on: the two must be the same up to numbering (`canonicalText`), and the
// test says which route the second pass took (`FROM_WALK_STATS`), or why it was compiled again.
import { afterEach, describe, expect, test } from 'vitest';
import { compileParts, FROM_WALK_STATS, type CompileOptions } from '../../src/compiler/compile.js';
import { canonicalText } from '../../src/compiler/canon.js';

const C: Record<string, string> = {
  'x-card': '<template data-sn-props="{ t: string }"><article class="card"><h3 data-sn-text="t"></h3><slot></slot></article></template><style>.card { margin: 0 }</style>',
  'x-em': '<template data-sn-props="{ v: string }"><em class="e" data-sn-text="v"></em></template><style>.e { color: red }</style>',
  'x-strong': '<template data-sn-props="{ v: string }"><strong data-sn-text="v"></strong></template>',
  'x-id': '<template data-sn-props="{ v: string }"><p id="one" data-sn-text="v"></p></template>',
  'x-btn': '<template data-sn-props="{ v: string }"><div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="v + n"></button></div></template>',
  'x-tree': '<template data-sn-props="{ n: any }"><li><span data-sn-text="n.name"></span><template data-sn-if="n.kids"><ul><template data-sn-for="k in n.kids"><x-tree data-sn-with="{ n: k }"></x-tree></template></ul></template></li></template>',
};

function options(extra: Partial<CompileOptions> = {}): CompileOptions {
  const files: Record<string, string> = {};
  for (const [k, s] of Object.entries(C)) files[`/p/src/components/${k}.html`] = s;
  files['/p/content/post.json'] = JSON.stringify({ title: 'Hello', tags: ['a', 'b'], draft: false });
  for (const [k, v] of Object.entries({ a: { title: 'Alpha', tags: ['x', 'y'], draft: true }, b: { title: 'Beta', tags: [], draft: false }, c: { title: 'Gamma', tags: ['z'], draft: false } })) files[`/p/content/posts/${k}.json`] = JSON.stringify({ slug: k, ...v });
  return {
    file: '/p/index.html', root: '/p', dev: false, prerender: true, componentNames: Object.keys(C),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (f) => { if (f in files) return files[f]!; throw new Error(f); },
    listFiles: (d) => Object.keys(files).filter((f) => f.startsWith(d.replace(/\/$/, '') + '/')),
    ...extra,
  };
}
const page = (body: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;

const saved = { on: process.env.SN_FROM_WALK, audit: process.env.SN_FROM_WALK_AUDIT, entries: process.env.SN_FROM_WALK_ENTRIES };
afterEach(() => {
  for (const [k, v] of [['SN_FROM_WALK', saved.on], ['SN_FROM_WALK_AUDIT', saved.audit], ['SN_FROM_WALK_ENTRIES', saved.entries]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

/** `html` compiled with the route off and on: the same up to numbering; the route the second pass took, or why not */
function both(html: string, extra: Partial<CompileOptions> = {}) {
  const env = ['SN_LINK_AUDIT', 'SN_RENDER_AUDIT', 'SN_UNITS_SHIFT_AUDIT', 'SN_FROM_WALK_AUDIT'].map((k) => [k, process.env[k]] as const);
  for (const [k] of env) delete process.env[k];
  try {
    process.env.SN_FROM_WALK = '0';
    const off = compileParts(html, options(extra));
    delete process.env.SN_FROM_WALK;
    const taken = FROM_WALK_STATS.taken, before = new Map(FROM_WALK_STATS.fallback);
    const on = compileParts(html, options(extra));
    const why: string[] = [];
    for (const [k, n] of FROM_WALK_STATS.fallback) for (let i = before.get(k) ?? 0; i < n; i++) why.push(k);
    expect(canonicalText(on)).toBe(canonicalText(off));
    return { on, off, taken: FROM_WALK_STATS.taken - taken, why };
  } finally { for (const [k, v] of env) if (v !== undefined) process.env[k] = v; }
}

describe('the second pass from the first pass\'s walk', () => {
  test('a build-time resource\'s values the second pass would fold into code, in code that does not ship', () => {
    // (the page ships no code: every read of `post` is a constant the build writes, whatever the second pass would fold)
    const r = both(page('<sn-resource name="post" src="file:/content/post.json"></sn-resource><h1 data-sn-text="post.title"></h1><template data-sn-if="!post.draft"><p data-sn-text="post.tags.join(\', \')"></p></template>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
  });

  test('a build-time resource read by live code only where it folds nothing (a list), the rest constant', () => {
    const r = both(page('<sn-resource name="post" src="file:/content/post.json"></sn-resource><h1 data-sn-text="post.title"></h1><div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="post.tags.length + n"></button></div><template data-sn-if="!post.draft"><b>live</b></template>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
  });

  test('a branch over state nothing writes, kept, with bindings that are constants and live ones', () => {
    const r = both(page('<main data-sn-state="{ open: true, q: \'\' }"><input data-sn-model="q"><template data-sn-if="open"><p data-sn-text="\'x\' + q"></p><b data-sn-text="open"></b></template><p data-sn-text="q"></p></main>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toContain('<b>true</b>');
  });

  test('a branch dropped, its else kept; and a branch kept, its else dropped', () => {
    const r = both(page('<div data-sn-state="{ a: false, b: 1 }"><template data-sn-if="a"><i data-sn-text="b"></i></template><template data-sn-else><s data-sn-text="b + 1"></s></template><template data-sn-if="b"><em>yes</em></template><template data-sn-else><em>no</em></template></div>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toContain('<s>2</s>');
    expect(r.on.html).not.toContain('no');
  });

  test('many sections, each with live parts and a branch decided (bench/page-compile)', () => {
    const sec = (i: number) => `<section data-sn-state="{ q${i}: '', n${i}: ${i} }"><input data-sn-model="q${i}"><x-card data-sn-with="{ t: 'Card ${i}' }"><em data-sn-text="q${i}.length"></em></x-card><template data-sn-if="n${i} % 2 === 0"><p>even <span data-sn-text="q${i}"></span></p></template><p data-sn-text="q${i}"></p></section>`;
    const r = both(page(Array.from({ length: 6 }, (_, i) => sec(i)).join('\n')));
    expect(r).toMatchObject({ taken: 1, why: [] });
    // the ids in document order (the gaps are bindings the build wrote and dropped, as in the old route)
    const ids = [...r.on.html.matchAll(/data-sn="(\d+)"/g)].map((m) => +m[1]!);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('`$build`, a link and a component in the branch, a branch decided inside it', () => {
    const r = both(page('<template data-sn-if="$build"><nav><a href="/a">a</a><x-card data-sn-with="{ t: \'c\' }"><template data-sn-if="1 + 1 === 2"><u>in</u></template></x-card></nav></template>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toMatch(/<u[^>]*>in<\/u>/);
  });

  test('a definition the branch\'s walk compiled, which the page no longer needs (its tree is constant)', () => {
    const r = both(page('<div data-sn-state="{ a: true }"><template data-sn-if="a"><ul><x-tree data-sn-with="{ n: { name: \'r\', kids: [] } }"></x-tree></ul></template></div>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
  });

  test('a loop rendered at the page\'s level, and one in a decided branch; ids after them as the walk leaves them', () => {
    const r = both(page('<ul><template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template></ul><div data-sn-state="{ a: true, n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button><template data-sn-if="a"><ol><template data-sn-for="y in [3, 4]"><li data-sn-text="y"></li></template></ol></template><p data-sn-text="n"></p></div>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
    expect(r.on.html).toContain('<ol><li>3</li><li>4</li></ol>');
  });

  test('rendered rows, minified with no stylesheet', () => {
    const r = both(page('<ul>\n  <template data-sn-for="x in [1, 2]">\n    <li data-sn-text="x"></li>\n  </template>\n</ul>'), { minify: true });
    expect(r).toMatchObject({ taken: 1, why: [] });
  });

  test('rendered rows the minifier reads with a layout (the browser\'s own styles): the white space at their edges', () => {
    const r = both(page('<div>\n  <span>x</span>\n  <template data-sn-for="x in [1, 2]">\n    <p data-sn-text="x"></p> <b>i</b>\n  </template>\n  <span>z</span> T\n</div><ul>\n<template data-sn-for="x in [3]"><li data-sn-text="x"></li></template>\n</ul>'), { minify: { styles: [] } } as Partial<CompileOptions>);
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
  });

  test('rendered rows under the page\'s layout, nothing it sizes beside them; an image elsewhere', () => {
    const r = both(page('<ul>\n<template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template>\n</ul><p><img src="/a.png"></p>'), { minify: true, styles: [{ file: '/p/s.css', css: 'ul { width: 300px } li:first-child { display: inline } img { width: 100% }' }] } as unknown as Partial<CompileOptions>);
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
  });

  test('rendered rows with images, through the image pipeline where they are spliced (an image before them: not eager)', () => {
    const host = { info: () => ({ width: 800, height: 600, format: 'jpeg' }), url: (v: { width: number }) => `/i-${v.width}.jpg`, stylesheet: '/@img/i.css' };
    const body = '<sn-resource name="posts" src="file:/content/posts/*.json"></sn-resource><img src="/hero.jpg" alt="h"><ul><template data-sn-for="p in posts"><li><img data-sn-attr="{ src: \'/\' + p.slug + \'.jpg\', alt: p.title }"></li></template></ul>';
    const r = both(page(body), { images: host } as unknown as Partial<CompileOptions>);
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
    expect(JSON.stringify(r.on.images)).toBe(JSON.stringify(r.off.images));
    // (and the rows' image the page's first: eager)
    const r2 = both(page(body.replace('<img src="/hero.jpg" alt="h">', '')), { images: host } as unknown as Partial<CompileOptions>);
    expect(r2).toMatchObject({ taken: 1, why: [] });
    expect(r2.on.html).toBe(r2.off.html);
  });

  test('an embedded resource\'s id before rendered rows: numbered where its element stood', () => {
    const r = both('<!doctype html><html lang="en"><head><title>t</title></head><body><sn-resource name="cart" src="/api/cart"></sn-resource><script type="application/json" data-sn-resource="cart">{"n":1}</script><ul><template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template></ul><p data-sn-text="cart.n"></p></body></html>');
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
  });

  test('minified, with white space around the branch', () => {
    const r = both(page('<div data-sn-state="{ a: true }">\n  <span>x</span>\n  <template data-sn-if="a">\n    <b> y </b>\n  </template>\n  <span>z</span>\n</div>'), { minify: true });
    expect(r).toMatchObject({ taken: 1, why: [] });
  });
});

describe('compiled again: each reason', () => {
  test('a build-time resource decides the branch, and its values are folded into the code that ships', () => {
    // (finished from the walk, then compiled again: a live binding reads `post.title`, which the second pass writes into its code)
    const r = both(page('<sn-resource name="post" src="file:/content/post.json"></sn-resource><div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="post.title + n"></button></div><template data-sn-if="!post.draft"><p data-sn-text="post.tags.join(\', \')"></p></template>'));
    expect(r).toMatchObject({ taken: 0, why: ['values folded into the code that ships'] });
    expect(r.on.fns.join('\n')).toContain('"Hello"');
  });

  test('rendered rows beside an element whose class the walk took off, under the minifier with a layout', () => {
    const r = both(page('<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++">+</button><ul data-sn-class="{ on: n > 0 }">\n<template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template>\n</ul></div>'), { minify: { styles: [] } } as Partial<CompileOptions>);
    expect(r).toMatchObject({ taken: 0, why: ['rendered rows and a layout: a bound element around them'] });
  });

  test('rendered rows and the page\'s layout, an image beside them (its size may follow a structural rule the rows answer)', () => {
    const r = both(page('<div><template data-sn-for="x in [1, 2]"><p data-sn-text="x"></p></template><img src="/a.png"></div>'), { styles: [{ file: '/p/s.css', css: 'div { width: 300px } p + img { width: 50% }' }] } as unknown as Partial<CompileOptions>);
    expect(r).toMatchObject({ taken: 0, why: ['rendered rows and a layout: an image beside them'] });
  });

  test('rendered rows and the page\'s layout, a `:has()` rule', () => {
    const r = both(page('<ul><template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template></ul>'), { styles: [{ file: '/p/s.css', css: 'ul:has(li) { width: 300px }' }] } as unknown as Partial<CompileOptions>);
    expect(r).toMatchObject({ taken: 0, why: ['rendered rows and a layout: a `:has()` rule'] });
  });


  test('diagnostics in a decided branch: the dropped walk\'s taken out, the walk again\'s where they were', () => {
    // (§22: the second pass reports what its walk of the branch reports, in document order: before the page's after it)
    const r = both(page('<div data-sn-state="{ a: true }"><template data-sn-if="a"><p data-sn-text="a" data-sn-key="x"></p></template><b data-sn-text="\'b\' + a" data-sn-key="y"></b></div>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.diagnostics.map((d) => d.code)).toEqual(r.off.diagnostics.map((d) => d.code));
    expect(r.on.diagnostics.length).toBe(2);
  });

  test('diagnostics in a dropped branch and in a kept else: as the second pass reports them', () => {
    const r = both(page('<div data-sn-state="{ a: false }"><template data-sn-if="a"><p data-sn-text="a" data-sn-key="x"></p></template><template data-sn-else><i data-sn-text="a" data-sn-key="z"></i></template></div>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(JSON.stringify(r.on.diagnostics)).toBe(JSON.stringify(r.off.diagnostics));
  });

  test('diagnostics off the route (`SN_FROM_WALK_DIAGS=0`): compiled again', () => {
    process.env.SN_FROM_WALK_DIAGS = '0';
    try {
      const r = both(page('<div data-sn-state="{ a: true }"><template data-sn-if="a"><p data-sn-text="a" data-sn-key="x"></p></template></div>'));
      expect(r).toMatchObject({ taken: 0, why: ['diagnostics in a decided branch'] });
    } finally { delete process.env.SN_FROM_WALK_DIAGS; }
  });

  test('a definition compiled first in a decided branch, used by the page (live data): compiled again where the branch is walked', () => {
    // (§21: its first copy, the dropped walk's, goes where nothing reaches it; the second pass's walk compiles it at the
    // same use, in the same scope; numbered otherwise)
    const r = both(page('<div data-sn-state="{ a: true, t: { name: \'r\', kids: [] } }"><button data-sn-on-click="t = { name: \'s\', kids: [] }">x</button><template data-sn-if="a"><ul><x-tree data-sn-with="{ n: t }"></x-tree></ul></template></div>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
  });

  test('a definition compiled first in a decided branch, used again after it by the page and by rows rendered there', () => {
    // (the page's own use after the branch: the definition's copy the walk again made; rendered rows of it beside)
    const r = both(page('<div data-sn-state="{ a: true, t: { name: \'r\', kids: [] } }"><button data-sn-on-click="t = { name: \'s\', kids: [] }">x</button><template data-sn-if="a"><ul><x-tree data-sn-with="{ n: t }"></x-tree></ul></template><ol><x-tree data-sn-with="{ n: { name: \'q\', kids: [{ name: \'z\', kids: [] }] } }"></x-tree></ol></div>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
  });

  test('a cycle of definitions in a component\'s root chain the build decides: the templates the walk again makes kept as it makes them', () => {
    // (a template of the definition compiled again that nothing in the IR reaches, which the second pass keeps too)
    const files: Record<string, string> = {
      '/p/src/components/x-ping.html': '<template data-sn-props="{ n: number }"><template data-sn-if="n > 0"><x-pong data-sn-with="{ n: n - 1 }"></x-pong></template><template data-sn-else><i>ping</i></template></template>',
      '/p/src/components/x-pong.html': '<template data-sn-props="{ n: number }"><template data-sn-if="n > 0"><x-ping data-sn-with="{ n: n - 1 }"></x-ping></template><template data-sn-else><b>pong</b></template></template>',
    };
    const base = options();
    const r = both(page('<x-ping data-sn-with="{ n: 3 }"></x-ping>'), { componentNames: [...base.componentNames!, 'x-ping', 'x-pong'], readFile: (f) => files[f] ?? base.readFile!(f) });
    expect(r).toMatchObject({ taken: 1, why: [] });
  });

  test('an else-if decided', () => {
    const r = both(page('<div data-sn-state="{ a: false, b: true, c: 0 }"><button data-sn-on-click="c++">+</button><template data-sn-if="c"><i>c</i></template><template data-sn-else data-sn-if="b"><b>b</b></template></div>'));
    expect(r).toMatchObject({ taken: 0, why: ['an else-if decided'] });
  });

  test('code the decided branch compiled first, compiled again by the page: the page\'s site (a source map shows it)', () => {
    const r = both(page('<div data-sn-state="{ a: true, n: 0 }"><button data-sn-on-click="n++">+</button><template data-sn-if="a"><b>a</b></template><p data-sn-show="a"></p></div>'), { sourcemap: true });
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(JSON.stringify(r.on.sources)).toBe(JSON.stringify(r.off.sources));
  });

  test('code the decided branch compiled first, called by the page and by the branch walked again', () => {
    const r = both(page('<div data-sn-state="{ a: true, n: 0 }"><button data-sn-on-click="n++">+</button><p data-sn-show="n"></p><template data-sn-if="a"><i data-sn-show="n"></i></template><b data-sn-show="n"></b></div>'), { sourcemap: true });
    expect(r.taken + r.why.length).toBe(1);
  });

  test('a decided if in a template that stays', () => {
    const r = both(page('<div data-sn-state="{ a: true, n: 0 }"><button data-sn-on-click="n++">+</button><template data-sn-if="a"><b>a</b></template><template data-sn-if="n"><template data-sn-if="a === true"><i>i</i></template></template></div>'));
    expect(r).toMatchObject({ taken: 0, why: ['a decided if in a template that stays'] });
  });

  test('a resource read only in the branch dropped (SN501 in the second pass)', () => {
    const r = both(page('<sn-resource name="user" src="/api/user"></sn-resource><div data-sn-state="{ a: false }"><template data-sn-if="a"><p data-sn-text="user.name"></p></template></div>'));
    expect(r.on.diagnostics.map((d) => d.code)).toContain('SN501');
    expect(r).toMatchObject({ taken: 0, why: ['a resource read only in a decided branch (SN501)'] });
  });

  test('a resource a dropped branch read first, read by the rows rendered after it: not unread (the rows\' reads)', () => {
    const r = both(page('<sn-resource name="doc" src="file:/content/post.json"></sn-resource><div data-sn-state="{ a: false }"><template data-sn-if="a"><p data-sn-text="doc.title"></p></template><ul><template data-sn-for="t in doc.tags"><li data-sn-text="t"></li></template></ul></div>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
  });

  test('a loop over constants that stays a template (state in its rows): nothing decided, no second pass at all', () => {
    const r = both(page('<ul><template data-sn-for="x in [1, 2]"><li data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n + x"></button></li></template></ul>'));
    expect(r).toMatchObject({ taken: 0, why: ['no second pass (nothing decided)'] });
  });

  test('nothing evaluates: no record kept, the first pass as before', () => {
    const r = both(page('<div data-sn-state="{ a: true }"><button data-sn-on-click="a = !a">t</button><template data-sn-if="a"><b>a</b></template></div>'));
    expect(r).toMatchObject({ taken: 0, why: [] });
  });
});

// (behind `SN_FROM_WALK_ENTRIES=1`: a copy of the kept walk costs more than the second pass it saves, stage5-b1.md)
describe('a template\'s entries from a copy of the kept walk', () => {
  const template = (body: string) => `<!doctype html><html lang="en" data-sn-path="/blog/:slug" data-sn-for="p in posts"><head><title data-sn-text="p.title"></title></head><body><sn-resource name="posts" src="file:/content/posts/*.json"></sn-resource>${body}</body></html>`;
  /** every entry compiled with the route off and on (each way with its own kept templates): the same up to numbering */
  function entries(html: string) {
    process.env.SN_FROM_WALK_ENTRIES = '1';
    const env = ['SN_LINK_AUDIT', 'SN_RENDER_AUDIT', 'SN_UNITS_SHIFT_AUDIT', 'SN_FROM_WALK_AUDIT'].map((k) => [k, process.env[k]] as const);
    for (const [k] of env) delete process.env[k];
    try {
      const o = options({ file: '/p/blog/post.html' });
      const list = compileParts(html, o).pages!.entries;
      process.env.SN_FROM_WALK = '0';
      const t0 = new Map();
      const off = list.map((e) => compileParts(html, { ...o, page: e, templates: t0 }));
      delete process.env.SN_FROM_WALK;
      const taken = FROM_WALK_STATS.taken, before = new Map(FROM_WALK_STATS.fallback);
      const t1 = new Map();
      const on = list.map((e) => compileParts(html, { ...o, page: e, templates: t1 }));
      on.forEach((r, i) => expect(canonicalText(r)).toBe(canonicalText(off[i]!)));
      const why: string[] = [];
      for (const [k, n] of FROM_WALK_STATS.fallback) for (let i = before.get(k) ?? 0; i < n; i++) why.push(k);
      return { on, off, n: list.length, taken: FROM_WALK_STATS.taken - taken, why };
    } finally { for (const [k, v] of env) if (v !== undefined) process.env[k] = v; }
  }

  test('a branch over the entry decided another way per entry, and a loop over it rendered', () => {
    const r = entries(template('<h1 data-sn-text="p.title"></h1><template data-sn-if="p.draft"><p class="draft">Draft</p></template><template data-sn-else><ul><template data-sn-for="t in p.tags"><li data-sn-text="t"></li></template></ul></template>'));
    // (an entry's values are folded into the code that reads them, which its walk did not: the second pass, counted)
    expect(r.taken + r.why.filter((w) => w === 'values folded into the code').length).toBe(r.n);
    expect(r.on.map((x) => x.html).join('')).toContain('<li>z</li>');
  });

  test('an entry compiled alone (a page that is not quiet), its loop over the entry rendered: finished from the walk', () => {
    const html = template('<ul><template data-sn-for="t in p.tags"><li data-sn-text="t"></li></template></ul><template data-sn-if="!p.draft"><b>live</b></template>');
    const env = ['SN_LINK_AUDIT', 'SN_RENDER_AUDIT', 'SN_UNITS_SHIFT_AUDIT', 'SN_FROM_WALK_AUDIT'].map((k) => [k, process.env[k]] as const);
    for (const [k] of env) delete process.env[k];
    try {
      const o = options({ file: '/p/blog/post.html' });
      const [e] = compileParts(html, o).pages!.entries;
      process.env.SN_FROM_WALK = '0';
      const off = compileParts(html, { ...o, page: e });
      delete process.env.SN_FROM_WALK;
      const taken = FROM_WALK_STATS.taken;
      const on = compileParts(html, { ...o, page: e });
      expect(canonicalText(on)).toBe(canonicalText(off));
      expect(FROM_WALK_STATS.taken - taken).toBe(1);
      // (one whose finish reports an error, `$url` read on a page per entry, SN345: the old route did not unroll; so here)
      const bad = template('<p data-sn-text="$url.slug"></p><ul><template data-sn-for="t in p.tags"><li data-sn-text="t"></li></template></ul>');
      process.env.SN_FROM_WALK = '0';
      const off2 = compileParts(bad, { ...o, page: e });
      delete process.env.SN_FROM_WALK;
      const why = FROM_WALK_STATS.fallback.get('a loop unrolled on a page that is not quiet, not clean') ?? 0;
      const on2 = compileParts(bad, { ...o, page: e });
      expect(canonicalText(on2)).toBe(canonicalText(off2));
      expect(on2.diagnostics.map((d) => d.code)).toContain('SN345');
      expect(FROM_WALK_STATS.fallback.get('a loop unrolled on a page that is not quiet, not clean') ?? 0).toBe(why + 1);
    } finally { for (const [k, v] of env) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('state beside the entry: the page\'s ids and its module', () => {
    const r = entries(template('<section data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button><template data-sn-if="!p.draft"><p data-sn-text="p.title + n"></p></template></section>'));
    expect(r.taken + r.why.filter((w) => w === 'values folded into the code').length).toBe(r.n);
    expect(r.on.map((x) => x.html)).toEqual(r.off.map((x) => x.html));
  });
});

// a page-level `<sn-component use>` the build decides (§22): its candidates' walks taken out as a dropped branch's; the
// case it renders spliced as rendered rows, or expanded in place and walked as the page's, or nothing
describe('choices decided at the page\'s level', () => {
  test('its case rendered: the rows in its place, the other candidates\' walks taken out', () => {
    const r = both(page('<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></div><p><sn-component use="{ e: \'x-em\', s: \'x-strong\' }[\'s\']" data-sn-with="{ v: \'hi\' }"></sn-component></p>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
    expect(r.on.html).toContain('<p><strong data-sn-c="x-strong">hi</strong></p>');
  });

  test('a value outside its candidates: nothing, and the `data-sn-else` after it kept', () => {
    const r = both(page('<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></div><p><sn-component use="{ e: \'x-em\', s: \'x-strong\' }[\'q\']" data-sn-with="{ v: \'hi\' }"></sn-component><template data-sn-else><i>none</i></template></p>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
    expect(r.on.html).toContain('<p><i>none</i></p>');
  });

  test('some candidates decided away, the one left to the browser (a handler in it): a choice of its own, walked again', () => {
    const r = both(page('<p><sn-component use="{ e: \'x-em\', b: \'x-btn\' }[\'b\']" data-sn-with="{ v: \'hi\' }"></sn-component></p>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
  });

  test('its case expanded in place (an id in it, which rows do not render): walked as the page\'s, as the second pass inlines it', () => {
    const r = both(page('<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></div><p><sn-component use="{ e: \'x-em\', i: \'x-id\' }[\'i\']" data-sn-with="{ v: \'hi\' }"></sn-component></p>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.html).toBe(r.off.html);
  });

  test('two choices: a file the earlier one\'s candidates read first, which only the later one\'s case renders', () => {
    // (the dropped walks' keys out before any block is spliced: the later block's rows add the file again)
    const r = both(page('<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></div><p><sn-component use="{ s: \'x-strong\', e: \'x-em\' }[\'s\']" data-sn-with="{ v: \'a\' }"></sn-component></p><p><sn-component use="{ s: \'x-strong\', e: \'x-em\' }[\'e\']" data-sn-with="{ v: \'b\' }"></sn-component></p>'));
    expect(r).toMatchObject({ taken: 1, why: [] });
    expect(r.on.files).toEqual(r.off.files);
    expect(r.on.html).toBe(r.off.html);
  });

  test('a choice over live data beside a decided branch: left as it is', () => {
    const r = both(page('<sn-resource name="k" src="/api/k"></sn-resource><p><sn-component use="{ e: \'x-em\', s: \'x-strong\' }[k.v]" data-sn-with="{ v: \'hi\' }"></sn-component></p><template data-sn-if="true"><b>b</b></template>'));
    expect(r.why.filter((w) => w.includes('choice'))).toEqual([]);
  });
});

// pages through a build's units (units.ts): the first pass places the unit, whose objects other pages share. The route
// finishes that pass: what of the unit it changes is held and given back (`SN_UNITS_VERIFY=1` checks every object of
// the unit after every page), and what placing it added to the page's tables is taken out (the second pass places none)
describe('pages with a unit placed', () => {
  const U: Record<string, string> = {
    'x-doc': '<template data-sn-props="{ doc: any }"><div class="doc"><template data-sn-for="n in doc.children"><sn-component use="{ text: \'x-text\', em: \'x-em\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>',
    'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
    'x-em': '<template data-sn-props="{ node: any }"><em><template data-sn-for="n in node.children"><sn-component use="{ text: \'x-text\', em: \'x-em\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></em></template>',
  };
  const doc = { children: [{ type: 'text', value: 'see ' }, { type: 'em', children: [{ type: 'text', value: 'this' }] }] };
  const opts = (name: string, units: Map<string, unknown>): CompileOptions => options({
    file: `/p/${name}.html`, componentNames: [...Object.keys(C), ...Object.keys(U)], units,
    readFile: (f) => { const k = /\/components\/([\w-]+)\.html$/.exec(f)?.[1]; if (k && U[k]) return U[k]!; if (k && C[k]) return C[k]!; if (f === '/p/doc.json') return JSON.stringify(doc); throw new Error(f); },
  });
  const PAGES: Record<string, string> = {
    'a tree from a file': '<sn-resource name="doc" src="file:/doc.json"></sn-resource><x-doc data-sn-with="{ doc }"></x-doc>',
    'a tree in a decided branch, live state beside it': '<sn-resource name="doc" src="file:/doc.json"></sn-resource><div data-sn-state="{ n: 0, a: true }"><button data-sn-on-click="n++" data-sn-text="n"></button><template data-sn-if="a"><x-doc data-sn-with="{ doc }"></x-doc></template></div>',
    'a tree over live data (its definitions ship)': '<sn-resource name="live" src="/api/doc"></sn-resource><div data-sn-state="{ a: true }"><template data-sn-if="a"><b>x</b></template></div><x-doc data-sn-with="{ doc: live }"></x-doc>',
  };
  /** every page through one unit store, twice (the first page makes the unit, the rest place it), the route off and on */
  function pages() {
    const env = ['SN_LINK_AUDIT', 'SN_RENDER_AUDIT', 'SN_UNITS_SHIFT_AUDIT', 'SN_FROM_WALK_AUDIT', 'SN_UNITS_VERIFY'].map((k) => [k, process.env[k]] as const);
    for (const [k] of env) delete process.env[k];
    process.env.SN_UNITS_VERIFY = '1';
    try {
      const run = (on: boolean) => {
        if (on) delete process.env.SN_FROM_WALK; else process.env.SN_FROM_WALK = '0';
        const units = new Map<string, unknown>(), out: Record<string, ReturnType<typeof compileParts>> = {};
        for (let round = 0; round < 2; round++) for (const [name, body] of Object.entries(PAGES)) out[`${name} ${round}`] = compileParts(page(body), opts(name.replace(/\W+/g, '-'), units));
        return out;
      };
      const off = run(false);
      const taken = FROM_WALK_STATS.taken, before = new Map(FROM_WALK_STATS.fallback);
      const on = run(true);
      for (const k of Object.keys(off)) expect(canonicalText(on[k]!), k).toBe(canonicalText(off[k]!));
      const why: string[] = [];
      for (const [k, n] of FROM_WALK_STATS.fallback) for (let i = before.get(k) ?? 0; i < n; i++) why.push(k);
      return { on, off, taken: FROM_WALK_STATS.taken - taken, why };
    } finally { delete process.env.SN_FROM_WALK; for (const [k, v] of env) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }

  test('the tree rendered: the unit\'s definitions dead in the page, taken out; kept whole where the page keeps them', () => {
    const r = pages();
    // (the two pages whose tree is rendered, in both rounds: the unit taken out; the live tree's page keeps its unit's
    // definitions: the unit kept whole as the page's own, every object of it held and given back, §21)
    expect(r.taken).toBe(6);
    expect(r.why).toEqual([]);
    expect(r.on['a tree from a file 1']!.html).toBe(r.off['a tree from a file 1']!.html);
    expect(r.on['a tree from a file 1']!.html).toContain('<em><span>this</span></em>');
  });
});
