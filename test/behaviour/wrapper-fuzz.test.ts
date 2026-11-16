// @vitest-environment jsdom
// Wrappers (docs/proposals/flat-anchors.md): rows and branches whose whole content is one `if` or choice render
// without nodes of their own. Random chains of them (if, if/else, choices, slot roots, nested lists) inside rows,
// updated in place, field by field and row by row: after each step the page must equal a fresh render of the same
// state, from a page the module rendered and from one the early script painted and the module took over (whose
// wrappers keep their comments until they render again).
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

/** a small seeded PRNG, so a failure names its case */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const CHOICE = "{ p: 'c-plain', c: 'c-chain', s: 'c-slot', e: 'c-none' }";
const COMPONENTS: Record<string, string> = {
  'c-plain': `<template data-sn-component="{ x: any }"><b data-sn-text="x.t"></b></template>`,
  'c-chain': `<template data-sn-component="{ x: any }"><template data-sn-if="x.a"><i data-sn-text="x.t"></i></template><template data-sn-else><template data-sn-if="x.b"><u data-sn-text="x.t"></u></template></template></template>`,
  // a slot root: a choice between a fill and its default (a case whose content is one choice)
  'c-slot': `<template data-sn-component="{ x: any; item: Slot<{ x: any }> }"><slot name="item" data-sn-prop="{ x }"><template data-sn-if="x.b"><s data-sn-text="x.t"></s></template></slot></template>`,
  // a root that renders nothing while `a` is false
  'c-none': `<template data-sn-component="{ x: any }"><template data-sn-if="x.a"><em data-sn-text="x.t"></em></template></template>`,
};

/** markup over the item `v` whose top level is one anchor (its row or branch a wrapper) or a leaf; `depth` levels left */
function chain(r: () => number, v: string, depth: number): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const f = () => pick(['a', 'b']);
  const kinds = depth > 0 ? ['if', 'ifelse', 'ifelse', 'use', 'for', 'leaf', 'pair'] : ['leaf'];
  switch (pick(kinds)) {
    case 'if': return `<template data-sn-if="${v}.${f()}">${chain(r, v, depth - 1)}</template>`;
    case 'ifelse': return `<template data-sn-if="${v}.${f()}">${chain(r, v, depth - 1)}</template><template data-sn-else>${chain(r, v, depth - 1)}</template>`;
    case 'use': return `<sn-component use="${CHOICE}[${v}.k]" data-sn-prop="{ x: ${v} }"></sn-component>`;
    case 'for': { const w = v + 'y'; return `<template data-sn-for="${w} in ${v}.c"${r() < 0.5 ? ` data-sn-key="${w}.id"` : ''}>${chain(r, w, depth - 1)}</template>`; }
    // not a wrapper: a node next to the anchor
    case 'pair': return `<b>${v}</b>${chain(r, v, depth - 1)}`;
  }
  return pick([
    `<b data-sn-text="${v}.t"></b>`,
    `<template data-sn-text="${v}.t"></template>`,
    `<template data-sn-text="${v}.t"></template><i>.</i>`,
    '',
    '<i>s</i>',
    `<c-chain data-sn-prop="{ x: ${v} }"></c-chain>`,
    `<c-slot data-sn-prop="{ x: ${v} }"></c-slot>`,
    `<c-none data-sn-prop="{ x: ${v} }"></c-none>`,
    `<c-plain data-sn-prop="{ x: ${v} }"></c-plain>`,
  ]);
}

interface Item { id: number; a: boolean; b: boolean; k: string; t: string; c: Item[] }
let ids = 0;
const item = (r: () => number, depth: number): Item => ({
  id: ++ids, a: r() < 0.5, b: r() < 0.5, k: ['p', 'c', 's', 'e'][Math.floor(r() * 4)]!, t: 'T' + Math.floor(r() * 99),
  c: depth > 0 ? Array.from({ length: Math.floor(r() * 3) }, () => item(r, depth - 1)) : [],
});

/** a step: the handler that makes it, and the same change on the test's copy of the state */
interface Step { code: string; run(d: Item[]): Item[] }

