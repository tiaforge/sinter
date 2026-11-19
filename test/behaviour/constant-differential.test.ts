// What a page shows over constants (expanded at build time) is what it shows over state the browser
// writes (rendered at run time): the same markup over the same values, rendered both ways, compared.
import { describe, expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

const C: Record<string, string> = {
  'x-plain': `<template data-sn-props="{ href?: string; label: string }"><a data-sn-attr="{ href }" data-sn-text="label"></a></template>`,
  'x-if': `<template data-sn-props="{ href?: string; label: string }"><template data-sn-if="href"><a data-sn-attr="{ href }" data-sn-text="label"></a></template></template>`,
  'x-ifelse': `<template data-sn-props="{ href?: string; label: string }"><template data-sn-if="href"><a data-sn-attr="{ href }" data-sn-text="label"></a></template><template data-sn-else><button type="button" data-sn-text="label"></button></template></template>`,
  // a component tag as root
  'x-var': `<template data-sn-props="{ href?: string; label: string }"><x-ifelse class="v" data-sn-prop="{ href, label: label + '!' }"></x-ifelse></template>`,
  // a plain root that holds a component whose root is a chain
  'x-inner': `<template data-sn-props="{ href?: string; label: string }"><span><x-ifelse data-sn-prop="{ href, label }"></x-ifelse></span></template>`,
  // a slot that passes data, as root
  'x-slot': `<template data-sn-props="{ label: string; item: Slot<{ label: string }> }"><slot name="item" data-sn-prop="{ label }"><i data-sn-text="label"></i></slot></template>`,
};
const ITEMS = [{ t: 'a', href: '/a' }, { t: 'b' }, { t: 'c', href: '/c' }];

/** the component's use for row `x`, by case */
const USES: Record<string, string> = {
  plain: `<x-plain data-sn-prop="{ href: x.href, label: x.t }"></x-plain>`,
  if: `<x-if data-sn-prop="{ href: x.href, label: x.t }"></x-if>`,
  ifelse: `<x-ifelse data-sn-prop="{ href: x.href, label: x.t }"></x-ifelse>`,
  var: `<x-var data-sn-prop="{ href: x.href, label: x.t }"></x-var>`,
  inner: `<x-inner data-sn-prop="{ href: x.href, label: x.t }"></x-inner>`,
  slot: `<x-slot data-sn-prop="{ label: x.t }"><b slot="item" data-sn-text="$slot.label + x.t"></b></x-slot>`,
  // a fill that is a chain over `$slot` (and the row)
  'slot chain': `<x-slot data-sn-prop="{ label: x.t }"><template slot="item" data-sn-if="$slot.label == 'b'"><b data-sn-text="$slot.label + x.t"></b></template><template data-sn-else><u data-sn-text="$slot.label"></u></template></x-slot>`,
  // a choice of a component whose root is a component tag
  'choice of a tag root': `<sn-component use="{ v: 'x-var', p: 'x-plain' }[x.href ? 'v' : 'p']" data-sn-prop="{ href: x.href, label: x.t }"></sn-component>`,
  // the tag's attributes land on the root the chain renders
  attrs: `<x-ifelse class="k" data-sn-class="{ on: !!x.href }" data-sn-attr="{ title: x.t }" data-sn-prop="{ href: x.href, label: x.t }"></x-ifelse>`,
};
/** where the use sits in the row */
const PLACES: Record<string, (use: string) => string> = {
  'in an element': (u) => `<li>${u}</li>`,
  'in an if in the row': (u) => `<li><template data-sn-if="x.t">${u}</template></li>`,
  'as the row': (u) => u,
};

/** the page over `d`: constant (nothing writes it), or written by a handler the test never runs */
const page = (body: string, written: boolean) =>
  `<main data-sn-state="{ d: ${JSON.stringify(ITEMS).replace(/"/g, "'")} }">${written ? '<i id="w" data-sn-on-click="d = [...d]"></i>' : ''}<ul><template data-sn-for="x in d">${body}</template></ul></main>`;

/** the rendered markup, without what only one of the two ways leaves (anchors, ids, the handler's element) */
const shown = (root: Element) => {
  const ul = root.querySelector('ul')!.cloneNode(true) as Element;
  const walk = (n: Node) => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 8) c.remove();
      else if (c.nodeType === 1) {
        for (const a of [...(c as Element).attributes]) if (a.name.startsWith('data-sn')) (c as Element).removeAttribute(a.name);
        walk(c);
      }
    }
  };
  walk(ul);
  return ul.innerHTML.replace(/>\s+</g, '><').trim();
};

