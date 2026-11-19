// A `<sn-component use>` choice with many candidates is a lookup table rather than a chain of comparisons
// (compile.ts, finishChoices): a component library's dispatch over its node types, used in every place its
// tree recurses. It must choose exactly what the chain chose: a name's first candidate, nothing for a value
// outside the names (an inherited key like `toString` included, and anything not a string),
// and follow a change of the value.
import { describe, expect, test } from 'vitest';
import { firstPaint, render } from '../../src/testing/index.js';

const N = 10;
const names = Array.from({ length: N }, (_, i) => `c${i}`);
const components = Object.fromEntries(names.map((n, i) => [`${n}-block`, `<template data-sn-props="{ b: { type: unknown; text: string } }"><p data-sn-attr="{ 'data-c': ${i} }" data-sn-text="b.text"></p></template>`]));
// the map names each candidate once, and c0 a second time under another key
const MAP = `{ ${names.map((n) => `${n}: '${n}-block'`).join(', ')}, again: 'c0-block' }`;
const page = (blocks: string, live = true) => `<div data-sn-state="{ blocks: ${blocks} }">${live ? `<i id="next" data-sn-on-click="blocks = blocks.map((b) => ({ ...b, type: b.type === 'c1' ? 'c9' : b.type }))"></i>` : ''}
  <template data-sn-for="b in blocks"><sn-component use="${MAP}[b.type]" data-sn-prop="{ b }"></sn-component><template data-sn-else><i class="none" data-sn-text="b.text"></i></template></template></div>`;
const shape = (root: ParentNode) => [...root.querySelectorAll('[data-c], .none')].map((e) => `${e.getAttribute('data-c') ?? '-'}:${e.textContent}`);

describe('a choice among many candidates', () => {
  test('each name renders its candidate; a name given twice its first', async () => {
    const { root, flush } = await render(page(`[${names.map((n) => `{ type: '${n}', text: '${n}' }`).join(', ')}, { type: 'again', text: 'again' }]`), { components });
    await flush();
    expect(shape(root)).toEqual([...names.map((n, i) => `${i}:${n}`), '0:again']);
  });

  test('a value outside the names renders the else: inherited keys and values that are not strings included', async () => {
    const { root, flush } = await render(page(`[{ type: 'toString', text: 't' }, { type: 'valueOf', text: 'v' }, { type: 5, text: 'n' }, { type: null, text: 'z' }, { type: 'c3', text: 'ok' }]`), { components });
    await flush();
    expect(shape(root)).toEqual(['-:t', '-:v', '-:n', '-:z', '3:ok']);
  });

  test('a change of the value renders the other candidate', async () => {
    const { root, flush } = await render(page(`[{ type: 'c1', text: 'x' }, { type: 'c2', text: 'y' }]`), { components });
    await flush();
    expect(shape(root)).toEqual(['1:x', '2:y']);
    (root.querySelector('#next') as HTMLElement).click();
    await flush();
    expect(shape(root)).toEqual(['9:x', '2:y']);
  });

  test('a component under two keys renders once at build time too', async () => {
    const html = page(`[{ type: 'again', text: 'a' }, { type: 'c0', text: 'b' }]`, false);
    const early = await firstPaint(html, { components });
    expect(shape(early.root)).toEqual(['0:a', '0:b']);
  });

  test('the first paint renders what the page module renders', async () => {
    // state nothing writes: a constant, written into the HTML at build time
    const html = page(`[{ type: 'c4', text: 'a' }, { type: 'nope', text: 'b' }, { type: 'c9', text: 'c' }]`, false);
    const early = await firstPaint(html, { components });
    const { root, flush } = await render(html, { components });
    await flush();
    expect(shape(early.root)).toEqual(['4:a', '-:b', '9:c']);
    expect(shape(root)).toEqual(shape(early.root));
  });
});
