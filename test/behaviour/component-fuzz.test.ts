// @vitest-environment jsdom
// Random nested components (plain, if/else, component-tag, slot and choice roots, with fills and slot content; one
// without props, declared by its bare `<template>`; lists with an empty state: in a root, a fill, slot content, rows),
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

const CHOICE = "{ p: 'c-plain', c: 'c-chain', t: 'c-tag', l: 'c-list', e: 'c-empty' }";
const COMPONENTS: Record<string, string> = {
  'c-plain': `<template data-sn-props="{ x: any }"><b data-sn-text="x.t"></b></template>`,
  'c-chain': `<template data-sn-props="{ x: any }"><template data-sn-if="x.on"><i data-sn-text="x.t"></i></template><template data-sn-else><u data-sn-text="x.t + '!'"></u></template></template>`,
  'c-tag': `<template data-sn-props="{ x: any }"><c-chain class="t" data-sn-with="{ x }"></c-chain></template>`,
  'c-slot': `<template data-sn-props="{ x: any; item: Slot<{ x: any }> }"><slot name="item" data-sn-with="{ x }"><s data-sn-text="x.t"></s></slot></template>`,
  'c-wrap': `<template data-sn-props="{}"><em><slot></slot></em></template>`,
  // no props: the file's one `<template>` is the declaration, without `data-sn-props`
  'c-bare': `<template><kbd><slot><s>none</s></slot></kbd></template>`,
  'c-list': `<template data-sn-props="{ x: any }"><ol><template data-sn-for="y in x.c"><li><c-chain data-sn-with="{ x: y }"></c-chain></li></template></ol></template>`,
  // a list with its empty state in the root element
  'c-empty': `<template data-sn-props="{ x: any }"><ol><template data-sn-for="y in x.c.filter((z) => z.on)"><li><c-plain data-sn-with="{ x: y }"></c-plain></li></template><template data-sn-else><li data-sn-text="x.t + ' none'"></li></template></ol></template>`,
  'c-choice': `<template data-sn-props="{ x: any }"><sn-component use="${CHOICE}[x.k]" data-sn-with="{ x }"></sn-component></template>`,
  // a link root, whose `href` its tag gives (`data-sn-href`)
  'c-link': `<template data-sn-props="{ x: any }"><a data-sn-text="x.t"></a></template>`,
  // a component whose props have the inner component's names, with other values
  'c-out': `<template data-sn-props="{ n: any; x?: any }"><span><c-chain data-sn-with="{ x: n }"></c-chain></span></template>`,
};

/** `<c-slot>` over `v` with a named fill that reads `$slot` and `v` */
function namedFill(pick: <T>(xs: T[]) => T, v: string): string {
  const fill = pick([
    `<q slot="item" data-sn-text="$slot.x.t + ${v}.t"></q>`,
    `<template slot="item" data-sn-if="${v}.on"><q data-sn-text="$slot.x.t"></q></template><template data-sn-else><s data-sn-text="${v}.t"></s></template>`,
    `<c-chain slot="item" data-sn-with="{ x: { t: $slot.x.t + ${v}.t, on: ${v}.on } }"></c-chain>`,
    `<q slot="item"><template data-sn-for="z in $slot.x.c"><b data-sn-text="z.t"></b></template><template data-sn-else><s data-sn-text="${v}.t"></s></template></q>`,
  ]);
  return `<c-slot data-sn-with="{ x: ${v} }">${fill}</c-slot>`;
}