/** the anchors (comments) the runtime renders lists and branches between */
const anchors = (root: Element) => {
  let n = 0;
  const w = root.ownerDocument.createTreeWalker(root.querySelector('ul')!, 128);
  while (w.nextNode()) n++;
  return n;
};

describe('over constants as over written state', () => {
  for (const [name, use] of Object.entries(USES)) {
    for (const [where, place] of Object.entries(PLACES)) {
      test(`${name}, ${where}`, async () => {
        const body = place(use);
        const fixed = await render(page(body, false), { components: C });
        const live = await render(page(body, true), { components: C });
        await fixed.flush(); await live.flush();
        const want = shown(live.root);
        // the rendered rows differ from one another (the values are each row's)
        expect(want).toMatch(/a[\s\S]*c/);
        expect(shown(fixed.root)).toBe(want);
        // and the constant one was written at build time: no list or branch left for the runtime
        expect(anchors(fixed.root)).toBe(0);
        expect(anchors(live.root)).toBeGreaterThan(0);
      });
    }
  }
});

describe('a fill that is a chain over `$slot`, outside a loop', () => {
  const ONE = { 'x-one': `<template data-sn-props="{ x: { t: string }; item: Slot<{ x: { t: string } }> }"><div><slot name="item" data-sn-prop="{ x }"><i data-sn-text="x.t"></i></slot></div></template>` };
  const fill = `<template slot="item" data-sn-if="$slot.x.t == 'b'"><b data-sn-text="$slot.x.t"></b></template><template data-sn-else><u data-sn-text="$slot.x.t"></u></template>`;
  for (const t of ['b', 'c']) {
    test(`over a literal as over written state: ${t}`, async () => {
      const fixed = await render(`<main><x-one data-sn-prop="{ x: { t: '${t}' } }">${fill}</x-one></main>`, { components: ONE });
      const live = await render(`<main data-sn-state="{ v: { t: '${t}' } }"><i data-sn-on-click="v = { t: 'z' }"></i><x-one data-sn-prop="{ x: v }">${fill}</x-one></main>`, { components: ONE });
      await fixed.flush(); await live.flush();
      const html = (r: { root: Element }) => r.root.querySelector('div')!.innerHTML.replace(/<!--[^]*?-->/g, '').replace(/ data-sn[\w-]*="[^"]*"/g, '');
      expect(html(fixed)).toBe(t === 'b' ? '<b>b</b>' : '<u>c</u>');
      expect(html(fixed)).toBe(html(live));
    });
  }
});

describe('a component tag as the fill of a slot a list places per row', () => {
  const L: Record<string, string> = {
    ...C,
    'x-list': `<template data-sn-props="{ rows: any[]; cell: Slot<{ row: any; i: number }> }"><ul><template data-sn-for="(r, i) in rows"><li><slot name="cell" data-sn-prop="{ row: r, i }"><i data-sn-text="r.n"></i></slot></li></template></ul></template>`,
    'x-cell': `<template data-sn-props="{ v: string; hot?: boolean }"><b data-sn-class="{ hot }" data-sn-text="v"></b></template>`,
    'x-wrap': `<template data-sn-props="{}"><em><slot></slot></em></template>`,
  };
  const ROWS = [{ n: 'a', hot: true }, { n: 'b' }, { n: 'c', hot: true }];
  /** the fill, by case; `extra` is what the page loop adds to a value */
  const FILLS: Record<string, (extra: string) => string> = {
    'its props': (e) => `<x-cell slot="cell" data-sn-prop="{ v: $slot.row.n + $slot.i${e}, hot: $slot.row.hot }"></x-cell>`,
    'the tag\'s class and attributes': (e) => `<x-cell slot="cell" data-sn-class="{ on: !!$slot.row.hot }" data-sn-attr="{ title: $slot.row.n${e} }" data-sn-prop="{ v: $slot.row.n }"></x-cell>`,
    'a chain root': (e) => `<x-ifelse slot="cell" data-sn-prop="{ href: $slot.row.hot ? '/h' : undefined, label: $slot.row.n${e} }"></x-ifelse>`,
    'a component-tag root': (e) => `<x-var slot="cell" data-sn-prop="{ href: $slot.row.hot ? '/h' : undefined, label: $slot.row.n${e} }"></x-var>`,
    'slot content in the fill tag': (e) => `<x-wrap slot="cell"><span data-sn-text="$slot.row.n${e}"></span></x-wrap>`,
    'a nested fill': (e) => `<x-slot slot="cell" data-sn-prop="{ label: $slot.row.n${e} }"><u slot="item" data-sn-text="$slot.label + '.'"></u></x-slot>`,
  };
  const state = (written: boolean) => `data-sn-state="{ d: ${JSON.stringify(ROWS).replace(/"/g, "'")} }">${written ? '<i data-sn-on-click="d = [...d]"></i>' : ''}`;
  const pages: Record<string, (fill: (e: string) => string, written: boolean) => string> = {
    'outside a loop': (f, w) => `<main ${state(w)}<x-list data-sn-prop="{ rows: d }">${f('')}</x-list></main>`,
    'in a page loop': (f, w) => `<main ${state(w)}<template data-sn-for="x in d"><section><x-list data-sn-prop="{ rows: d }">${f(' + x.n')}</x-list></section></template></main>`,
  };
  const out = (root: Element) => {
    const m = root.querySelector('main')!.cloneNode(true) as Element;
    for (const i of [...m.querySelectorAll(':scope > i')]) i.remove();
    const walk = (n: Node) => {
      for (const c of [...n.childNodes]) {
        if (c.nodeType === 8) c.remove();
        else if (c.nodeType === 1) { for (const a of [...(c as Element).attributes]) if (a.name.startsWith('data-sn')) (c as Element).removeAttribute(a.name); walk(c); }
      }
    };
    walk(m);
    return m.innerHTML.replace(/>\s+</g, '><').trim();
  };
  const comments = (root: Element) => { let n = 0; const w = root.ownerDocument.createTreeWalker(root.querySelector('main')!, 128); while (w.nextNode()) n++; return n; };
  for (const [name, fill] of Object.entries(FILLS)) {
    for (const [where, pageOf] of Object.entries(pages)) {
      test(`${name}, ${where}`, async () => {
        const fixed = await render(pageOf(fill, false), { components: L });
        const live = await render(pageOf(fill, true), { components: L });
        await fixed.flush(); await live.flush();
        const want = out(live.root);
        expect(want).toMatch(/a[\s\S]*b[\s\S]*c/);
        expect(out(fixed.root)).toBe(want);
        expect(comments(fixed.root)).toBe(0);
      });
    }
  }
});

