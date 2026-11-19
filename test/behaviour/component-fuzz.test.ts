// @vitest-environment jsdom
// Random nested components (plain, if/else, component-tag, slot and choice roots, with fills and slot content),
// loops, branches and texts, over one list: after a state change the page must equal a fresh render of the new
// state, the build over constants, and the early script's first paint taken over by the page module.
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';
import { reset as resetCore } from '../core-flags.js';

/** a small seeded PRNG, so a failure names its case */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const CHOICE = "{ p: 'c-plain', c: 'c-chain', t: 'c-tag', l: 'c-list' }";
const COMPONENTS: Record<string, string> = {
  'c-plain': `<template data-sn-props="{ x: any }"><b data-sn-text="x.t"></b></template>`,
  'c-chain': `<template data-sn-props="{ x: any }"><template data-sn-if="x.on"><i data-sn-text="x.t"></i></template><template data-sn-else><u data-sn-text="x.t + '!'"></u></template></template>`,
  'c-tag': `<template data-sn-props="{ x: any }"><c-chain class="t" data-sn-prop="{ x }"></c-chain></template>`,
  'c-slot': `<template data-sn-props="{ x: any; item: Slot<{ x: any }> }"><slot name="item" data-sn-prop="{ x }"><s data-sn-text="x.t"></s></slot></template>`,
  'c-wrap': `<template data-sn-props="{}"><em><slot></slot></em></template>`,
  'c-list': `<template data-sn-props="{ x: any }"><ol><template data-sn-for="y in x.c"><li><c-chain data-sn-prop="{ x: y }"></c-chain></li></template></ol></template>`,
  'c-choice': `<template data-sn-props="{ x: any }"><sn-component use="${CHOICE}[x.k]" data-sn-prop="{ x }"></sn-component></template>`,
  // a component whose props have the inner component's names, with other values
  'c-out': `<template data-sn-props="{ n: any; x?: any }"><span><c-chain data-sn-prop="{ x: n }"></c-chain></span></template>`,
};

/** `<c-slot>` over `v` with a named fill that reads `$slot` and `v` */
function namedFill(pick: <T>(xs: T[]) => T, v: string): string {
  const fill = pick([
    `<q slot="item" data-sn-text="$slot.x.t + ${v}.t"></q>`,
    `<template slot="item" data-sn-if="${v}.on"><q data-sn-text="$slot.x.t"></q></template><template data-sn-else><s data-sn-text="${v}.t"></s></template>`,
    `<c-chain slot="item" data-sn-prop="{ x: { t: $slot.x.t + ${v}.t, on: ${v}.on } }"></c-chain>`,
  ]);
  return `<c-slot data-sn-prop="{ x: ${v} }">${fill}</c-slot>`;
}

/** markup over the item `v`, `depth` levels of nesting left */
function markup(r: () => number, v: string, depth: number): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const n = 1 + Math.floor(r() * 2);
  let out = '';
  for (let i = 0; i < n; i++) {
    const kinds = depth > 0
      ? ['text', 'el', 'plain', 'chain', 'tag', 'choice', 'out', 'list', 'slot', 'slot-tag', 'wrap', 'if', 'for', 'use', 'wrap-for-fill', 'wrap-if-fill']
      : ['text', 'el', 'plain', 'chain', 'tag', 'choice', 'out', 'list'];
    switch (pick(kinds)) {
      case 'text': out += `<template data-sn-text="${v}.t"></template>`; break;
      case 'el': out += `<p data-sn-text="${v}.t"></p>`; break;
      case 'plain': out += `<c-plain data-sn-prop="{ x: ${v} }"></c-plain>`; break;
      case 'chain': out += `<c-chain data-sn-prop="{ x: ${v} }"></c-chain>`; break;
      case 'tag': out += `<c-tag data-sn-prop="{ x: ${v} }"></c-tag>`; break;
      case 'choice': out += `<c-choice data-sn-prop="{ x: ${v} }"></c-choice>`; break;
      case 'out': out += `<c-out data-sn-prop="{ n: ${v}, x: { t: 'OUT', on: true } }"></c-out>`; break;
      case 'list': out += `<c-list data-sn-prop="{ x: ${v} }"></c-list>`; break;
      case 'slot': out += `<c-slot data-sn-prop="{ x: ${v} }"><q slot="item" data-sn-text="$slot.x.t + ${v}.t"></q></c-slot>`; break;
      // a slot root with a named fill (an element, a chain or a component tag), in a loop or a branch in other slot content
      case 'wrap-for-fill': { const w = v + 'y'; out += `<c-wrap><template data-sn-for="${w} in ${v}.c">${namedFill(pick, w)}</template></c-wrap>`; break; }
      case 'wrap-if-fill': out += `<c-wrap><template data-sn-if="${v}.on">${namedFill(pick, v)}</template></c-wrap>`; break;
      case 'slot-tag': { const c = pick(['c-plain', 'c-chain', 'c-tag']); out += `<c-slot data-sn-prop="{ x: ${v} }"><${c} slot="item" data-sn-prop="{ x: $slot.x }"></${c}></c-slot>`; break; }
      case 'wrap': out += `<c-wrap>${markup(r, v, depth - 1)}</c-wrap>`; break;
      case 'if': out += `<template data-sn-if="${v}.on">${markup(r, v, depth - 1)}</template>`; break;
      case 'for': { const w = v + 'y'; out += `<template data-sn-for="${w} in ${v}.c">${markup(r, w, depth - 1)}</template>`; break; }
      case 'use': out += `<sn-component use="${CHOICE}[${v}.k]" data-sn-prop="{ x: ${v} }"></sn-component>`; break;
    }
  }
  return out;
}

