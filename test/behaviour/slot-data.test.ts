// @vitest-environment jsdom
// Slots that pass data, in the browser (docs/proposals/component-libraries.md, section 2): a data
// table with custom cells and a list with custom rows. Tables run on jsdom: happy-dom mis-parses
// `<tr>` and `<td>` inside a template.
import { describe, expect, test } from 'vitest';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const TABLE = `<template data-sn-props="{ rows: Row[]; columns: string[]; cell: Slot<{ row: Row; column: string }> }">
  <table><tbody>
    <template data-sn-for="r in rows" data-sn-key="r.id">
      <tr><template data-sn-for="c in columns"><td><slot name="cell" data-sn-prop="{ row: r, column: c }"><span class="plain" data-sn-text="r[c]"></span></slot></td></template></tr>
    </template>
  </tbody></table>
</template>`;

const INVOICES = [
  { id: 1, number: 'A-1', customer: 'Ada', total: 1200 },
  { id: 2, number: 'A-2', customer: 'Bo', total: 80 },
];

const LIST = `<template data-sn-props="{ items: Item[]; row: Slot<{ item: Item; first: boolean }> }">
  <ul><template data-sn-for="(it, i) in items" data-sn-key="it.id"><slot name="row" data-sn-prop="{ item: it, first: i === 0 }"><li data-sn-text="it.title"></li></slot></template></ul>
</template>`;

const TODOS = [{ id: 1, title: 'one', done: false }, { id: 2, title: 'two', done: true }];

describe('a data table with custom cells', () => {
  test('the fill renders per cell with `$slot`; an unfilled table shows the default', async () => {
    const requests = mockRequests({ 'GET /api/invoices': INVOICES });
    const { root, settle } = await render(`<sn-resource name="invoices" src="/api/invoices" key="id"></sn-resource>
      <div id="custom"><data-table data-sn-prop="{ rows: invoices, columns: ['number', 'customer', 'total'] }">
        <b slot="cell" data-sn-class="{ money: $slot.column === 'total' }" data-sn-text="$slot.column === 'total' ? '$' + $slot.row.total : $slot.row[$slot.column]"></b>
      </data-table></div>
      <div id="plain"><data-table data-sn-prop="{ rows: invoices, columns: ['customer'] }"></data-table></div>`, { requests, components: { 'data-table': TABLE } });
    await settle();
    const cells = [...root.querySelectorAll('#custom td')].map((td) => td.innerHTML);
    expect(cells).toEqual(['<b>A-1</b>', '<b>Ada</b>', '<b class="money">$1200</b>', '<b>A-2</b>', '<b>Bo</b>', '<b class="money">$80</b>']);
    expect([...root.querySelectorAll('#plain td')].map((td) => td.innerHTML)).toEqual(['<span class="plain">Ada</span>', '<span class="plain">Bo</span>']);
  });

  test('`remove($slot.row)` acts on the caller\'s resource', async () => {
    const requests = mockRequests({ 'GET /api/invoices': INVOICES });
    const { root, settle, flush } = await render(`<sn-resource name="invoices" src="/api/invoices" key="id"></sn-resource>
      <data-table data-sn-prop="{ rows: invoices, columns: ['number'] }">
        <button slot="cell" data-sn-on-click="remove($slot.row)" data-sn-text="$slot.row.number"></button>
      </data-table>`, { requests, components: { 'data-table': TABLE } });
    await settle();
    (root.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect([...root.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['A-2']);
  });
});

describe('a list with custom rows', () => {
  test('the fill reads `$slot`, writes the caller\'s state, and patches the row in its resource', async () => {
    const requests = mockRequests({ 'GET /api/todos': TODOS });
    const { root, settle, flush } = await render(`<sn-resource name="todos" src="/api/todos" key="id"></sn-resource>
      <div data-sn-state="{ picked: '' }">
        <p id="picked" data-sn-text="picked"></p>
        <todo-list data-sn-prop="{ items: todos }">
          <li slot="row" data-sn-class="{ done: $slot.item.done, first: $slot.first }" data-sn-on-click="picked = $slot.item.title; merge($slot.item, { done: !$slot.item.done })" data-sn-text="$slot.item.title"></li>
        </todo-list>
      </div>`, { requests, components: { 'todo-list': LIST } });
    await settle();
    const items = () => [...root.querySelectorAll('li')].map((li) => `${li.textContent}:${li.className}`);
    expect(items()).toEqual(['one:first', 'two:done']);
    (root.querySelector('li') as HTMLElement).click();
    await flush();
    expect(root.querySelector('#picked')!.textContent).toBe('one');
    expect(items()).toEqual(['one:first done', 'two:done']);
  });

  test('a fill that picks its element by a chain, with the default\'s children placed by `<slot>`', async () => {
    const ITEM = `<template data-sn-props="{ items: Item[]; row: Slot<{ item: Item }> }">
  <ul><template data-sn-for="it in items" data-sn-key="it.id"><slot name="row" data-sn-prop="{ item: it }"><li><span class="t" data-sn-text="it.title"></span></li></slot></template></ul>
</template>`;
    const requests = mockRequests({ 'GET /api/todos': TODOS });
    const { root, settle } = await render(`<sn-resource name="todos" src="/api/todos" key="id"></sn-resource>
      <todo-list data-sn-prop="{ items: todos }">
        <template slot="row" data-sn-if="$slot.item.done"><li class="done"><s><slot></slot></s></li></template>
        <template data-sn-else><li><slot></slot> (open)</li></template>
      </todo-list>`, { requests, components: { 'todo-list': ITEM } });
    await settle();
    expect([...root.querySelectorAll('li')].map((li) => li.outerHTML)).toEqual(['<li><span class="t">one</span> (open)</li>', '<li class="done"><s><span class="t">two</span></s></li>']);
  });
});

describe('first paint', () => {
  test('the early script renders fills in rows over state, and the takeover changes nothing', async () => {
    const page = `<div data-sn-state="{ todos: [{ id: 1, title: 'one', done: false }, { id: 2, title: 'two', done: true }] }"><todo-list data-sn-prop="{ items: todos }">
      <li slot="row" data-sn-class="{ done: $slot.item.done }" data-sn-text="$slot.item.title + ($slot.first ? '*' : '')"></li>
    </todo-list></div>`;
    const html = (root: ParentNode) => [...root.querySelectorAll('li')].map((li) => `${li.textContent}:${li.className}`);
    const early = await firstPaint(page, { components: { 'todo-list': LIST } });
    expect(html(early.root)).toEqual(['one*:', 'two:done']);
    const { root } = await render(page, { components: { 'todo-list': LIST } });
    expect(html(root)).toEqual(html(early.root));
  });

  test('plain slot content at the top of a component\'s unrolled row builds: the row\'s item is on the component\'s scope', async () => {
    const L = '<template data-sn-props="{ items: string[] }"><ul><template data-sn-for="it in items"><slot name="row"><li data-sn-text="it"></li></slot></template></ul></template>';
    const early = await firstPaint('<div data-sn-state="{ t: [\'a\', \'b\'] }"><x-l data-sn-prop="{ items: t }"><li slot="row">x</li></x-l></div>', { components: { 'x-l': L } });
    expect([...early.root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['x', 'x']);
  });
});
