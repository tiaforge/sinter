import { expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { mockRequests, render } from '../../src/testing/index.js';

const compile = (body: string) => compileParts(`<!DOCTYPE html><html><head></head><body>${body}</body></html>`, {
  file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
});

test('compiler: a row value `row side === outer side` is a selection binding; other shapes are not', () => {
  const { ir, fns } = compile(`
    <div data-sn-state="{ sel: 1, other: 2, rows: [{id: 1, g: 'a'}, {id: 2, g: 'b'}] }">
      <template data-sn-for="(r, i) in rows">
        <li data-sn-class="{active: r.id === sel, odd: i % 2 === 1, same: r.id === r.g, flag: sel !== r.g, loose: r.id == sel}"
            data-sn-attr="{'aria-selected': sel === r.id ? 'true' : 'false'}" data-sn-show="r.id !== other"></li>
      </template>
      <p data-sn-class="{on: sel === 1}"></p>
    </div>`);
  const li = ir.templates[0]!.nodes[0]!;
  const by = (n: string) => li.b.find((b) => b.n === n)!;
  expect(by('active').s).toEqual({ r: expect.any(Number), o: expect.any(Number), d: ['$s0.sel'] });
  expect(fns[by('active').s!.r]).toBe('($) => ($.r.id)');
  expect(fns[by('active').s!.o]).toBe('($) => ($.$s0.sel)');
  expect(by('odd').s).toBeUndefined(); // `i % 2` against a literal: the outer side depends on nothing
  expect(by('same').s).toBeUndefined(); // both sides read the row
  expect(by('flag').s).toEqual({ r: expect.any(Number), o: expect.any(Number), d: ['$s0.sel'], x: 1 });
  expect(by('loose').s).toBeUndefined(); // `==` is not an index lookup
  expect(by('aria-selected').s).toBeUndefined(); // a ternary around the comparison
  expect(li.b.find((b) => b.k === 'show')!.s).toEqual({ r: expect.any(Number), o: expect.any(Number), d: ['$s0.other'], x: 1 });
  // outside a row there is no selection
  expect(ir.roots.find((n) => n.tag === 'p')!.b[0]!.s).toBeUndefined();
});

test('a selection change re-evaluates only the rows it concerns; the result is the same as evaluating every row', async () => {
  const seen: unknown[] = [];
  const { root, flush } = await render(`
    <div data-sn-state="{ sel: 2, rows: [{id: 1}, {id: 2}, {id: 3}, {id: 4}] }">
      <ul><template data-sn-for="r in rows"><li data-sn-class="{active: tap(r.id) === sel, other: r.id !== sel}" data-sn-text="r.id"></li></template></ul>
      <button id="pick3" data-sn-on-click="sel = 3">3</button>
      <button id="pick9" data-sn-on-click="sel = 9">9</button>
      <button id="rename" data-sn-on-click="rows[0].id = 3">rename</button>
      <button id="add" data-sn-on-click="rows.push({id: 5})">add</button>
      <button id="pick5" data-sn-on-click="sel = 5">5</button>
    </div>`, { helpers: { tap: (x: unknown) => (seen.push(x), x) } });
  const click = (id: string) => (root.querySelector('#' + id) as HTMLElement).click();
  const having = (c: string) => [...root.querySelectorAll('li')].filter((li) => li.classList.contains(c)).map((li) => li.textContent);
  expect(having('active')).toEqual(['2']);
  expect(having('other')).toEqual(['1', '3', '4']);
  seen.length = 0;

  // first selection change: the index is built (every row once), then only rows 2 and 3 are evaluated
  click('pick3');
  await flush();
  expect(having('active')).toEqual(['3']);
  expect(having('other')).toEqual(['1', '2', '4']);
  expect(seen).toEqual([1, 2, 3, 4, 2, 3]);
  seen.length = 0;

  // second change: the index is there; a value no row has only clears the previous one
  click('pick9');
  await flush();
  expect(having('active')).toEqual([]);
  expect(having('other')).toEqual(['1', '2', '3', '4']);
  expect(seen).toEqual([3]);
  seen.length = 0;

  // the row side changes: the rows render as usual, and the index is rebuilt on the next selection
  click('rename');
  await flush();
  click('pick3');
  await flush();
  expect(having('active')).toEqual(['3', '3']);
  expect(having('other')).toEqual(['2', '4']);

  // rows added: reconcile drops the index; the new row is found
  click('add');
  await flush();
  click('pick5');
  await flush();
  expect(having('active')).toEqual(['5']);
  expect(having('other')).toEqual(['3', '2', '3', '4']);
});

test('selection over a resource, an outer loop variable as the outer side, and both sides changing in one flush', async () => {
  const { root, flush, settle } = await render(`
    <sn-resource name="items" src="/api/items" key="id"></sn-resource>
    <div data-sn-state="{ sel: 'b', groups: [{pick: 1}, {pick: 2}] }">
      <template data-sn-for="it in items"><b data-sn-class="{on: it.code === sel}" data-sn-text="it.code"></b></template>
      <template data-sn-for="g in groups"><section><template data-sn-for="n in [1, 2, 3]" data-sn-key="n"><i data-sn-class="{on: n === g.pick}" data-sn-text="n"></i></template></section></template>
      <button id="c" data-sn-on-click="sel = 'c'">c</button>
      <button id="g" data-sn-on-click="groups[1].pick = 3">g</button>
      <button id="both" data-sn-on-click="sel = 'a'; patch('items', items[0], {code: 'z'})">both</button>
    </div>`, { requests: mockRequests({ 'GET /api/items': [{ id: 1, code: 'a' }, { id: 2, code: 'b' }, { id: 3, code: 'c' }] }) });
  const click = (id: string) => (root.querySelector('#' + id) as HTMLElement).click();
  const on = (s: string) => [...root.querySelectorAll(s)].filter((e) => e.classList.contains('on')).map((e) => e.textContent);
  await settle();
  expect(on('b')).toEqual(['b']);
  expect(on('section:nth-of-type(1) i')).toEqual(['1']);
  expect(on('section:nth-of-type(2) i')).toEqual(['2']);
  click('c');
  await flush();
  expect(on('b')).toEqual(['c']);
  // the same value again: nothing changes
  click('c');
  await flush();
  expect(on('b')).toEqual(['c']);
  click('g');
  await flush();
  expect(on('section:nth-of-type(1) i')).toEqual(['1']);
  expect(on('section:nth-of-type(2) i')).toEqual(['3']);
  // the selection moves to the row whose row side changes in the same flush: the rows render in full
  click('both');
  await settle();
  expect([...root.querySelectorAll('b')].map((e) => e.textContent)).toEqual(['z', 'b', 'c']);
  expect(on('b')).toEqual([]);
});
