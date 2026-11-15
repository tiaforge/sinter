// @vitest-environment jsdom
// Random small templates of nested lists, branches, texts without an element and elements, inside a row: the page
// after a state change must equal a fresh render of the new state, and the build over constants.
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

/** a small seeded PRNG, so a failure names its case */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function template(r: () => number, v: string, depth: number): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const n = 1 + Math.floor(r() * 3);
  let out = '';
  for (let i = 0; i < n; i++) {
    const kinds = depth > 0 ? ['text', 'lit', 'el', 'if', 'ifelse', 'for', 'static'] : ['text', 'lit', 'el', 'static'];
    switch (pick(kinds)) {
      case 'text': out += `<template data-sn-text="${v}.t"></template>`; break;
      case 'lit': out += `<template data-sn-text="'~'"></template>`; break;
      case 'static': out += pick(['<b>s</b>', ' ', '-']); break;
      case 'el': { const t = pick(['b', 'i', 'span']); out += r() < 0.5 ? `<${t} data-sn-text="${v}.t"></${t}>` : `<${t}>${template(r, v, depth - 1)}</${t}>`; break; }
      case 'if': out += `<template data-sn-if="${v}.on">${template(r, v, depth - 1)}</template>`; break;
      case 'ifelse': out += `<template data-sn-if="${v}.on">${template(r, v, depth - 1)}</template><template data-sn-else>${template(r, v, depth - 1)}</template>`; break;
      case 'for': { const w = v + 'y'; out += `<template data-sn-for="${w} in ${v}.c">${template(r, w, depth - 1)}</template>`; break; }
    }
  }
  return out;
}

function data(r: () => number, depth: number): unknown[] {
  return Array.from({ length: Math.floor(r() * 3) }, (_, i) => ({ on: r() < 0.5, t: 'T' + i + Math.floor(r() * 9), c: depth > 0 ? data(r, depth - 1) : [] }));
}

/** the rendered content as the user sees it: elements and text, no comments */
function shape(n: Node): string {
  let s = '';
  for (const c of n.childNodes) {
    if (c.nodeType === 3) s += (c as Text).data;
    else if (c.nodeType === 1) s += `<${(c as Element).localName}>${shape(c)}</${(c as Element).localName}>`;
  }
  return s;
}

const lit = (x: unknown) => JSON.stringify(x).replace(/"/g, "'");


test('random templates: a state change renders what a fresh render and the constant build render', async () => {
  const failures: string[] = [], constant = new Set<number>();
  for (let seed = 1; seed <= 120; seed++) {
    const r = rng(seed);
    const wrap = r() < 0.5;
    const body = template(r, 'x', 3);
    const tpl = `<template data-sn-for="x in d">${wrap ? `<template data-sn-if="x.on || true">${body}</template>` : body}</template>`;
    const a = data(r, 3), b = data(r, 3);
    const page = (init: unknown, writes: boolean) => `<div data-sn-state="{ d: ${lit(init)} }">${writes ? `<button id="w" data-sn-on-click="d = ${lit(b)}">w</button>` : ''}<p>${tpl}</p></div>`;
    try {
      const updated = await render(page(a, true));
      (updated.root.querySelector('#w') as HTMLButtonElement).click();
      await updated.settle();
      const after = shape(updated.root.querySelector('p')!);
      const fresh = shape((await render(page(b, true))).root.querySelector('p')!);
      if (after !== fresh) failures.push(`seed ${seed}: ${tpl}\n  after ${after}\n  fresh ${fresh}`);
      const built = shape((await render(page(b, false))).root.querySelector('p')!);
      if (built !== fresh) constant.add(seed);
    } catch (e) {
      failures.push(`seed ${seed}: ${tpl}\n  ${(e as Error).message.split('\n').slice(0, 2).join(' ')}`);
    }
  }
  expect(failures).toEqual([]);
  // the build over constants renders the same (a literal text that merged into the text before it skipped the node after it)
  expect([...constant]).toEqual([]);
}, 120_000);
