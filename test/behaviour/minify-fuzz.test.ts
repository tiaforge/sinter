// @vitest-environment jsdom
// The build's HTML minifier (docs/minify.md) under the runtime: random templates of nested lists, branches, texts
// without an element and elements, minified against a few stylesheets. A state change must render what a fresh
// render of the new state renders, node for node, and the build over constants (whose rows the minifier sees in
// place) what the browser would show the same: they may differ only in white space that renders nothing.
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';
import { reset as resetCore } from '../core-flags.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function template(r: () => number, v: string, depth: number): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const n = 1 + Math.floor(r() * 3);
  let out = '';
  for (let i = 0; i < n; i++) {
    const kinds = depth > 0 ? ['text', 'lit', 'el', 'block', 'if', 'ifelse', 'for', 'static'] : ['text', 'lit', 'el', 'static'];
    // white space as an author writes it: indented, between and around everything
    const ws = pick(['', ' ', '\n  ', '\n    \n']);
    switch (pick(kinds)) {
      case 'text': out += `${ws}<template data-sn-text="${v}.t"></template>`; break;
      case 'lit': out += `${ws}<template data-sn-text="'~'"></template>`; break;
      case 'static': out += ws + pick(['<b>s</b>', ' ', '-', 'a  b', '<!-- c -->']); break;
      case 'el': { const t = pick(['b', 'i', 'span']); out += ws + (r() < 0.5 ? `<${t} data-sn-text="${v}.t"></${t}>` : `<${t}>${template(r, v, depth - 1)}</${t}>`); break; }
      case 'block': { const t = pick(['div', 'p', 'section']); out += `${ws}<${t} class="${pick(['', 'row', 'ib'])}">${template(r, v, depth - 1)}${ws}</${t}>`; break; }
      case 'if': out += `${ws}<template data-sn-if="${v}.on">${template(r, v, depth - 1)}${ws}</template>`; break;
      case 'ifelse': out += `${ws}<template data-sn-if="${v}.on">${template(r, v, depth - 1)}</template>${ws}<template data-sn-else>${template(r, v, depth - 1)}</template>`; break;
      case 'for': { const w = v + 'y'; out += `${ws}<template data-sn-for="${w} in ${v}.c">${template(r, w, depth - 1)}${ws}</template>`; break; }
    }
    out += pick(['', ' ', '\n']);
  }
  return out;
}

function data(r: () => number, depth: number): unknown[] {
  return Array.from({ length: Math.floor(r() * 3) }, (_, i) => ({ on: r() < 0.5, t: 'T' + i + Math.floor(r() * 9), c: depth > 0 ? data(r, depth - 1) : [] }));
}

/**
 * Elements and text, no comments; with `flex`, each item of a `.row` (an element, or a run of text) in an `<item>`;
 * with `ib`, an `.ib` element is an `<ib>` (inline-block: inline outside, its own lines inside).
 */
function shape(n: Node, flex = false, ib = false): string {
  let s = '';
  const row = flex && (n as Element).classList?.contains('row');
  let text: string | null = null;
  const flush = () => { if (text !== null) { s += row ? `<item>${text}</item>` : text; text = null; } };
  for (const c of n.childNodes) {
    if (c.nodeType === 3) text = (text ?? '') + (c as Text).data;
    else if (c.nodeType === 1) {
      flush();
      const tag = ib && (c as Element).classList.contains('ib') ? 'ib' : (c as Element).localName;
      const el = `<${tag}>${shape(c, flex, ib)}</${tag}>`;
      s += row ? `<item>${el}</item>` : el;
    }
  }
  flush();
  return s;
}

const BLOCK = /^<\/?(div|p|section|item)>$/;
/**
 * What shows of a shape when white space collapses (these stylesheets keep none): each run is one space, a space
 * after another (through inline tags) is none, and none is at the start or end of a line (beside a block tag,
 * or at the edges).
 */
