// A write through an alias that holds a member of a helper's result: the helper may have returned any object below
// its argument (`pick(ys)` is some `ys.**`), so its member (`.items`) may be anywhere below too.
import { describe, expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

const text = (r: Awaited<ReturnType<typeof render>>, sel: string) => [...r.root.querySelectorAll(sel)].map((x) => x.textContent).join(',');
const click = async (r: Awaited<ReturnType<typeof render>>, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };
const pick = (ys: Array<{ items: number[] }>) => ys[0];

describe('an alias of a member of a helper\'s result', () => {
  test('`sel = pick(ys).items`, then `sel.push(5)`: what reads the list in `ys` updates', async () => {
    const r = await render(`<main data-sn-state="{ ys: [{ id: 1, items: [1] }], sel: null }"><p data-sn-text="ys[0].items.length"></p>
      <button id="a" data-sn-on-click="sel = pick(ys).items"></button><button id="b" data-sn-on-click="sel.push(5)"></button></main>`, { helpers: { pick } });
    expect(text(r, 'p')).toBe('1');
    await click(r, '#a');
    await click(r, '#b');
    expect(text(r, 'p')).toBe('2');
  });

  test('`sel = pick(ys).items`, then `sel[0] = 9`: what reads the element updates', async () => {
    const r = await render(`<main data-sn-state="{ ys: [{ id: 1, items: [1] }], sel: null }"><p data-sn-text="ys[0].items[0]"></p>
      <button id="a" data-sn-on-click="sel = pick(ys).items"></button><button id="b" data-sn-on-click="sel[0] = 9"></button></main>`, { helpers: { pick } });
    await click(r, '#a');
    await click(r, '#b');
    expect(text(r, 'p')).toBe('9');
  });

  test('a member of the helper\'s own argument, not through a helper, already did', async () => {
    const r = await render(`<main data-sn-state="{ ys: [{ id: 1, items: [1] }], sel: null }"><p data-sn-text="ys[0].items.length"></p>
      <button id="a" data-sn-on-click="sel = ys[0].items"></button><button id="b" data-sn-on-click="sel.push(5)"></button></main>`);
    await click(r, '#a');
    await click(r, '#b');
    expect(text(r, 'p')).toBe('2');
  });
});