function step(r: () => number, d: Item[]): Step {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const i = Math.floor(r() * Math.max(d.length, 1));
  const kind = d.length ? pick(['a', 'b', 'k', 't', 'ca', 'swap', 'remove', 'insert', 'reverse']) : 'insert';
  if (kind == 'a' || kind == 'b') return { code: `d[${i}].${kind} = !d[${i}].${kind}`, run: (d) => (d[i]![kind] = !d[i]![kind], d) };
  if (kind == 'k') { const k = pick(['p', 'c', 's', 'e']); return { code: `d[${i}].k = '${k}'`, run: (d) => (d[i]!.k = k, d) }; }
  if (kind == 't') { const t = 'N' + Math.floor(r() * 99); return { code: `d[${i}].t = '${t}'`, run: (d) => (d[i]!.t = t, d) }; }
  if (kind == 'ca' && d[i]!.c.length) { const j = Math.floor(r() * d[i]!.c.length), g = pick(['a', 'b'] as const); return { code: `d[${i}].c[${j}].${g} = !d[${i}].c[${j}].${g}`, run: (d) => (d[i]!.c[j]![g] = !d[i]!.c[j]![g], d) }; }
  if (kind == 'swap' && d.length > 1) { const j = (i + 1) % d.length; return { code: `d = d.map((y, n) => n === ${i} ? d[${j}] : n === ${j} ? d[${i}] : y)`, run: (d) => d.map((y, n) => (n === i ? d[j]! : n === j ? d[i]! : y)) }; }
  if (kind == 'remove') return { code: `d = d.filter((y, n) => n !== ${i})`, run: (d) => d.filter((_, n) => n !== i) };
  if (kind == 'reverse') return { code: 'd = d.slice().reverse()', run: (d) => d.slice().reverse() };
  const x = item(r, 1), lit = JSON.stringify(x).replace(/"/g, "'");
  return { code: `d = d.slice(0, ${i}).concat([${lit}], d.slice(${i}))`, run: (d) => [...d.slice(0, i), structuredClone(x), ...d.slice(i)] };
}

/** the content as the user sees it: elements and text; no comments */
function shape(n: Node): string {
  let s = '';
  for (const c of n.childNodes) {
    if (c.nodeType === 3) s += (c as Text).data;
    else if (c.nodeType === 1 && (c as Element).localName !== 'template') s += `<${(c as Element).localName}>${shape(c)}</${(c as Element).localName}>`;
  }
  return s;
}

const lit = (x: unknown) => JSON.stringify(x).replace(/"/g, "'");
const SEEDS = Number(process.env.SN_FUZZ_SEEDS ?? 150), STEPS = Number(process.env.SN_FUZZ_DEPTH ?? 5);

test('random wrapper chains: each change in place renders what a fresh render of the same state renders, after the module or the early script', async () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const keyed = r() < 0.5;
    const tpl = `<template data-sn-for="x in d"${keyed ? ' data-sn-key="x.id"' : ''}>${chain(r, 'x', 3)}</template>`;
    const init = Array.from({ length: 1 + Math.floor(r() * 4) }, () => item(r, 1));
    // the steps, and the state after each, on a copy
    let d: Item[] = structuredClone(init);
    const steps: Step[] = [], states: string[] = [];
    for (let k = 0; k < STEPS; k++) { const s = step(r, d); d = s.run(d); steps.push(s); states.push(lit(d)); }
    const page = (state: string, buttons: boolean) => `<div data-sn-state="{ d: ${state} }">${buttons ? steps.map((s, k) => `<button id="s${k}" data-sn-on-click="${s.code}">s</button>`).join('') : ''}<main>${tpl}</main></div>`;
    const seen = (root: Element) => shape(root.querySelector('main')!);
    try {
      // (one page is rendered at a time: each render ends the one before)
      const got: string[][] = [];
      for (const firstPaint of [false, true]) {
        const live = await render(page(lit(init), true), { components: COMPONENTS, firstPaint });
        await live.settle();
        const seq: string[] = [];
        for (let k = 0; k < STEPS; k++) {
          (live.root.querySelector(`#s${k}`) as HTMLButtonElement).click();
          await live.settle();
          seq.push(seen(live.root));
        }
        got.push(seq);
      }
      for (let k = 0; k < STEPS; k++) {
        const fresh = seen((await render(page(states[k]!, false), { components: COMPONENTS })).root);
        for (const [n, seq] of got.entries()) {
          if (seq[k] !== fresh && !failures.some((f) => f.startsWith(`seed ${seed}${n ? ' (early)' : ''} `))) {
            failures.push(`seed ${seed}${n ? ' (early)' : ''} step ${k} \`${steps[k]!.code}\`: ${tpl}\n  data  ${states[k]}\n  got   ${seq[k]}\n  fresh ${fresh}`);
          }
        }
      }
    } catch (e) {
      failures.push(`seed ${seed}: ${tpl}\n  ${(e as Error).message.split('\n').slice(0, 3).join(' ')}`);
    }
  }
  expect(failures).toEqual([]);
}, Math.max(300_000, SEEDS * STEPS * 400));
