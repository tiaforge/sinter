// Writes through a row index (`rows[i].v = …`) reach only the row at that index (IR v2: the path's
// `{i}` segment is an offset into the list's rows, so the other rows are not visited at all; before,
// each row was checked and only that one evaluated). The rows must render as before in every case,
// including the ones where the runtime falls back to visiting every row. The cost is measured in
// bench/runtime/flush.bench.ts.
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

const input = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const texts = (root: Element, sel = 'b') => [...root.querySelectorAll(sel)].map((e) => e.textContent);

/** a helper that counts the evaluations of the expressions that call it, by row index */
function counter() {
  const seen: number[] = [];
  return { seen, helpers: { seen: (i: number, v: unknown) => (seen.push(i), v) } };
}

const LIST = (n: number) => `<div data-sn-state="{ rows: Array.from({ length: ${n} }, (_, i) => ({ v: i })) }">
  <template data-sn-for="(r, i) in rows"><p><input data-sn-model="rows[i].v"><b data-sn-text="seen(i, rows[i].v)"></b><button data-sn-on-click="rows[i].v = rows[i].v + 10">+</button></p></template>
  <button id="lit" data-sn-on-click="rows[2].v = 'two'">2</button>
  <button id="sw" data-sn-on-click="rows.splice(0, 1); rows[0].v = 'first'">s</button>
  <button id="ws" data-sn-on-click="rows[1].v = 'was one'; rows.splice(0, 1)">w</button>
</div>`;

test('typing in one row re-evaluates that row only', async () => {
  const c = counter(), { root, flush } = await render(LIST(5), { helpers: c.helpers });
  c.seen.length = 0;
  input(root.querySelectorAll('input')[3]!, 'x');
  await flush();
  expect(texts(root)).toEqual(['0', '1', '2', 'x', '4']);
  expect(c.seen).toEqual([3]);
});

test('a handler in a row writing through its index re-evaluates that row only', async () => {
  const c = counter(), { root, flush } = await render(LIST(5), { helpers: c.helpers });
  c.seen.length = 0;
  root.querySelectorAll<HTMLButtonElement>('p button')[1]!.click();
  await flush();
  expect(texts(root)).toEqual(['0', '11', '2', '3', '4']);
  expect(c.seen).toEqual([1]);
});

test('a write through a literal index from outside the list reaches that row', async () => {
  const c = counter(), { root, flush } = await render(LIST(5), { helpers: c.helpers });
  c.seen.length = 0;
  root.querySelector<HTMLButtonElement>('#lit')!.click();
  await flush();
  expect(texts(root)).toEqual(['0', '1', 'two', '3', '4']);
  expect(c.seen).toEqual([2]);
});

test('a structure change and an indexed write in one handler, in either order', async () => {
  const a = await render(LIST(4), { helpers: counter().helpers });
  a.root.querySelector<HTMLButtonElement>('#sw')!.click();
  await a.flush();
  expect(texts(a.root)).toEqual(['first', '2', '3']);
  const b = await render(LIST(4), { helpers: counter().helpers });
  b.root.querySelector<HTMLButtonElement>('#ws')!.click();
  await b.flush();
  expect(texts(b.root)).toEqual(['was one', '2', '3']);
  // and indexed writes after the rows moved address the rows where they are now
  input(b.root.querySelectorAll('input')[1]!, 'y');
  await b.flush();
  expect(texts(b.root)).toEqual(['was one', 'y', '3']);
});

test('rows that read their index re-render after a move, then indexed writes still reach one row', async () => {
  const c = counter(), { root, flush } = await render(`<div data-sn-state="{ rows: [{ v: 'a' }, { v: 'b' }, { v: 'c' }] }">
    <template data-sn-for="(r, i) in rows"><p><input data-sn-model="rows[i].v"><b data-sn-text="seen(i, i + ':' + rows[i].v)"></b></p></template>
    <button data-sn-on-click="rows.reverse()">r</button></div>`, { helpers: c.helpers });
  root.querySelector<HTMLButtonElement>('button')!.click();
  await flush();
  expect(texts(root)).toEqual(['0:c', '1:b', '2:a']);
  c.seen.length = 0;
  input(root.querySelectorAll('input')[2]!, 'z');
  await flush();
  expect(texts(root)).toEqual(['0:c', '1:b', '2:z']);
  expect(c.seen).toEqual([2]);
});