function data(r: () => number, depth: number): unknown[] {
  return Array.from({ length: Math.floor(r() * 3) }, (_, i) => ({
    on: r() < 0.5, t: 'T' + i + Math.floor(r() * 9), k: ['p', 'c', 't', 'l'][Math.floor(r() * 4)], c: depth > 0 ? data(r, depth - 1) : [],
  }));
}

/** the content as the user sees it: elements with their class, and text; no comments */
function shape(n: Node): string {
  let s = '';
  for (const c of n.childNodes) {
    if (c.nodeType === 3) s += (c as Text).data;
    else if (c.nodeType === 1 && (c as Element).localName !== 'template') {
      const e = c as Element, cls = e.getAttribute('class');
      s += `<${e.localName}${cls ? `.${cls}` : ''}>${shape(c)}</${e.localName}>`;
    }
  }
  return s;
}

const lit = (x: unknown) => JSON.stringify(x).replace(/"/g, "'");
const SEEDS = Number(process.env.SN_FUZZ_SEEDS ?? 300), DEPTH = Number(process.env.SN_FUZZ_DEPTH ?? 2);

test('random nested components: a state change renders what a fresh render, the constant build and the early takeover render', async () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    // each seed on the smallest core for its page (test/core-flags.ts)
    resetCore();
    const r = rng(seed);
    const body = markup(r, 'x', DEPTH);
    const tpl = `<template data-sn-for="x in d">${body}</template>`;
    const a = data(r, 2), b = data(r, 2);
    const page = (init: unknown, writes: boolean) => `<div data-sn-state="{ d: ${lit(init)} }">${writes ? `<button id="w" data-sn-on-click="d = ${lit(b)}">w</button>` : ''}<main>${tpl}</main></div>`;
    const seen = (root: Element) => shape(root.querySelector('main')!);
    try {
      const updated = await render(page(a, true), { components: COMPONENTS });
      (updated.root.querySelector('#w') as HTMLButtonElement).click();
      await updated.settle();
      const fresh = seen((await render(page(b, true), { components: COMPONENTS })).root);
      const after = seen(updated.root);
      const built = seen((await render(page(b, false), { components: COMPONENTS })).root);
      const early = await render(page(b, true), { components: COMPONENTS, firstPaint: true });
      await early.settle();
      const took = seen(early.root);
      for (const [what, got] of [['after a change', after], ['over constants', built], ['early, taken over', took]] as const) {
        if (got !== fresh) failures.push(`seed ${seed} ${what}: ${tpl}\n  data ${lit(b)}\n  got   ${got}\n  fresh ${fresh}`);
      }
    } catch (e) {
      failures.push(`seed ${seed}: ${tpl}\n  ${(e as Error).message.split('\n').slice(0, 3).join(' ')}`);
    }
  }
  expect(failures).toEqual([]);
}, Math.max(300_000, SEEDS * DEPTH * 300));