describe('fills of a tree placement, in a tree over constants', () => {
  const MAP = "{ p: 'x-p', a: 'x-a', t: 'x-t', h: 'x-h' }";
  const T: Record<string, string> = {
    'x-doc': `<template data-sn-props="{ doc: any; link: Slot<{ href: string }>; heading: Slot<{ node: any }> }"><article><template data-sn-for="b in doc.children"><sn-component use="${MAP}[b.type]" data-sn-prop="{ node: b }"></sn-component></template></article></template>`,
    'x-p': `<template data-sn-props="{ node: any }"><p><template data-sn-for="c in node.children"><sn-component use="${MAP}[c.type]" data-sn-prop="{ node: c }"></sn-component></template></p></template>`,
    'x-h': `<template data-sn-props="{ node: any }"><slot name="heading" data-sn-prop="{ node }"><h3><template data-sn-for="c in node.children"><sn-component use="${MAP}[c.type]" data-sn-prop="{ node: c }"></sn-component></template></h3></slot></template>`,
    'x-t': `<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>`,
    // its default's children through a component whose root is a choice (a phrasing dispatcher)
    'x-a': `<template data-sn-props="{ node: any }"><slot name="link" data-sn-prop="{ href: node.url }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="c in node.children"><x-in data-sn-prop="{ node: c }"></x-in></template></a></slot></template>`,
    'x-in': `<template data-sn-props="{ node: any }"><sn-component use="${MAP}[node.type]" data-sn-prop="{ node }"></sn-component></template>`,
    'x-pill': `<template data-sn-props="{ to: string }"><a class="pill" data-sn-attr="{ href: to }"><slot></slot></a></template>`,
  };
  const t = (value: string) => ({ type: 't', value });
  const DOC = { children: [
    // (a link in the heading: a fill inside a fill that places its children)
    { type: 'h', children: [t('Title '), { type: 'a', url: '/in', children: [t('in')] }] },
    { type: 'p', children: [t('see '), { type: 'a', url: '/one', children: [t('one')] }, t(' and '), { type: 'a', url: '/two', children: [t('two')] }] },
  ] };
  const FILLS: Record<string, string> = {
    'an element with a <slot>': `<a slot="link" class="L" data-sn-attr="{ href: $slot.href }"><slot></slot></a>`,
    'a heading with a <slot>': `<h2 slot="heading"><slot></slot></h2>`,
    'a chain': `<template slot="link" data-sn-if="$slot.href == '/one'"><b data-sn-text="$slot.href"></b></template><template data-sn-else><i data-sn-text="$slot.href"></i></template>`,
    'a component tag with a <slot> in its content': `<x-pill slot="link" data-sn-prop="{ to: $slot.href }"><slot></slot></x-pill>`,
    'an element without a <slot>': `<em slot="link" data-sn-text="$slot.href"></em>`,
  };
  const pageOf = (fill: string, written: boolean) =>
    `<main data-sn-state="{ doc: ${JSON.stringify(DOC).replace(/"/g, "'")} }">${written ? '<i data-sn-on-click="doc = { ...doc }"></i>' : ''}<x-doc data-sn-prop="{ doc }">${fill}</x-doc></main>`;
  const out = (root: Element) => {
    const a = root.querySelector('article')!.cloneNode(true) as Element;
    const walk = (n: Node) => {
      for (const c of [...n.childNodes]) {
        if (c.nodeType === 8) c.remove();
        else if (c.nodeType === 1) { for (const x of [...(c as Element).attributes]) if (x.name.startsWith('data-sn')) (c as Element).removeAttribute(x.name); walk(c); }
      }
    };
    walk(a);
    return a.innerHTML.replace(/>\s+</g, '><').trim();
  };
  const comments = (root: Element) => { let n = 0; const w = root.ownerDocument.createTreeWalker(root.querySelector('article')!, 128); while (w.nextNode()) n++; return n; };
  for (const [name, fill] of Object.entries(FILLS)) {
    test(name, async () => {
      const fixed = await render(pageOf(fill, false), { components: T });
      const live = await render(pageOf(fill, true), { components: T });
      await fixed.flush(); await live.flush();
      const want = out(live.root);
      expect(want).toMatch(/one[\s\S]*two/);
      expect(out(fixed.root)).toBe(want);
      expect(comments(fixed.root)).toBe(0);
    });
  }
});

