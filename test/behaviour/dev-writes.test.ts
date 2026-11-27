// @vitest-environment jsdom
// Dev builds check that each write marked what it changed (warning 36, src/dev.ts): when a flush starts, every concrete
// path of the state that changed since the last one is reached by a path marked since. A write sinter cannot see (a
// custom element that changes an object it was handed) or an alias the write analysis missed is a loud dev warning
// instead of a binding that shows an old value.
import { describe, expect, test } from 'vitest';
import { covers } from '../../src/dev.js';
import { render } from '../../src/testing/index.js';

const click = async (r: Awaited<ReturnType<typeof render>>, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };
const w36 = (r: Awaited<ReturnType<typeof render>>) => r.warnings().filter((w) => w.code == 36).map((w) => w.message);

if (!customElements.get('x-bump')) {
  customElements.define('x-bump', class extends HTMLElement {
    item: { n: number } | null = null;
    // what sinter cannot see: the element changes the object it was handed, on a click it also hears
    connectedCallback() { this.addEventListener('click', () => { if (this.item) this.item.n += 100; }); }
  });
}

describe('warning 36: a change no mark reaches', () => {
  test('a custom element that changes a page object it was given: named, with what was marked and what ran', async () => {
    const r = await render(`<main data-sn-state="{ ys: [{ n: 1 }], k: 0 }"><p data-sn-text="ys[0].n + ':' + k"></p>
      <x-bump data-sn-with="{ item: ys[0] }" data-sn-on-click="k = k + 1"></x-bump></main>`, { strict: false });
    await click(r, 'x-bump');
    const [m, ...more] = w36(r);
    expect(more).toEqual([]);
    expect(m).toMatch(/^sinter: a write changed `ys\.0\.n`, which nothing it marked reaches \(it marked `k`\): what reads it shows the old value .* What ran: \/test\/page\.html:2:\d+$/);
  });

  test('silent where the writes mark what they change: direct, through an alias, a list method, a helper\'s member (#131), a row\'s item', async () => {
    const pick = (ys: Array<{ items: number[] }>) => ys[0];
    const r = await render(`<main data-sn-state="{ ys: [{ n: 1, items: [1] }, { n: 2, items: [] }], sel: null, box: null, k: 0 }">
      <p data-sn-text="ys.map((y) => y.n + '/' + y.items.length).join(',') + (sel ? '' : '-') + (box ? '' : '-') + k"></p>
      <ul><template data-sn-for="y in ys"><li><button class="row" data-sn-on-click="y.n = y.n + 1"></button></li></template></ul>
      <button id="a" data-sn-on-click="sel = ys[1]; sel.n = 50; k = k + 1"></button>
      <button id="b" data-sn-on-click="box = pick(ys).items"></button><button id="b2" data-sn-on-click="box.push(5)"></button>
      <button id="c" data-sn-on-click="ys.push({ n: 7, items: [] }); ys = [...ys].reverse()"></button></main>`, { helpers: { pick }, strict: false });
    for (const s of ['#a', '#b', '#b2', '#c', '.row']) await click(r, s);
    expect(w36(r)).toEqual([]);
  });

  test('a write reaches what is below it; `*`, `#`, `~`, an unfilled `{name}` stand for a segment, `**` for the rest', () => {
    expect(covers(['$s0', 'sel'], ['$s0', 'sel', 'n'])).toBe(true);
    expect(covers(['$s0', 'sel', 'n'], ['$s0', 'sel'])).toBe(false);
    expect(covers(['$s0', 'ys', '#'], ['$s0', 'ys', '2'])).toBe(true);
    expect(covers(['$s0', 'ys', '*', 'n'], ['$s0', 'ys', '1', 'n'])).toBe(true);
    expect(covers(['$s0', 'ys', '{i}', 'n'], ['$s0', 'ys', '1', 'n'])).toBe(true);
    expect(covers(['$s0', 'ys', '1', 'n'], ['$s0', 'ys', '0', 'n'])).toBe(false);
    expect(covers(['$s0', '**'], ['$s0', 'a', 'b'])).toBe(true);
    expect(covers(['$s1', '**'], ['$s0', 'a'])).toBe(false);
  });
});
