// A component's names are its own, whatever its root and wherever it is used: inside another component, in
// slot content, in a template in slot content, as a fill. Each case renders the same over constants
// (expanded at build time), over state a handler writes (run time), and with the early script.
import { describe, expect, test } from 'vitest';
import { firstPaint, render } from '../../src/testing/index.js';

const C: Record<string, string> = {
  'x-plain': `<template data-sn-component="{ href?: string; label: string }"><a data-sn-attr="{ href }" data-sn-text="label"></a></template>`,
  'x-ifelse': `<template data-sn-component="{ href?: string; label: string }"><template data-sn-if="href"><a data-sn-attr="{ href }" data-sn-text="label"></a></template><template data-sn-else><button type="button" data-sn-text="label"></button></template></template>`,
  'x-var': `<template data-sn-component="{ href?: string; label: string }"><x-ifelse class="v" data-sn-prop="{ href, label: label + '!' }"></x-ifelse></template>`,
  'x-c2': `<template data-sn-component="{ x: any }"><sn-component use="{ a: 'x-plain', v: 'x-var', i: 'x-ifelse' }[x.k]" data-sn-prop="{ href: x.href, label: x.t }"></sn-component></template>`,
  // an outer component whose own props have the inner's names, with other values
  'x-out': `<template data-sn-component="{ n: any; href?: string; label: string }"><span><x-ifelse data-sn-prop="{ href: n.href, label: n.t }"></x-ifelse></span></template>`,
  'x-outv': `<template data-sn-component="{ n: any; href?: string; label: string }"><span><x-var data-sn-prop="{ href: n.href, label: n.t }"></x-var></span></template>`,
  // and one that lacks them
  'x-lack': `<template data-sn-component="{ n: any }"><span><x-ifelse data-sn-prop="{ href: n.href, label: n.t }"></x-ifelse></span></template>`,
  'x-lackv': `<template data-sn-component="{ n: any }"><span><x-var data-sn-prop="{ href: n.href, label: n.t }"></x-var></span></template>`,
  'x-wrap': `<template data-sn-component="{}"><em><slot></slot></em></template>`,
  'x-slot': `<template data-sn-component="{ label: string; item: Slot<{ label: string }> }"><slot name="item" data-sn-prop="{ label }"><i data-sn-text="label"></i></slot></template>`,
};
const D = "[{ t: 'A', href: '/h', on: true, k: 'i', c: [{ t: 'a1' }, { t: 'a2', href: '/a2' }] }, { t: 'B', on: false, k: 'v', c: [] }]";

/** the page's markup with `d` constant, or written by a handler nothing runs */
const page = (body: string, written: boolean) => `<main data-sn-state="{ d: ${D} }">${written ? '<i data-sn-on-click="d = [...d]"></i>' : ''}<div id="b">${body}</div></main>`;
const html = (root: Element) => root.querySelector('#b')!.innerHTML.replace(/<!--[^]*?-->/g, '').replace(/ data-sn[\w-]*="[^"]*"/g, '').replace(/<template[^>]*><\/template>/g, '');

const CASES: Record<string, [string, string]> = {
  // B-2: inside another component
  'a chain root inside a component whose props have its names': [`<x-out data-sn-prop="{ n: d[0], label: 'OUTER' }"></x-out>`, '<span><a href="/h">A</a></span>'],
  'a tag root inside a component whose props have its names': [`<x-outv data-sn-prop="{ n: d[0], label: 'OUTER' }"></x-outv>`, '<span><a class="v" href="/h">A!</a></span>'],
  'a chain root inside a component that lacks its names': [`<x-lack data-sn-prop="{ n: d[1] }"></x-lack>`, '<span><button type="button">B</button></span>'],
  'a tag root inside a component that lacks its names': [`<x-lackv data-sn-prop="{ n: d[0] }"></x-lackv>`, '<span><a class="v" href="/h">A!</a></span>'],
  // B-3: a template in slot content
  'a loop in slot content over a chain root': [`<x-wrap><template data-sn-for="y in d[0].c"><x-ifelse data-sn-prop="{ href: y.href, label: y.t }"></x-ifelse></template></x-wrap>`, '<em><button type="button">a1</button><a href="/a2">a2</a></em>'],
  'a branch in slot content over a chain root': [`<x-wrap><template data-sn-if="d[0].on"><x-ifelse data-sn-prop="{ href: d[0].href, label: d[0].t }"></x-ifelse></template></x-wrap>`, '<em><a href="/h">A</a></em>'],
  'a branch in slot content over a tag root': [`<x-wrap><template data-sn-if="d[0].on"><x-var data-sn-prop="{ href: d[0].href, label: d[0].t }"></x-var></template></x-wrap>`, '<em><a class="v" href="/h">A!</a></em>'],
  'a branch in slot content over a choice root': [`<x-wrap><template data-sn-if="d[0].on"><x-c2 data-sn-prop="{ x: d[1] }"></x-c2></template></x-wrap>`, '<em><button type="button" class="v">B!</button></em>'],
  // on main: `<sn-component use>` directly in slot content
  'a choice directly in slot content': [`<x-wrap><sn-component use="{ a: 'x-plain', i: 'x-ifelse' }[d[0].k]" data-sn-prop="{ href: d[0].href, label: d[0].t }"></sn-component></x-wrap>`, '<em><a href="/h">A</a></em>'],
  // S-1: a slot root filled by a tag-root component
  'a slot root filled by a tag-root component': [`<x-slot data-sn-prop="{ label: d[0].t }"><x-var slot="item" data-sn-prop="{ href: d[0].href, label: $slot.label + '/' }"></x-var></x-slot>`, '<a class="v" href="/h">A/!</a>'],
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