/** markup over the item `v`, `depth` levels of nesting left */
function markup(r: () => number, v: string, depth: number): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const n = 1 + Math.floor(r() * 2);
  let out = '';
  for (let i = 0; i < n; i++) {
    const kinds = depth > 0
      ? ['text', 'el', 'plain', 'chain', 'tag', 'choice', 'out', 'list', 'href', 'link', 'slot', 'slot-tag', 'wrap', 'if', 'for', 'use', 'wrap-for-fill', 'wrap-if-fill', 'bare', 'bare-empty', 'forelse', 'wrap-forelse', 'empty']
      : ['text', 'el', 'plain', 'chain', 'tag', 'choice', 'out', 'list', 'href', 'link', 'bare-empty', 'empty'];
    switch (pick(kinds)) {
      case 'text': out += `<template data-sn-text="${v}.t"></template>`; break;
      case 'el': out += `<p data-sn-text="${v}.t"></p>`; break;
      // a link's URL template: a path value, a query value left out when null, a list as a repeated key
      case 'href': out += `<a data-sn-href="/x/{${v}.t}?on={${v}.on ? 'y' : null}&amp;k={${v}.c.map((c) => c.k)}#{${v}.k}" data-sn-text="${v}.k"></a>`; break;
      case 'link': out += `<c-link data-sn-with="{ x: ${v} }" data-sn-href="/l/{${v}.k}/{${v}.t}"></c-link>`; break;
      case 'plain': out += `<c-plain data-sn-with="{ x: ${v} }"></c-plain>`; break;
      case 'chain': out += `<c-chain data-sn-with="{ x: ${v} }"></c-chain>`; break;
      case 'tag': out += `<c-tag data-sn-with="{ x: ${v} }"></c-tag>`; break;
      case 'choice': out += `<c-choice data-sn-with="{ x: ${v} }"></c-choice>`; break;
      case 'out': out += `<c-out data-sn-with="{ n: ${v}, x: { t: 'OUT', on: true } }"></c-out>`; break;
      case 'list': out += `<c-list data-sn-with="{ x: ${v} }"></c-list>`; break;
      case 'slot': out += `<c-slot data-sn-with="{ x: ${v} }"><q slot="item" data-sn-text="$slot.x.t + ${v}.t"></q></c-slot>`; break;
      // a slot root with a named fill (an element, a chain or a component tag), in a loop or a branch in other slot content
      case 'wrap-for-fill': { const w = v + 'y'; out += `<c-wrap><template data-sn-for="${w} in ${v}.c">${namedFill(pick, w)}</template></c-wrap>`; break; }
      case 'wrap-if-fill': out += `<c-wrap><template data-sn-if="${v}.on">${namedFill(pick, v)}</template></c-wrap>`; break;
      case 'slot-tag': { const c = pick(['c-plain', 'c-chain', 'c-tag']); out += `<c-slot data-sn-with="{ x: ${v} }"><${c} slot="item" data-sn-with="{ x: $slot.x }"></${c}></c-slot>`; break; }
      case 'wrap': out += `<c-wrap>${markup(r, v, depth - 1)}</c-wrap>`; break;
      case 'bare': out += `<c-bare>${markup(r, v, depth - 1)}</c-bare>`; break;
      case 'bare-empty': out += '<c-bare></c-bare>'; break;
      case 'if': out += `<template data-sn-if="${v}.on">${markup(r, v, depth - 1)}</template>`; break;
      case 'for': { const w = v + 'y'; out += `<template data-sn-for="${w} in ${v}.c">${markup(r, w, depth - 1)}</template>`; break; }
      case 'empty': out += `<c-empty data-sn-with="{ x: ${v} }"></c-empty>`; break;
      // a list with its empty state: in the rows of the outer list, and as slot content
      case 'forelse': { const w = v + 'y'; out += `<template data-sn-for="${w} in ${v}.c">${markup(r, w, depth - 1)}</template><template data-sn-else>${markup(r, v, depth - 1)}</template>`; break; }
      case 'wrap-forelse': { const w = v + 'y'; out += `<c-wrap><template data-sn-for="${w} in ${v}.c"><c-chain data-sn-with="{ x: ${w} }"></c-chain></template><template data-sn-else><c-plain data-sn-with="{ x: ${v} }"></c-plain></template></c-wrap>`; break; }
      case 'use': out += `<sn-component use="${CHOICE}[${v}.k]" data-sn-with="{ x: ${v} }"></sn-component>`; break;
    }
  }
  return out;
}

function data(r: () => number, depth: number): unknown[] {
  return Array.from({ length: Math.floor(r() * 3) }, (_, i) => ({
    on: r() < 0.5, t: 'T' + i + Math.floor(r() * 9), k: ['p', 'c', 't', 'l', 'e'][Math.floor(r() * 5)], c: depth > 0 ? data(r, depth - 1) : [],
  }));
}

/** the content as the user sees it: elements with their class and `href`, and text; no comments */
function shape(n: Node): string {
  let s = '';
  for (const c of n.childNodes) {
    if (c.nodeType === 3) s += (c as Text).data;
    else if (c.nodeType === 1 && (c as Element).localName !== 'template') {
      const e = c as Element, cls = e.getAttribute('class'), href = e.getAttribute('href');
      s += `<${e.localName}${cls ? `.${cls}` : ''}${href !== null ? ` ${href}` : ''}>${shape(c)}</${e.localName}>`;
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
