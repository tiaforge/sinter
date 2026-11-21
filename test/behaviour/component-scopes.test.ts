// A component's names are its own, whatever its root and wherever it is used: inside another component, in
// slot content, in a template in slot content, as a fill. Each case renders the same over constants
// (expanded at build time), over state a handler writes (run time), and with the early script.
import { describe, expect, test } from 'vitest';
import { firstPaint, render } from '../../src/testing/index.js';

const C: Record<string, string> = {
  'x-plain': `<template data-sn-props="{ href?: string; label: string }"><a data-sn-attr="{ href }" data-sn-text="label"></a></template>`,
  'x-ifelse': `<template data-sn-props="{ href?: string; label: string }"><template data-sn-if="href"><a data-sn-attr="{ href }" data-sn-text="label"></a></template><template data-sn-else><button type="button" data-sn-text="label"></button></template></template>`,
  'x-var': `<template data-sn-props="{ href?: string; label: string }"><x-ifelse class="v" data-sn-with="{ href, label: label + '!' }"></x-ifelse></template>`,
  'x-c2': `<template data-sn-props="{ x: any }"><sn-component use="{ a: 'x-plain', v: 'x-var', i: 'x-ifelse' }[x.k]" data-sn-with="{ href: x.href, label: x.t }"></sn-component></template>`,
  // an outer component whose own props have the inner's names, with other values
  'x-out': `<template data-sn-props="{ n: any; href?: string; label: string }"><span><x-ifelse data-sn-with="{ href: n.href, label: n.t }"></x-ifelse></span></template>`,
  'x-outv': `<template data-sn-props="{ n: any; href?: string; label: string }"><span><x-var data-sn-with="{ href: n.href, label: n.t }"></x-var></span></template>`,
  // and one that lacks them
  'x-lack': `<template data-sn-props="{ n: any }"><span><x-ifelse data-sn-with="{ href: n.href, label: n.t }"></x-ifelse></span></template>`,
  'x-lackv': `<template data-sn-props="{ n: any }"><span><x-var data-sn-with="{ href: n.href, label: n.t }"></x-var></span></template>`,
  'x-wrap': `<template data-sn-props="{}"><em><slot></slot></em></template>`,
  'x-slot': `<template data-sn-props="{ label: string; item: Slot<{ label: string }> }"><slot name="item" data-sn-with="{ label }"><i data-sn-text="label"></i></slot></template>`,
};
const D = "[{ t: 'A', href: '/h', on: true, k: 'i', c: [{ t: 'a1' }, { t: 'a2', href: '/a2' }] }, { t: 'B', on: false, k: 'v', c: [] }]";

/** the page's markup with `d` constant, or written by a handler nothing runs */
const page = (body: string, written: boolean) => `<main data-sn-state="{ d: ${D} }">${written ? '<i data-sn-on-click="d = [...d]"></i>' : ''}<div id="b">${body}</div></main>`;
const html = (root: Element) => root.querySelector('#b')!.innerHTML.replace(/<!--[^]*?-->/g, '').replace(/ data-sn[\w-]*="[^"]*"/g, '').replace(/<template[^>]*><\/template>/g, '');

