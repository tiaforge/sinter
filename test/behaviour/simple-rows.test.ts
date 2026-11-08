import { expect, test } from 'vitest';
import { mockRequests, render } from '../../src/testing/index.js';

// Rows of a simple template (value bindings and handlers only) keep no binding objects: their
// handlers bind to an element on its first event, their elements are found again when they render.

test('handlers in simple rows: a click on the row element, a debounced handler keeps one timer across events, an action', async () => {
  const { root, flush, advance, settle } = await render(`
    <div data-sn-state="{ rows: [{id: 1, n: 0}, {id: 2, n: 0}], log: [] }">
      <ul><template data-sn-for="r in rows">
        <li data-sn-attr="{'data-row': r.id}" data-sn-on-click="r.n++"><span data-sn-text="r.id + ':' + r.n"></span>
          <button class="d" data-sn-on-input="log.push('typed ' + r.id)" data-sn-debounce="100">d</button>
          <button class="a" data-sn-post="/api/rows/{r.id}" data-sn-then="log.push('posted ' + r.id)">a</button>
        </li>
      </template></ul>
      <p data-sn-text="log.join(',')"></p>
    </div>`, { requests: mockRequests({ 'POST /api/rows/1': { ok: true }, 'POST /api/rows/2': { ok: true } }) });
  const li = () => [...root.querySelectorAll('li span')].map((e) => e.textContent);
  const log = () => root.querySelector('p')!.textContent;
  const row = (n: number) => root.querySelector(`[data-row="${n}"]`) as HTMLElement;
  expect(li()).toEqual(['1:0', '2:0']);

  // a click on the row element (first event binds it)
  row(1).click();
  await flush();
  row(1).click();
  await flush();
  expect(li()).toEqual(['1:2', '2:0']);

  // two inputs within the debounce: one run (the bound handler object is kept on the element)
  const d = row(2).querySelector('.d')!;
  d.dispatchEvent(new Event('input', { bubbles: true }));
  await advance(50);
  d.dispatchEvent(new Event('input', { bubbles: true }));
  await advance(150);
  await flush();
  expect(log()).toBe('typed 2');

  // an action in a row
  (row(1).querySelector('.a') as HTMLElement).click();
  await settle();
  expect(log()).toBe('typed 2,posted 1');
});

test('`$el` in a simple row, a multi-node row with a handler in its second node, rows added later', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ rows: [{id: 1}, {id: 2}], picked: 0 }">
      <dl><template data-sn-for="r in rows">
        <dt data-sn-text="r.id" data-sn-attr="{'data-tag': $el.localName + r.id}"></dt>
        <dd><button data-sn-on-click="picked = r.id" data-sn-class="{on: r.id === picked}">pick</button></dd>
      </template></dl>
      <button id="add" data-sn-on-click="rows.push({id: 3})">add</button>
    </div>`);
  const dts = () => [...root.querySelectorAll('dt')].map((e) => e.getAttribute('data-tag'));
  const on = () => [...root.querySelectorAll('dd button')].map((b) => b.classList.contains('on'));
  expect(dts()).toEqual(['dt1', 'dt2']);
  (root.querySelectorAll('dd button')[1] as HTMLElement).click();
  await flush();
  expect(on()).toEqual([false, true]);
  (root.querySelector('#add') as HTMLElement).click();
  await flush();
  expect(dts()).toEqual(['dt1', 'dt2', 'dt3']);
  (root.querySelectorAll('dd button')[2] as HTMLElement).click();
  await flush();
  expect(on()).toEqual([false, false, true]);
});
