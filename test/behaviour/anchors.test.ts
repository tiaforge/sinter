// @vitest-environment jsdom
// Anchors as comments (docs/proposals/component-libraries.md, section 1): every list, branch and choice is
// marked by `<!--sn N-->…<!--/sn-->`, its templates in the head. On jsdom: happy-dom mis-parses `<tr>` and
// `<td>` inside a template, today and after this change.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const compile = (html: string, components: Record<string, string> = {}) => compileParts(html, {
  file: '/p/index.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: [], namespaces: {} }, componentNames: Object.keys(components),
  readFile: (f) => { const m = /\/src\/components\/(.+)\.html$/.exec(f); if (m && m[1]! in components) return components[m[1]!]!; throw new Error('missing'); },
});
/** a handler that writes every field: nothing is a build-time constant, so no list is unrolled and no branch decided */
const W = (fields: string) => `<button id="w" data-sn-on-click="${fields}"></button>`;
/** the element children and the comments of `el`, as the browser has them */
const shape = (el: Element) => [...el.childNodes].map((n) => (n.nodeType === 8 ? `<!--${(n as Comment).data}-->` : n.nodeType === 1 ? (n as Element).localName : null)).filter(Boolean);
const toggle = (root: Element, id: string) => (root.querySelector(`#${id}`) as HTMLButtonElement).click();

describe('the markup', () => {
  test('lists and branches are comments in place, their templates in the head or at the end of the body', () => {
    const out = compile('<!doctype html><html><head></head><body><div data-sn-state="{ xs: [1, 2], on: true }"><button data-sn-on-click="on = !on; xs = []">x</button><ul><template data-sn-for="x in xs" data-sn-key="x"><li data-sn-text="x"></li></template></ul><template data-sn-if="on"><b>on</b></template><template data-sn-else><i>off</i></template></div></body></html>');
    expect(out.html).toContain('<ul><!--sn 2--><!--/sn--></ul><!--sn 3--><!--/sn-->');
    expect(out.html).not.toMatch(/<template data-sn/);
    expect(out.html).toMatch(/<template id="sn-t-0"><li><\/li><\/template><template id="sn-t-1"><b>on<\/b><\/template><template id="sn-t-2"><i>off<\/i><\/template><\/body>/);
    // the else is its if's `z`, no node of its own
    const ifs = out.ir.roots.filter((n) => n.b.some((b) => b.k === 'if'));
    expect(ifs).toHaveLength(1);
    expect(ifs[0]!.tag).toBe('#');
    expect(ifs[0]!.b[0]).toMatchObject({ k: 'if', x: 1, z: 2 });
    expect(out.ir.roots.some((n) => n.b.some((b) => (b.k as string) === 'else'))).toBe(false);
  });

  test('`<sn-component use>` is one choice anchor: two comments and one evaluation, whatever the number of candidates', () => {
    const blocks: Record<string, string> = Object.fromEntries(['a', 'b', 'c'].map((k) => [`${k}-block`, `<template data-sn-component="{ block: { type: string } }"><p class="${k}"></p></template>`]));
    const out = compile('<div data-sn-state="{ bs: [{ id: 1, type: \'a\' }] }">' + W('bs = []') + '<template data-sn-for="b in bs" data-sn-key="b.id"><sn-component use="`${b.type}-block`" data-sn-prop="{ block: b }"></sn-component></template></div>', blocks);
    const row = out.ir.templates[out.ir.roots.find((n) => n.b[0]?.k === 'for')!.b[0]!.x!]!;
    expect(row.nodes).toHaveLength(1);
    expect(row.nodes[0]!.b).toEqual([expect.objectContaining({ k: 'ch', c: [expect.any(Number), expect.any(Number), expect.any(Number)] })]);
    // the row is a wrapper (its content is the choice): the page module never clones it, and without an early render
    // its template is not in the page
    expect(row.a).toBe(1);
    expect(out.html).not.toContain('<template id="sn-t-0">');
    // each candidate's definition is a head template
    for (const t of row.nodes[0]!.b[0]!.c!) expect(out.html).toContain(`<template id="sn-t-${t}">`);
  });

  test('foreign content: a list inside <svg> no longer crashes the build; its head template holds an <svg>', () => {
    const out = compile('<div data-sn-state="{ ps: [1, 2] }">' + W('ps = []') + '<svg viewBox="0 0 10 10"><template data-sn-for="p in ps" data-sn-key="p"><circle r="1" data-sn-attr="{ cx: p }"></circle></template></svg></div>');
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(out.html).toMatch(/<svg viewBox="0 0 10 10"><!--sn \d+--><!--\/sn--><\/svg>/);
    expect(out.html).toMatch(/<template id="sn-t-0"><svg><circle r="1"><\/circle><\/svg><\/template>/);
    expect(out.ir.templates[0]!.w).toBe(1);
  });
});

