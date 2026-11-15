// What a page shows over constants (expanded at build time) is what it shows over state the browser
// writes (rendered at run time): the same markup over the same values, rendered both ways, compared.
import { describe, expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

const C: Record<string, string> = {
  'x-plain': `<template data-sn-component="{ href?: string; label: string }"><a data-sn-attr="{ href }" data-sn-text="label"></a></template>`,
  'x-if': `<template data-sn-component="{ href?: string; label: string }"><template data-sn-if="href"><a data-sn-attr="{ href }" data-sn-text="label"></a></template></template>`,
  'x-ifelse': `<template data-sn-component="{ href?: string; label: string }"><template data-sn-if="href"><a data-sn-attr="{ href }" data-sn-text="label"></a></template><template data-sn-else><button type="button" data-sn-text="label"></button></template></template>`,
  // a component tag as root
  'x-var': `<template data-sn-component="{ href?: string; label: string }"><x-ifelse class="v" data-sn-prop="{ href, label: label + '!' }"></x-ifelse></template>`,
  // a plain root that holds a component whose root is a chain
  'x-inner': `<template data-sn-component="{ href?: string; label: string }"><span><x-ifelse data-sn-prop="{ href, label }"></x-ifelse></span></template>`,
  // a slot that passes data, as root
  'x-slot': `<template data-sn-component="{ label: string; item: Slot<{ label: string }> }"><slot name="item" data-sn-prop="{ label }"><i data-sn-text="label"></i></slot></template>`,
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
  const ONE = { 'x-one': `<template data-sn-component="{ x: { t: string }; item: Slot<{ x: { t: string } }> }"><div><slot name="item" data-sn-prop="{ x }"><i data-sn-text="x.t"></i></slot></div></template>` };
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