function visible(s: string): string {
  const parts = s.replace(/\s+/g, ' ').split(/(<[^>]+>)/).filter(Boolean);
  const out: string[] = [];
  let space = true; // the start of a line
  for (const p of parts) {
    if (p.startsWith('<')) {
      // an inline-block: a line starts inside it, and ends at its end; outside, it is inline content
      if (p === '<ib>') { out.push(p); space = true; continue; }
      if (p === '</ib>') { while (out.length && out[out.length - 1] === ' ') out.pop(); out.push(p); space = false; continue; }
      if (BLOCK.test(p)) { while (out.length && out[out.length - 1] === ' ') out.pop(); space = true; }
      out.push(p);
      continue;
    }
    for (const ch of p) {
      if (ch === ' ') { if (!space) { out.push(' '); space = true; } } else { out.push(ch); space = false; }
    }
  }
  while (out.length && out[out.length - 1] === ' ') out.pop();
  // a space right before a block tag, through inline tags: at the end of a line
  // a space right before a block tag, through inline tags: at the end of a line; an item of white space alone is none
  return out.join('').replace(/ ((?:<\/?(?:b|i|span)>)*)(<\/?(?:div|p|section|item)>)/g, '$1$2').replace(/<item><\/item>/g, '')
    // a space just inside an inline tag shows as one just outside it (the constant build places some so)
    .replace(/((?:<(?:b|i|span)>)+) /g, ' $1').replace(/ ((?:<\/(?:b|i|span)>)+)/g, '$1 ').replace(/ {2,}/g, ' ');
}

const lit = (x: unknown) => JSON.stringify(x).replace(/"/g, "'");
const SHEETS = ['', '.row { display: flex; gap: 4px }', '.ib { display: inline-block } p { margin: 0 }'];

test('minified random templates: a state change renders what a fresh render renders, and the constant build what shows the same', async () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 120; seed++) {
    // each seed on the smallest core for its page (test/core-flags.ts)
    resetCore();
    const r = rng(seed);
    const css = SHEETS[seed % SHEETS.length]!;
    const body = template(r, 'x', 3);
    const tpl = `<template data-sn-for="x in d">${r() < 0.5 ? `<template data-sn-if="x.on || true">${body}</template>` : body}</template>`;
    const a = data(r, 3), b = data(r, 3);
    const page = (init: unknown, writes: boolean) => `<div data-sn-state="{ d: ${lit(init)} }">${writes ? `<button id="w" data-sn-on-click="d = ${lit(b)}">w</button>` : ''}\n  <div id="o">\n    ${tpl}\n  </div>\n</div>`;
    const opts = { minify: true, css, strict: false } as const;
    try {
      const updated = await render(page(a, true), opts);
      (updated.root.querySelector('#w') as HTMLButtonElement).click();
      await updated.settle();
      const after = shape(updated.root.querySelector('#o')!);
      const fresh = shape((await render(page(b, true), opts)).root.querySelector('#o')!);
      if (after !== fresh) failures.push(`seed ${seed} (update): ${tpl}\n  after ${after}\n  fresh ${fresh}`);
      const flex = css.includes('flex'), ib = css.includes('inline-block');
      const built = shape((await render(page(b, false), opts)).root.querySelector('#o')!, flex, ib);
      if (visible(built) !== visible(shape((await render(page(b, true), opts)).root.querySelector('#o')!, flex, ib))) failures.push(`seed ${seed} (constant): ${tpl}\n  built ${built}\n  fresh ${fresh}`);
      // and what shows is what the page shows unminified
      const plain = shape((await render(page(b, true), { css, strict: false })).root.querySelector('#o')!, flex, ib);
      if (visible(plain) !== visible(shape((await render(page(b, true), opts)).root.querySelector('#o')!, flex, ib))) failures.push(`seed ${seed} (unminified): ${tpl}\n  plain ${plain}\n  fresh ${fresh}`);
    } catch (e) {
      failures.push(`seed ${seed}: ${tpl}\n  ${(e as Error).message.split('\n').slice(0, 2).join(' ')}`);
    }
  }
  expect(failures).toEqual([]);
}, 240_000);

test('a row minified: its bound text lands where it is written, across renders', async () => {
  const html = `<div data-sn-state="{ d: [{ id: 1, t: 'T' }] }"><button id="w" data-sn-on-click="d = [{ id: 1, t: 'U' }, { id: 2, t: 'V' }]">w</button>
  <ul>
    <template data-sn-for="x in d" data-sn-key="x.id">
      <li>
        <!-- the label -->
        <b>label</b>
        <span data-sn-text="x.t"></span>
      </li>
    </template>
  </ul>
</div>`;
  const { root, settle } = await render(html, { minify: true });
  expect(root.querySelector('ul')!.innerHTML.replace(/<!--[^>]*-->/g, '')).toBe('\n<li><b>label</b>\n<span>T</span></li>');
  (root.querySelector('#w') as HTMLButtonElement).click();
  await settle();
  expect([...root.querySelectorAll('li span')].map((s) => s.textContent)).toEqual(['U', 'V']);
});