describe('reserved comments: only the exact anchor forms', () => {
  test('the build: `sn`, `sn <digits>`, `/sn` and an empty comment are SN105; every other comment is the author\'s', () => {
    const errs = (c: string) => compile(`<p><!--${c}--></p>`).diagnostics.filter((d) => d.code === 'SN105').length;
    for (const c of ['sn', 'sn 4', '/sn', '']) expect(errs(c), c).toBe(1);
    for (const c of ['snippet', ' snapshot ', ' sn notes ', 'sn4', 'sn x', '/snap', 'SN', ' sn ']) expect(errs(c), c).toBe(0);
  });

  test('the page: author comments beside and in a list are left alone, by the runtime and the early script', async () => {
    const page = `<!doctype html><html><head><script type="application/json" data-sn-data="all">{"c":[{"id":1,"name":"Ada"}]}</script></head><body>
      <sn-resource name="all" src="/api/all" items="c" key="id"></sn-resource>
      <!--snippet--><ul><!-- snapshot --><template data-sn-for="c in all"><li data-sn-text="c.name"></li></template><!-- sn notes --></ul></body></html>`;
    const { root, settle, warnings } = await render(page, { firstPaint: true });
    await settle();
    expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['Ada']);
    expect(shape(root.querySelector('ul')!)).toEqual(['<!-- snapshot -->', expect.stringMatching(/^<!--sn \d+-->$/), 'li', '<!--/sn-->', '<!-- sn notes -->']);
    expect(warnings()).toEqual([]);
  });
});