describe('a choice inside a component over its own prop, choosing a component-tag root over a chain root', () => {
  const B = {
    ...C,
    'x-c2': `<template data-sn-props="{ x: any }"><sn-component use="{ a: 'x-plain', v: 'x-var' }[x.k]" data-sn-prop="{ href: x.href, label: x.t }"></sn-component></template>`,
  };
  const D = "[{ t: 'a', href: '/a', k: 'a' }, { t: 'b', k: 'v' }, { t: 'c', href: '/c', k: 'v' }]";
  const BODIES: Record<string, string> = {
    'in an element of the row': `<ul><template data-sn-for="x in d"><li><x-c2 data-sn-prop="{ x }"></x-c2></li></template></ul>`,
    'as the row': `<ul><template data-sn-for="x in d"><x-c2 data-sn-prop="{ x }"></x-c2></template></ul>`,
    'outside a loop': `<ul><x-c2 data-sn-prop="{ x: d[1] }"></x-c2><x-c2 data-sn-prop="{ x: d[2] }"></x-c2></ul>`,
  };
  for (const [name, body] of Object.entries(BODIES)) {
    test(name, async () => {
      const fixed = await render(`<main data-sn-state="{ d: ${D} }">${body}</main>`, { components: B });
      const live = await render(`<main data-sn-state="{ d: ${D} }"><i data-sn-on-click="d = [...d]"></i>${body}</main>`, { components: B });
      await fixed.flush(); await live.flush();
      expect(shown(fixed.root)).toBe(shown(live.root));
      expect(shown(live.root)).toMatch(/<button[^>]*class="v"[^>]*>b!<\/button>/);
      expect(anchors(fixed.root)).toBe(0);
    });
  }
});

test('a literal text after the text a previous row ended with does not hide the node after it', async () => {
  const D = "[{ on: true, t: 'A', c: [{ t: 'a1' }] }, { on: true, t: 'B', c: [{ t: 'b1' }, { t: 'b2' }] }]";
  const body = `<p><template data-sn-for="x in d"><template data-sn-if="x.on || true"><template data-sn-text="'~'"></template><template data-sn-for="y in x.c"><template data-sn-text="y.t"></template><template data-sn-text="y.t"></template><template data-sn-text="'~'"></template></template></template></template></p>`;
  const fixed = await render(`<main data-sn-state="{ d: ${D} }">${body}</main>`);
  const live = await render(`<main data-sn-state="{ d: ${D} }"><i data-sn-on-click="d = [...d]"></i>${body}</main>`);
  expect(fixed.root.querySelector('p')!.textContent).toBe('~a1a1~~b1b1~b2b2~');
  expect(live.root.querySelector('p')!.textContent).toBe('~a1a1~~b1b1~b2b2~');
  expect(fixed.root.querySelector('p template')).toBeNull();
});
