// Stage 5, step B1 (docs/proposals/redesign-notes/stage5-b1.md): a page whose second pass applies only branches decided
// at the page's level takes the second pass's result from its first pass's walk (`fromWalk`). Each case is compiled
// with the route off (`SN_FROM_WALK=0`) and on: the two must be the same up to numbering (`canonicalText`), and the
// test says which route the second pass took (`FROM_WALK_STATS`), or why it was compiled again.
import { afterEach, describe, expect, test } from 'vitest';
import { compileParts, FROM_WALK_STATS, type CompileOptions } from '../../src/compiler/compile.js';
import { canonicalText } from '../../src/compiler/canon.js';

const C: Record<string, string> = {
  'x-card': '<template data-sn-props="{ t: string }"><article class="card"><h3 data-sn-text="t"></h3><slot></slot></article></template><style>.card { margin: 0 }</style>',
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

  test('minified, with white space around the branch', () => {
    const r = both(page('<div data-sn-state="{ a: true }">\n  <span>x</span>\n  <template data-sn-if="a">\n    <b> y </b>\n  </template>\n  <span>z</span>\n</div>'), { minify: true });
    expect(r).toMatchObject({ taken: 1, why: [] });
  });
});

describe('compiled again: each reason', () => {
  test('a build-time resource decides the branch, and its values are folded into the code that reads them', () => {
    const r = both(page('<sn-resource name="post" src="file:/content/post.json"></sn-resource><h1 data-sn-text="post.title"></h1><template data-sn-if="!post.draft"><p data-sn-text="post.tags.join(\', \')"></p></template>'));
    expect(r).toMatchObject({ taken: 0, why: ['values folded into the code'] });
  });

  test('rendered rows the minifier reads with a layout (the browser\'s own styles)', () => {
    const r = both(page('<ul><template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template></ul>'), { minify: { styles: [] } } as Partial<CompileOptions>);
    expect(r).toMatchObject({ taken: 0, why: ['rendered rows and a layout'] });
  });


  test('diagnostics in a decided branch', () => {
    const r = both(page('<div data-sn-state="{ a: true }"><template data-sn-if="a"><p data-sn-text="a" data-sn-key="x"></p></template></div>'));
    expect(r).toMatchObject({ taken: 0, why: ['diagnostics in a decided branch'] });
  });

  test('a definition compiled first in a decided branch, used by the page (live data)', () => {
    const r = both(page('<div data-sn-state="{ a: true, t: { name: \'r\', kids: [] } }"><button data-sn-on-click="t = { name: \'s\', kids: [] }">x</button><template data-sn-if="a"><ul><x-tree data-sn-with="{ n: t }"></x-tree></ul></template></div>'));
    expect(r).toMatchObject({ taken: 0, why: ['a definition compiled first in a decided branch, used by the page'] });
  });

  test('an else-if decided', () => {
    const r = both(page('<div data-sn-state="{ a: false, b: true, c: 0 }"><button data-sn-on-click="c++">+</button><template data-sn-if="c"><i>c</i></template><template data-sn-else data-sn-if="b"><b>b</b></template></div>'));
    expect(r).toMatchObject({ taken: 0, why: ['an else-if decided'] });
  });

  test('code the decided branch compiled first, compiled again elsewhere (its site would be the branch\'s)', () => {
    const r = both(page('<div data-sn-state="{ a: true, n: 0 }"><button data-sn-on-click="n++">+</button><template data-sn-if="a"><b>a</b></template><p data-sn-show="a"></p></div>'));
    expect(r).toMatchObject({ taken: 0, why: ['code a decided branch compiled first is compiled elsewhere too'] });
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

  test('state beside the entry: the page\'s ids and its module', () => {
    const r = entries(template('<section data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button><template data-sn-if="!p.draft"><p data-sn-text="p.title + n"></p></template></section>'));
    expect(r.taken + r.why.filter((w) => w === 'values folded into the code').length).toBe(r.n);
    expect(r.on.map((x) => x.html)).toEqual(r.off.map((x) => x.html));
  });
});
