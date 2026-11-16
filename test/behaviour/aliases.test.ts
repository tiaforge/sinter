// @vitest-environment jsdom
// Writes through an alias (docs/spec.md, Aliases): state that holds one of the page's objects (`sel = y`) is an
// alias of it, and a write through either name marks what reads the other. One the compiler cannot trace (a
// helper's result, a let, an event's detail) marks everything it could reach.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const sum = (xs: number[]) => xs.reduce((p, q) => p + q, 0);
const text = (r: Awaited<ReturnType<typeof render>>, sel: string) => [...r.root.querySelectorAll(sel)].map((x) => x.textContent).join(',');
const click = async (r: Awaited<ReturnType<typeof render>>, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };

describe('a traceable alias', () => {
  test('the reported case: `sel = x`, then `sel.n = sel.n + 10; r = r + T` reads the new T', async () => {
    const r = await render(`<main data-sn-state="{ xs: [{ n: 1 }, { n: 2 }], sel: null, r: 0 }" data-sn-let="{ T: sum(xs.map((x) => x.n)) }">
      <template data-sn-for="x in xs"><button class="pick" data-sn-on-click="sel = x"></button></template>
      <button id="go" data-sn-on-click="sel.n = sel.n + 10; r = r + T"></button><p data-sn-text="T + ' ' + r"></p></main>`, { helpers: { sum } });
    await click(r, '.pick');
    await click(r, '#go');
    expect(text(r, 'p')).toBe('13 13');
  });

  test('a page with no lets: the row binding over the item updates after a write through the alias (it stayed on main)', async () => {
    const r = await render(`<main data-sn-state="{ ys: [{ n: 1 }, { n: 2 }], sel: null }"><ul><template data-sn-for="(y, j) in ys"><li data-sn-text="y.n"></li></template></ul>
      <button id="a" data-sn-on-click="sel = ys[1]; sel.n = 50"></button><b data-sn-text="sel ? sel.n : '-'"></b><button id="b" data-sn-on-click="ys[0].n = 7; ys[1].n = 8"></button></main>`);
    await click(r, '#a');
    expect(text(r, 'li')).toBe('1,50');
    expect(text(r, 'b')).toBe('50');
    // and the other way round: a write through the list reaches what reads the alias
    await click(r, '#b');
    expect(text(r, 'b')).toBe('8');
  });

  test('seed 19: a row let over its item after a write through an alias made in a row handler, in another handler', async () => {
    const pair = (a: number, n: number) => ({ v: a * 10 + n });
    const r = await render(`<main data-sn-state="{ ys: [{ n: 1 }, { n: 2 }, { n: 3 }], sel: null, q: 1 }">
      <ol><template data-sn-for="(y, i) in ys" data-sn-key="i"><li data-sn-let="{ YR: pair(y.n, i) }"><span data-sn-text="YR.v + ':' + q"></span><button class="yb" data-sn-on-click="sel = y; ys = [...ys].reverse()"></button></li></template></ol>
      <button id="w" data-sn-on-click="q = q + 1; sel && (sel.n = sel.n + 10)"></button></main>`, { helpers: { pair } });
    r.root.querySelectorAll<HTMLElement>('.yb')[1]!.click();
    await r.settle();
    expect(text(r, 'span')).toBe('30:1,21:1,12:1');
    await click(r, '#w');
    expect(text(r, 'span')).toBe('30:2,121:2,12:2');
  });
});

describe('forms the compiler follows, and forms it cannot: every one reaches the rows and the lets', () => {
  // each page: rows over ys, a cached let over ys, and what the alias reads; `#make` makes the alias, `#write` writes through it
  const page = (make: string, write: string, extra = '') => `<main data-sn-state="{ ys: [{ id: 1, n: 1 }, { id: 2, n: 2 }], sel: null, box: null, arr: [], r: 0 }" data-sn-let="{ T: sum(ys.map((y) => y.n)), view: keep(ys) }">
    <ul><template data-sn-for="y in ys" data-sn-key="y.id"><li data-sn-text="y.n"></li></template></ul>${extra}
    <button id="make" data-sn-on-click="${make}"></button><button id="write" data-sn-on-click="${write}; r = T"></button><p data-sn-text="T + ' ' + r"></p></main>`;
  const helpers = { sum, keep: (ys: Array<{ n: number }>) => ys.filter(() => true), pick: (ys: unknown[], i: number) => ys[i], find: (ys: Array<{ id: number }>, id: number) => ys.find((y) => y.id === id) };
  const cases: Array<[string, string, string]> = [
    ['a helper\'s result (anything under its arguments)', 'sel = pick(ys, 1)', 'sel.n = 50'],
    ['find(xs, id), a helper', 'sel = find(ys, 2)', 'sel.n = 50'],
    ['reduce(), which the compiler cannot follow', 'sel = ys.reduce((a, y) => (y.id === 2 ? y : a), null)', 'sel.n = 50'],
    ['a list method\'s element', 'sel = ys.find((y) => y.id === 2)', 'sel.n = 50'],
    ['arr.push(y), then arr[0].n', 'arr.push(ys[1])', 'arr[0].n = 50'],
    ['an alias stored inside another object', 'box = { it: ys[1] }', 'box.it.n = 50'],
    ['an alias assigned into another object', 'box = {}; box.it = ys[1]', 'box.it.n = 50'],
    ['an element of a let', 'sel = view[1]', 'sel.n = 50'],
    ['a copy of the list keeps its items', 'arr = [...ys]', 'arr[1].n = 50'],
    ['through a chain of aliases', 'sel = ys[1]; box = { it: sel }', 'box.it.n = 50'],
  ];
  for (const [what, make, write] of cases) test(what, async () => {
    const r = await render(page(make, write), { helpers });
    await click(r, '#make');
    await click(r, '#write');
    expect(text(r, 'li')).toBe('1,50');
    expect(text(r, 'p')).toBe('51 51');
  });

  test('the other way round: a write through the list reaches what reads an untraceable alias', async () => {
    const r = await render(page('sel = pick(ys, 1)', 'r = 0', '<b data-sn-text="sel ? sel.n : \'-\'"></b><button id="list" data-sn-on-click="ys[1].n = 60"></button>'), { helpers });
    await click(r, '#make');
    expect(text(r, 'b')).toBe('2');
    await click(r, '#list');
    expect(text(r, 'b')).toBe('60');
  });

  const components = {
    // the prop held in the component's own state, written there
    'c-hold': '<template data-sn-component="{ item: { n: number } }"><span data-sn-state="{ mine: item }"><button class="hold" data-sn-on-click="mine.n = 70"></button></span></template>',
    // the item handed back as an event's detail
    'c-pick': '<template data-sn-component="{ item: { n: number } }" data-sn-emits="{ pick: { n: number } }"><button class="pick" data-sn-on-click="emit(\'pick\', item)"></button></template>',
  };
  test('a prop held in a component\'s state, written there', async () => {
    const r = await render(page('r = 0', 'r = 0', '<c-hold data-sn-prop="{ item: ys[1] }"></c-hold>'), { helpers, components });
    await click(r, '.hold');
    expect(text(r, 'li')).toBe('1,70');
    await click(r, '#write');
    expect(text(r, 'p')).toBe('71 71');
  });

  test('an emit\'s detail, written by the listener', async () => {
    const r = await render(page('r = 0', 'sel.n = 80', '<c-pick data-sn-prop="{ item: ys[1] }" data-sn-on-pick="sel = $event.detail"></c-pick>'), { helpers, components });
    await click(r, '.pick');
    await click(r, '#write');
    expect(text(r, 'li')).toBe('1,80');
    expect(text(r, 'p')).toBe('81 81');
  });
});