test('nested lists: the inner index selects inner rows, in every outer row that reads them', async () => {
  const { root, flush } = await render(`<div data-sn-state="{ gs: [{ xs: [{ v: 1 }, { v: 2 }] }, { xs: [{ v: 3 }, { v: 4 }] }] }">
    <template data-sn-for="(g, i) in gs"><section><template data-sn-for="(x, j) in g.xs"><p><input data-sn-model="gs[i].xs[j].v"><b data-sn-text="gs[i].xs[j].v"></b><i data-sn-text="gs[0].xs[j].v"></i></p></template></section></template>
  </div>`);
  input(root.querySelectorAll('input')[1]!, 'B');
  await flush();
  expect(texts(root)).toEqual(['1', 'B', '3', '4']);
  // every outer row shows the first group's items: the second group's second row too
  expect(texts(root, 'i')).toEqual(['1', 'B', '1', 'B']);
  input(root.querySelectorAll('input')[2]!, 'C');
  await flush();
  expect(texts(root)).toEqual(['1', 'B', 'C', '4']);
});

test('an inner list that names its index as the outer one does, reading another list by it', async () => {
  const { root, flush } = await render(`<div data-sn-state="{ gs: [{ xs: [{ v: 1 }, { v: 2 }] }, { xs: [{ v: 3 }, { v: 4 }] }] }">
    <template data-sn-for="(g, i) in gs"><section><template data-sn-for="(x, i) in g.xs"><p><input data-sn-model="gs[0].xs[i].v"><b data-sn-text="gs[0].xs[i].v"></b></p></template></section></template>
  </div>`);
  // the second group's first row writes the first group's first item, which both groups show
  input(root.querySelectorAll('input')[2]!, 'A');
  await flush();
  expect(texts(root)).toEqual(['A', '2', 'A', '2']);
});

test('rows in a closed dialog catch up when it opens', async () => {
  const { root, flush } = await render(`<div data-sn-state="{ rows: [{ v: 'a' }, { v: 'b' }, { v: 'c' }] }">
    <dialog id="d"><template data-sn-for="(r, i) in rows"><p><b data-sn-text="i + rows[i].v"></b></p></template></dialog>
    <button id="x" data-sn-on-click="rows.splice(0, 1); rows[1].v = 'z'">x</button>
    <button id="y" data-sn-on-click="rows[0].v = 'y'">y</button>
    <button id="o" data-sn-on-click="showModal('d')">o</button></div>`);
  root.querySelector<HTMLButtonElement>('#x')!.click();
  await flush();
  root.querySelector<HTMLButtonElement>('#y')!.click();
  await flush();
  root.querySelector<HTMLButtonElement>('#o')!.click();
  await flush();
  // happy-dom does not fire `toggle` for showModal()
  root.querySelector('dialog')!.dispatchEvent(new Event('toggle'));
  await flush();
  expect(texts(root)).toEqual(['0y', '1z']);
});

test('a write that reaches every row still renders all of them', async () => {
  const { root, flush } = await render(`<div data-sn-state="{ rows: [{ v: 1 }, { v: 2 }], k: 'v' }">
    <template data-sn-for="(r, i) in rows"><p><b data-sn-text="rows[i][k]"></b></p></template>
    <button data-sn-on-click="rows.forEach((r) => r.v = r.v * 10)">x</button></div>`);
  root.querySelector<HTMLButtonElement>('button')!.click();
  await flush();
  expect(texts(root)).toEqual(['10', '20']);
});
