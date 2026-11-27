// @vitest-environment jsdom
// Aliases the compiler follows (docs/spec.md, Aliases): what a value may hold is followed through a `data-sn-let`, a
// loop's item over a list that is no state path, and a callback's parameter over one. A write through such an alias
// marks what the value may be, not every state scope and resource; and it still reaches what reads it.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const text = (r: Awaited<ReturnType<typeof render>>, sel: string) => [...r.root.querySelectorAll(sel)].map((x) => x.textContent).join(',');
const click = async (r: Awaited<ReturnType<typeof render>>, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };
const keep = <T,>(xs: T[]) => xs.filter(() => true);

/** each click handler's writes, in order */
const writes = (html: string) => {
  const out = compileParts(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: '/src/sinter.helpers.ts', names: ['keep'], namespaces: {} }, readFile: () => { throw new Error('none'); } });
  return [...out.ir.roots, ...out.ir.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'on' && b.w).map((b) => (b.w as string[]).slice().sort()));
};
const everything = (ws: string[]) => ws.includes('$s0.**');

describe('followed: a let, a loop\'s item over a computed list, a callback\'s parameter', () => {
  const LET = `<main data-sn-state="{ ys: [{ n: 1 }, { n: 2 }], sel: null }" data-sn-let="{ y1: ys.find((y) => y.n === 2) }"><ul><template data-sn-for="y in ys"><li data-sn-text="y.n"></li></template></ul>
    <button id="a" data-sn-on-click="sel = y1"></button><button id="b" data-sn-on-click="sel.n = 50"></button><b data-sn-text="sel ? sel.n : '-'"></b></main>`;
  test('a let of a list\'s element: the write through the alias marks the list\'s elements, not everything', () => {
    const [, w] = writes(LET);
    expect(everything(w!)).toBe(false);
    expect(w).toEqual(['$s0.sel.n', '$s0.ys.*.n']);
  });
  test('a let of a list\'s element: the list and the alias show the write', async () => {
    const r = await render(LET);
    await click(r, '#a');
    await click(r, '#b');
    expect(text(r, 'li')).toBe('1,50');
    expect(text(r, 'b')).toBe('50');
  });

  const LOOP = `<main data-sn-state="{ ys: [{ n: 1 }, { n: 2 }], sel: null }"><ul><template data-sn-for="y in ys"><li data-sn-text="y.n"></li></template></ul>
    <template data-sn-for="z in keep(ys)"><button class="pick" data-sn-on-click="sel = z"></button></template>
    <button id="b" data-sn-on-click="sel.n = 70"></button></main>`;
  test('a loop\'s item over a helper\'s result: anything below the helper\'s argument, not everything', () => {
    const w = writes(LOOP).find((x) => x.includes('$s0.sel.n'))!;
    expect(everything(w)).toBe(false);
    expect(w).toEqual(['$s0.sel.n', '$s0.ys.**']);
  });
  test('a loop\'s item over a helper\'s result: the list shows the write through the alias', async () => {
    const r = await render(LOOP, { helpers: { keep } });
    r.root.querySelectorAll<HTMLElement>('.pick')[1]!.click();
    await r.settle();
    await click(r, '#b');
    expect(text(r, 'li')).toBe('1,70');
  });

  const CALLBACK = `<main data-sn-state="{ ys: [{ n: 1, o: { k: 1 } }, { n: 2, o: { k: 2 } }], sel: null }" data-sn-let="{ os: keep(ys).map((v) => v.o) }"><ul><template data-sn-for="y in ys"><li data-sn-text="y.o.k"></li></template></ul>
    <button id="a" data-sn-on-click="sel = os[1]"></button><button id="b" data-sn-on-click="sel.k = 80"></button></main>`;
  test('a callback\'s parameter over a helper\'s result, in a let: not everything', () => {
    const [, w] = writes(CALLBACK);
    expect(everything(w!)).toBe(false);
  });
  test('a callback\'s parameter over a helper\'s result, in a let: the list shows the write', async () => {
    const r = await render(CALLBACK, { helpers: { keep } });
    await click(r, '#a');
    await click(r, '#b');
    expect(text(r, 'li')).toBe('1,80');
  });

  test('a loop over a resource: an item of it is the resource\'s element (which a write through state never changes); a let of the loop\'s index holds nothing', () => {
    const ws = writes(`<sn-resource name="rs" src="/r"></sn-resource><main data-sn-state="{ sel: null, box: null }"><b data-sn-text="(sel ? sel.n : 0) + (box ? box.n : 0)"></b>
      <template data-sn-for="(r, j) in rs"><i data-sn-let="{ J: [j] }"><button data-sn-on-click="sel = r; box = J"></button></i></template>
      <button data-sn-on-click="sel.n = 3"></button><button data-sn-on-click="box.n = 4"></button></main>`);
    expect(ws.map(everything)).toEqual([false, false, false]);
    expect(ws.find((w) => w.includes('$s0.sel.n'))).toEqual(['$s0.sel.n']);
  });

  test('what the compiler cannot follow in a let still marks everything', () => {
    const [, w] = writes(`<main data-sn-state="{ ys: [{ n: 1 }], sel: null }" data-sn-let="{ y1: ys.reduce((a, y) => y, null) }"><b data-sn-text="ys[0].n + (sel ? sel.n : 0)"></b>
      <button data-sn-on-click="sel = y1"></button><button data-sn-on-click="sel.n = 5"></button></main>`);
    expect(everything(w!)).toBe(true);
  });
});