describe('what the compiler adds to a handler\'s writes', () => {
  const helpers = { module: '/src/sinter.helpers.ts', names: ['pick', 'rows'], namespaces: {} };
  /** each click handler's written paths, by its button's id */
  const writes = (html: string) => {
    const out = compileParts(html, { file: '/p/index.html', root: '/p', dev: false, helpers, readFile: () => { throw new Error('none'); } });
    const ws: Record<string, string[]> = {};
    for (const n of [...out.ir.roots, ...out.ir.templates.flatMap((t) => t.nodes)]) for (const b of n.b) if (b.k === 'on' && b.w) ws[Object.keys(ws).length] = (b.w as string[]).slice().sort();
    return Object.values(ws);
  };
  test('a traceable alias: the aliased path, both ways; a field only ever given primitives is no alias', () => {
    expect(writes(`<main data-sn-state="{ ys: [{ n: 1 }], sel: null, k: 0 }"><b data-sn-text="ys[0].n + (sel ? sel.n : 0) + k"></b>
      <button data-sn-on-click="sel = ys[0]"></button><button data-sn-on-click="sel.n = 5"></button><button data-sn-on-click="ys[0].n = 6"></button>
      <button data-sn-on-click="k = rows(k, 3).length"></button></main>`)).toEqual([
      ['$s0.sel'], ['$s0.sel.n', '$s0.ys.0.n'], ['$s0.sel.n', '$s0.ys.0.n'], ['$s0.k'],
    ]);
  });
  test('a helper\'s result is anything under its arguments (a helper only reads them): under the list, not everything', () => {
    const ws = writes(`<main data-sn-state="{ ys: [{ n: 1 }], sel: null }"><b data-sn-text="ys[0].n + (sel ? sel.n : 0)"></b>
      <button data-sn-on-click="sel = pick(ys, 0)"></button><button data-sn-on-click="sel.n = 5"></button><button data-sn-on-click="ys[0].n = 6"></button></main>`);
    expect(ws.slice(1)).toEqual([['$s0.sel.n', '$s0.ys.**'], ['$s0.sel.**', '$s0.ys.0.n']]);
  });
  test('an untraceable alias written through: every state scope and resource; a change inside any object: what reads the alias', () => {
    const ws = writes(`<sn-resource name="r" src="/r"></sn-resource><main data-sn-state="{ ys: [{ n: 1 }], sel: null }"><b data-sn-text="ys[0].n + (sel ? sel.n : 0) + r.length"></b>
      <button data-sn-on-click="sel = ys.reduce((a, y) => y, null)"></button><button data-sn-on-click="sel.n = 5"></button><button data-sn-on-click="ys[0].n = 6"></button></main>`);
    expect(ws[1]).toEqual(expect.arrayContaining(['$s0.**', '$r.r.**']));
    expect(ws[2]).toEqual(['$s0.sel.**', '$s0.ys.0.n']);
  });
});

test('a component that shows a prop updates after the parent writes through an alias of it', async () => {
  const r = await render(`<main data-sn-state="{ ys: [{ n: 1 }, { n: 2 }], sel: null }"><c-show data-sn-prop="{ item: ys[1] }"></c-show>
    <button id="a" data-sn-on-click="sel = ys[1]"></button><button id="b" data-sn-on-click="sel.n = 90"></button></main>`, {
    components: { 'c-show': '<template data-sn-component="{ item: { n: number } }"><i data-sn-text="item.n"></i></template>' },
  });
  await click(r, '#a');
  await click(r, '#b');
  expect(text(r, 'i')).toBe('90');
});