const CASES: Record<string, [string, string]> = {
  // B-2: inside another component
  'a chain root inside a component whose props have its names': [`<x-out data-sn-with="{ n: d[0], label: 'OUTER' }"></x-out>`, '<span><a href="/h">A</a></span>'],
  'a tag root inside a component whose props have its names': [`<x-outv data-sn-with="{ n: d[0], label: 'OUTER' }"></x-outv>`, '<span><a class="v" href="/h">A!</a></span>'],
  'a chain root inside a component that lacks its names': [`<x-lack data-sn-with="{ n: d[1] }"></x-lack>`, '<span><button type="button">B</button></span>'],
  'a tag root inside a component that lacks its names': [`<x-lackv data-sn-with="{ n: d[0] }"></x-lackv>`, '<span><a class="v" href="/h">A!</a></span>'],
  // B-3: a template in slot content
  'a loop in slot content over a chain root': [`<x-wrap><template data-sn-for="y in d[0].c"><x-ifelse data-sn-with="{ href: y.href, label: y.t }"></x-ifelse></template></x-wrap>`, '<em><button type="button">a1</button><a href="/a2">a2</a></em>'],
  'a branch in slot content over a chain root': [`<x-wrap><template data-sn-if="d[0].on"><x-ifelse data-sn-with="{ href: d[0].href, label: d[0].t }"></x-ifelse></template></x-wrap>`, '<em><a href="/h">A</a></em>'],
  'a branch in slot content over a tag root': [`<x-wrap><template data-sn-if="d[0].on"><x-var data-sn-with="{ href: d[0].href, label: d[0].t }"></x-var></template></x-wrap>`, '<em><a class="v" href="/h">A!</a></em>'],
  'a branch in slot content over a choice root': [`<x-wrap><template data-sn-if="d[0].on"><x-c2 data-sn-with="{ x: d[1] }"></x-c2></template></x-wrap>`, '<em><button type="button" class="v">B!</button></em>'],
  // on main: `<sn-component use>` directly in slot content
  'a choice directly in slot content': [`<x-wrap><sn-component use="{ a: 'x-plain', i: 'x-ifelse' }[d[0].k]" data-sn-with="{ href: d[0].href, label: d[0].t }"></sn-component></x-wrap>`, '<em><a href="/h">A</a></em>'],
  // S-1: a slot root filled by a tag-root component
  'a slot root filled by a tag-root component': [`<x-slot data-sn-with="{ label: d[0].t }"><x-var slot="item" data-sn-with="{ href: d[0].href, label: $slot.label + '/' }"></x-var></x-slot>`, '<a class="v" href="/h">A/!</a>'],
  // B4: a component with a named fill, in a loop or a branch in another component's slot content
  'a named fill in a loop in slot content': [`<x-wrap><template data-sn-for="y in d[0].c"><x-slot data-sn-with="{ label: y.t }"><u slot="item" data-sn-text="$slot.label + y.t"></u></x-slot></template></x-wrap>`, '<em><u>a1a1</u><u>a2a2</u></em>'],
  'a chain fill in a loop in slot content': [`<x-wrap><template data-sn-for="y in d[0].c"><x-slot data-sn-with="{ label: y.t }"><template slot="item" data-sn-if="y.href"><b data-sn-text="$slot.label"></b></template><template data-sn-else><s data-sn-text="y.t"></s></template></x-slot></template></x-wrap>`, '<em><s>a1</s><b>a2</b></em>'],
  'a tag fill in a loop in slot content': [`<x-wrap><template data-sn-for="y in d[0].c"><x-slot data-sn-with="{ label: y.t }"><x-ifelse slot="item" data-sn-with="{ href: y.href, label: $slot.label + y.t }"></x-ifelse></x-slot></template></x-wrap>`, '<em><button type="button">a1a1</button><a href="/a2">a2a2</a></em>'],
  'a named fill in a branch in slot content in a page loop': [`<template data-sn-for="x in d"><x-wrap><template data-sn-if="x.on"><x-slot data-sn-with="{ label: x.t }"><u slot="item" data-sn-text="$slot.label + x.t"></u></x-slot></template></x-wrap></template>`, '<em><u>AA</u></em><em></em>'],
};

describe('a component\'s names are its own', () => {
  for (const [name, [body, want]] of Object.entries(CASES)) {
    test(name, async () => {
      const fixed = await render(page(body, false), { components: C });
      const live = await render(page(body, true), { components: C });
      const early = await firstPaint(page(body, true), { components: C });
      await fixed.flush(); await live.flush();
      expect(html(live.root)).toBe(want);
      expect(html(fixed.root)).toBe(want);
      // the first paint: what it renders before the page module (a loop over state the page writes is the module's)
      const first = html(early.root);
      if (/<(a|button)\b/.test(first)) expect(first).toBe(want);
    });
  }
});
