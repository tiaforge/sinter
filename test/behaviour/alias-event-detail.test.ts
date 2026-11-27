// @vitest-environment jsdom
// An event's detail (docs/spec.md, Aliases): what the page's `emit()`s of that event pass, when the build read every
// module of the page and none of them makes an event of that name with a detail it cannot follow (src/event-senders.ts).
// Else, or without what the modules send (`compile()`, `render()` without `events`), any of the page's objects.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { render, type EventSenders } from '../../src/testing/index.js';

const text = (r: Awaited<ReturnType<typeof render>>, sel: string) => [...r.root.querySelectorAll(sel)].map((x) => x.textContent).join(',');
const click = async (r: Awaited<ReturnType<typeof render>>, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };
const QUIET: EventSenders = { unknown: null, risky: new Map() };
const components = {
  'item-pick': `<template data-sn-props="{ ys: Array<{ n: number }> }" data-sn-emits="{ pick: { n: number } }"><button class="emit" data-sn-on-click="emit('pick', ys[1])"></button></template>`,
};
const writes = (html: string, events: EventSenders | null) => {
  const out = compileParts(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, componentNames: Object.keys(components),
    readFile: (f: string) => { const n = /components\/(.+)\.html$/.exec(f)?.[1]; if (n && n in components) return components[n as keyof typeof components]; throw new Error('none'); },
    ...(events ? { eventSenders: () => events } : {}) });
  return [...out.ir.roots, ...out.ir.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'on' && b.w).map((b) => (b.w as string[]).slice().sort()));
};
const everything = (ws: string[]) => ws.includes('$s0.**');
const PAGE = `<main data-sn-state="{ ys: [{ n: 1 }, { n: 2 }], sel: null, box: null }"><ul><template data-sn-for="y in ys"><li data-sn-text="y.n"></li></template></ul><b data-sn-text="box ? box.k : '-'"></b>
  <div data-sn-on-pick="sel = $event.detail" data-sn-on-nobody="box = $event.detail"><item-pick data-sn-with="{ ys }"></item-pick></div>
  <button id="b" data-sn-on-click="sel.n = 90"></button><button id="c" data-sn-on-click="box && (box.k = 5)"></button></main>`;

describe('an event\'s detail', () => {
  test('traced: what its `emit()` passes (the list\'s second element, through the prop), and an event nothing sends holds nothing', () => {
    const ws = writes(PAGE, QUIET);
    expect(ws.some(everything)).toBe(false);
    expect(ws.find((w) => w.includes('$s0.sel.n'))).toEqual(['$s0.sel.n', '$s0.ys.1.n']);
    expect(ws.find((w) => w.includes('$s0.box.k'))).toEqual(['$s0.box.k']);
  });
  test('traced: the list shows a write through the detail', async () => {
    const r = await render(PAGE, { components, events: QUIET });
    await click(r, '.emit');
    await click(r, '#b');
    expect(text(r, 'li')).toBe('1,90');
  });
  test.each([
    ['without what the page\'s modules send', null],
    ['a module makes `pick` with a detail the build cannot follow', { unknown: null, risky: new Map([['pick', 'lib.ts:3:1']]) }],
    ['a module the build could not read', { unknown: '`lib` could not be found', risky: new Map() }],
  ] as Array<[string, EventSenders | null]>)('untraceable, %s: any object, and the page still shows the write', async (_, events) => {
    expect(writes(PAGE, events).some(everything)).toBe(true);
    const r = await render(PAGE, { components, ...(events ? { events } : {}) });
    await click(r, '.emit');
    await click(r, '#b');
    expect(text(r, 'li')).toBe('1,90');
  });
});

describe('forced traced, against what the page\'s code does', () => {
  // an element that sends one of the page's objects as `grab`'s detail; the test claims no module makes `grab`
  if (!customElements.get('x-hand')) {
    customElements.define('x-hand', class extends HTMLElement {
      item: unknown = null;
      connectedCallback() { this.addEventListener('click', () => this.dispatchEvent(new CustomEvent('grab', { detail: this.item, bubbles: true }))); }
    });
  }
  test('the dev module\'s write check fires (warning 36): the claim is what it rests on', async () => {
    const r = await render(`<main data-sn-state="{ ys: [{ n: 1 }], h: null }"><b data-sn-text="ys[0].n"></b>
      <x-hand data-sn-with="{ item: ys[0] }" data-sn-on-grab="h = $event.detail"></x-hand><button id="w" data-sn-on-click="h.n = 9"></button></main>`, { events: QUIET, strict: false });
    await click(r, 'x-hand');
    await click(r, '#w');
    expect(r.warnings().filter((w) => w.code == 36).map((w) => w.message)).toEqual([expect.stringMatching(/^sinter: a write changed `ys\.0\.n`, which nothing it marked reaches \(it marked `h\.n`\)/)]);
  });
});