describe('the runtime', () => {
  test('a list keeps its rows between its comments; :first-child is the first row', async () => {
    const { root, state, flush } = await render('<div data-sn-state="{ xs: [1, 2, 3] }">' + W('xs = []') + '<ul><template data-sn-for="x in xs" data-sn-key="x"><li data-sn-text="x"></li></template></ul></div>');
    const ul = root.querySelector('ul')!;
    expect(shape(ul)).toEqual(['<!--sn 2-->', 'li', 'li', 'li', '<!--/sn-->']);
    expect(ul.querySelector('li:first-child')!.textContent).toBe('1');
    const [a, , c] = [...ul.querySelectorAll('li')];
    state(root.querySelector('div')!).update((s) => { (s.xs as number[]).reverse(); });
    await flush();
    expect([...ul.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['3', '2', '1']);
    expect(ul.querySelector('li:first-child')).toBe(c);
    expect(ul.querySelector('li:last-child')).toBe(a);
    state(root.querySelector('div')!).update((s) => { s.xs = []; });
    await flush();
    expect(shape(ul)).toEqual(['<!--sn 2-->', '<!--/sn-->']);
    // comments do not count for `:empty`: an empty list matches it, as plain HTML would
    expect(ul.matches(':empty')).toBe(true);
  });

  test('a branch and its else, rows whose content renders nothing', async () => {
    const { root } = await render(`<div data-sn-state="{ on: true, xs: [1, 2] }"><button id="t" data-sn-on-click="on = !on; xs = xs">t</button>
      <section><template data-sn-if="on"><b>on</b></template><template data-sn-else><i>off</i></template></section>
      <ol><template data-sn-for="x in xs" data-sn-key="x"><template data-sn-if="!on"><li data-sn-text="x"></li></template></template></ol></div>`);
    const sec = root.querySelector('section')!, ol = root.querySelector('ol')!;
    const id = (el: Element) => shape(el)[0];
    expect(shape(sec)).toEqual([id(sec), 'b', '<!--/sn-->']);
    // each row is a wrapper (its content is one if): no comments of its own; an empty comment holds its place while
    // its branch renders nothing
    expect(shape(ol)).toEqual([id(ol), '<!---->', '<!---->', '<!--/sn-->']);
    toggle(root, 't');
    await Promise.resolve();
    expect(shape(sec)).toEqual([id(sec), 'i', '<!--/sn-->']);
    expect(shape(ol)).toEqual([id(ol), 'li', 'li', '<!--/sn-->']);
    // and back: the placeholders again, the list's own rows kept
    toggle(root, 't');
    await Promise.resolve();
    expect(shape(ol)).toEqual([id(ol), '<!---->', '<!---->', '<!--/sn-->']);
  });

  test('table rows and cells, options of a <select>, and SVG elements render as the parser would', async () => {
    const { root } = await render(`<div data-sn-state="{ rs: [{ id: 1, cs: ['a', 'b'] }, { id: 2, cs: ['c'] }], os: ['x', 'y'], ps: [1, 2], sel: 'y' }">${W('rs = []; os = []; ps = []')}
      <table><tbody><template data-sn-for="r in rs" data-sn-key="r.id"><tr><template data-sn-for="c in r.cs" data-sn-key="c"><td data-sn-text="c"></td></template></tr></template></tbody></table>
      <select data-sn-model="sel"><template data-sn-for="o in os" data-sn-key="o"><option data-sn-attr="{ value: o }" data-sn-text="o"></option></template></select>
      <svg viewBox="0 0 10 10"><template data-sn-for="p in ps" data-sn-key="p"><circle r="1" data-sn-attr="{ cx: p }"></circle></template></svg></div>`);
    expect([...root.querySelectorAll('tbody > tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent).join(''))).toEqual(['ab', 'c']);
    expect(shape(root.querySelector('tbody')!).slice(1)).toEqual(['tr', 'tr', '<!--/sn-->']);
    expect([...root.querySelectorAll('option')].map((o) => o.value)).toEqual(['x', 'y']);
    expect((root.querySelector('select') as HTMLSelectElement).value).toBe('y');
    const circles = [...root.querySelectorAll('circle')];
    expect(circles.map((c) => c.getAttribute('cx'))).toEqual(['1', '2']);
    expect(circles.every((c) => c.namespaceURI === 'http://www.w3.org/2000/svg')).toBe(true);
  });

  test('a list inside a closed dialog renders when it opens', async () => {
    const { root } = await render(`<div data-sn-state="{ xs: [1, 2] }">${W('xs = []')}<dialog id="d"><ul><template data-sn-for="x in xs" data-sn-key="x"><li data-sn-text="x"></li></template></ul></dialog></div>`);
    const d = root.querySelector('dialog') as HTMLDialogElement;
    expect(d.querySelectorAll('li')).toHaveLength(0);
    d.setAttribute('open', '');
    d.dispatchEvent(new Event('toggle'));
    await Promise.resolve();
    expect([...d.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['1', '2']);
  });

  test('a choice switches its one row, and a tree renders at any depth', async () => {
    const C = {
      'x-p': `<template data-sn-component="{ node: any }"><p><template data-sn-for="n in node.children"><sn-component use="{ text: 'x-text', em: 'x-em' }[n.type]" data-sn-prop="{ node: n }"></sn-component></template></p></template>`,
      'x-em': `<template data-sn-component="{ node: any }"><em><template data-sn-for="n in node.children"><sn-component use="{ text: 'x-text', em: 'x-em' }[n.type]" data-sn-prop="{ node: n }"></sn-component></template></em></template>`,
      'x-text': '<template data-sn-component="{ node: any }"><span data-sn-text="node.value"></span></template>',
    };
    const { root, state, flush } = await render(`<div data-sn-state="{ doc: { children: [{ type: 'p', children: [{ type: 'text', value: 'a' }, { type: 'em', children: [{ type: 'em', children: [{ type: 'text', value: 'b' }] }] }] }] } }">${W('doc = null')}
      <template data-sn-for="b in doc.children"><sn-component use="{ p: 'x-p' }[b.type]" data-sn-prop="{ node: b }"></sn-component></template></div>`, { components: C });
    const p = root.querySelector('p')!;
    expect(p.textContent).toBe('ab');
    expect(p.querySelector('em > em > span')!.textContent).toBe('b');
    // per rendered node: its element and the two comments of its anchor; the templates are the head ones
    expect(root.querySelector('div')!.querySelectorAll('template')).toHaveLength(0);
    state(root.querySelector('div')!).update((s) => { s.doc.children[0].children[1] = { type: 'text', value: 'c' }; });
    await flush();
    expect(p.textContent).toBe('ac');
    expect(p.querySelector('em')).toBeNull();
  });

  test('a recursive component whose props are the same values again does not render its subtree again; another value does', async () => {
    // `cap` depends on `big`, as a limit passed down a tree does: a click changes `big`, which reaches every choice
    // and definition, and each gets a new props object of the same values. The tree's texts count their reads:
    // a forced render of a subtree reads them all again
    const C = {
      'x-n': `<template data-sn-component="{ node: any; cap: number }"><b><template data-sn-for="n in node.children"><sn-component use="{ text: 'x-t', el: 'x-n' }[n.type]" data-sn-prop="{ node: n, cap }"></sn-component></template></b></template>`,
      'x-t': '<template data-sn-component="{ node: any; cap: number }"><span><template data-sn-text="node.value"></template><i data-sn-text="cap"></i></span></template>',
    };
    let reads = 0;
    // (`toJSON`: the dev tools serialize the state; that is not a read of the render)
    const text = (v: string) => ({ type: 'text', get value() { reads++; return v; }, toJSON: () => ({ type: 'text', value: v }) });
    const tree = () => ({ children: [{ type: 'el', children: [text('a'), { type: 'el', children: [text('b'), text('c')] }] }] });
    const { root, state, flush } = await render(`<div data-sn-state="{ doc: tree(), big: false, n: 1 }">
      <button id="big" data-sn-on-click="big = !big"></button><button id="n" data-sn-on-click="n = n + 1"></button>${W('doc = null')}
      <template data-sn-for="b in doc.children"><sn-component use="{ el: 'x-n' }[b.type]" data-sn-prop="{ node: b, cap: big ? n : n }"></sn-component></template></div>`, { components: C, helpers: { tree } });
    const out = () => root.querySelector('b')!.textContent;
    expect(out()).toBe('a1b1c1');
    reads = 0;
    toggle(root, 'big');
    await flush();
    expect(out()).toBe('a1b1c1');
    expect(reads).toBe(0);
    // a prop that is another value renders the subtree again
    toggle(root, 'n');
    await flush();
    expect(out()).toBe('a2b2c2');
    expect(reads).toBeGreaterThan(0);
    // a change inside a prop's value, the node the same object, still renders
    state(root.querySelector('div')!).update((s) => { s.doc.children[0].children[1].children[1] = { type: 'text', value: 'd' }; });
    await flush();
    expect(out()).toBe('a2b2d2');
  });

  test('a tree replaced by a copy of the path to a change: that path renders again, the components beside it whose props are the same do not', async () => {
    // a tree that grows the way a stream or a progressive render grows it: each change is a new root, a copy of the
    // elements down to where a node was added, the rest shared. Rows are keyed by the nodes' ids, so a copy keeps its
    // row (by object, it would be a new row). The texts count their reads: a render of a component that did not change
    // would read them again
    const C = {
      'x-n': `<template data-sn-component="{ node: any }"><b><template data-sn-for="n in node.children" data-sn-key="n.id"><sn-component use="{ text: 'x-t', el: 'x-n' }[n.type]" data-sn-prop="{ node: n }"></sn-component></template></b></template>`,
      'x-t': '<template data-sn-component="{ node: any }"><span><template data-sn-text="node.value"></template></span></template>',
    };
    let reads = 0;
    const text = (v: string) => ({ type: 'text', id: v, get value() { reads++; return v; }, toJSON: () => ({ type: 'text', id: v, value: v }) });
    // an element beside the path that grows (`l`, with its own text) and the one it grows in (`i`)
    const tree = () => ({ children: [{ type: 'el', id: 'o', children: [{ type: 'el', id: 'l', children: [text('a')] }, { type: 'el', id: 'i', children: [text('b')] }] }] });
    // the copy: the root, the outer element and the inner one, with a text added to the inner one
    const grow = (d: any, v: string) => {
      const [outer] = d.children, inner = outer.children[1];
      return { children: [{ ...outer, children: [outer.children[0], { ...inner, children: [...inner.children, text(v)] }] }] };
    };
    const { root, flush } = await render(`<div data-sn-state="{ doc: tree() }">
      <button id="grow" data-sn-on-click="doc = grow(doc, 'c')"></button><button id="push" data-sn-on-click="doc.children[0].children[1].children.push({ type: 'text', id: 'd', value: 'd' })"></button>
      <template data-sn-for="b in doc.children" data-sn-key="b.id"><sn-component use="{ el: 'x-n' }[b.type]" data-sn-prop="{ node: b }"></sn-component></template></div>`, { components: C, helpers: { tree, grow } });
    const out = () => root.querySelector('b')!.textContent;
    expect(out()).toBe('ab');
    reads = 0;
    toggle(root, 'grow');
    await flush();
    expect(out()).toBe('abc');
    // the new text's read only (its row is new): `a` and `b` are not read again (6 reads when every component below
    // the copied path rendered again)
    expect(reads).toBe(1);
    // a change in place, through a path into the same objects, still renders to the bottom
    toggle(root, 'push');
    await flush();
    expect(out()).toBe('abcd');
  });

  test('a copy of the path through a component used inside itself, with tree slots: what is beside the path does not render again', async () => {
    // as a document library is built: a root that declares a tree slot, a component used inside itself by its tag
    // (a definition: one row, its item the props), whose loop over a prop is a computed list, the slot's fills passed
    // down in the props (an object built at each evaluation)
    const C = {
      'x-doc': `<template data-sn-component="{ doc: any; link: Slot<{ node: any }> }"><div><template data-sn-for="b in doc.children" data-sn-key="b.id"><x-n data-sn-prop="{ node: b }"></x-n></template></div></template>`,
      'x-n': `<template data-sn-component="{ node: any }"><b><template data-sn-for="n in node.children" data-sn-key="n.id"><template data-sn-if="n.type === 'text'"><span data-sn-text="n.value"></span></template><template data-sn-else><template data-sn-if="n.type === 'a'"><slot name="link" data-sn-prop="{ node: n }"><i>link</i></slot></template><template data-sn-else><x-n data-sn-prop="{ node: n }"></x-n></template></template></template></b></template>`,
    };
    const reads: Record<string, number> = {};
    const text = (v: string) => ({ type: 'text', id: v, get value() { reads[v] = (reads[v] ?? 0) + 1; return v; }, toJSON: () => ({ type: 'text', id: v, value: v }) });
    const tree = () => ({ children: [{ type: 'el', id: 'o', children: [{ type: 'el', id: 'l', children: [text('a'), { type: 'a', id: 'x', children: [] }] }, { type: 'el', id: 'i', children: [text('b')] }] }] });
    const grow = (d: any, v: string) => {
      const [outer] = d.children, inner = outer.children[1];
      return { children: [{ ...outer, children: [outer.children[0], { ...inner, children: [...inner.children, text(v)] }] }] };
    };
    const { root, flush } = await render(`<div data-sn-state="{ doc: tree() }"><button id="grow" data-sn-on-click="doc = grow(doc, 'c')"></button><x-doc data-sn-prop="{ doc }"></x-doc></div>`, { components: C, helpers: { tree, grow } });
    const out = () => root.querySelector('b')!.textContent;
    expect(out()).toBe('alinkb');
    for (const k in reads) delete reads[k];
    toggle(root, 'grow');
    await flush();
    expect(out()).toBe('alinkbc');
    // the new text, and \`b\`: the copied element's own content renders again; \`a\`, beside the path, does not (read
    // again when the fills passed down, or the computed list of a component's own row, forced what is below)
    expect(reads).toEqual({ b: 1, c: 1 });
  });
});

describe('first paint and takeover', () => {
  const data = JSON.stringify({ c: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }] });
  const page = `<!doctype html><html><head><script type="application/json" data-sn-data="all">${data}</script></head><body>
    <sn-resource name="all" src="/api/all" items="c" key="id"></sn-resource>
    <ul><template data-sn-for="c in all"><li data-sn-text="c.name"></li></template></ul></body></html>`;

  test('the early script renders the rows between the comments, and the page module adopts them: the same nodes', async () => {
    let early: Element[] = [];
    const { root, settle } = await render(page, { firstPaint: { afterEarly: () => { early = [...document.querySelectorAll('li')]; } } });
    await settle();
    expect(early.map((l) => l.textContent)).toEqual(['Ada', 'Grace']);
    expect([...root.querySelectorAll('li')]).toEqual(early);
    expect(shape(root.querySelector('ul')!)).toEqual(['<!--sn 1-->', 'li', 'li', '<!--/sn-->']);
  });

  test('an early render that failed (nodes between the comments, no mark on the start) is cleared, not doubled', async () => {
    const { root, settle } = await render(page, {
      requests: mockRequests({}),
      firstPaint: {
        afterEarly: () => {
          // what an early render that threw halfway would leave: nodes, and no adoption mark
          const start = [...document.querySelector('ul')!.childNodes].find((n) => n.nodeType === 8)! as Comment;
          delete (start as any)[Symbol.for('sinter.early.rows')];
          start.after(document.createElement('li'));
        },
      },
    });
    await settle();
    expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['Ada', 'Grace']);
  });

  test('a stripped, duplicated or unpaired anchor is a dev warning', async () => {
    const strip = (f: (ul: Element) => void) => ({ strict: false as const, firstPaint: { afterEarly: () => f(document.querySelector('ul')!) } });
    const comments = (ul: Element) => [...ul.childNodes].filter((n) => n.nodeType === 8) as Comment[];
    // a minifier that strips comments: the list is not bound
    const gone = await render(page, { requests: mockRequests({}), ...strip((ul) => { for (const c of comments(ul)) c.remove(); }) });
    expect(gone.warnings().map((w) => w.code)).toContain(2);
    // the start twice
    const twice = await render(page, { requests: mockRequests({}), ...strip((ul) => ul.prepend(document.createComment('sn 1'))) });
    expect(twice.warnings().map((w) => w.code)).toContain(1);
    // no end: one is added, and the list renders
    const open = await render('<div data-sn-state="{ xs: [1] }">' + W('xs = []') + '<ul><template data-sn-for="x in xs" data-sn-key="x"><li data-sn-text="x"></li></template></ul></div>', { strict: false, firstPaint: { afterEarly: () => { comments(document.querySelector('ul')!).at(-1)!.remove(); } } });
    expect(open.warnings().map((w) => w.code)).toContain(31);
    expect(open.root.querySelectorAll('li')).toHaveLength(1);
  });

  test('first paint of a branch: rendered before the page module, adopted after', async () => {
    const { root } = await firstPaint('<div data-sn-state="{ on: true }">' + W('on = !on') + '<template data-sn-if="on"><b>on</b></template><template data-sn-else><i>off</i></template></div>');
    expect(shape(root.querySelector('div')!).slice(1)).toEqual(['<!--sn 2-->', 'b', '<!--/sn-->']);
  });
});
