// @vitest-environment jsdom
// Resource data is read-only (SN205; dev builds freeze it): a write through state that holds a resource's item, or a
// value made from one, changes no resource object, so it marks the state, not the resource and what reads it. Store
// functions change resources, and still reach the state that holds their items. A write in place into state that
// holds an item the build follows is SN205 (test/compiler/resource-write-through.test.ts); the dev freeze is what is
// left for one it does not (a helper's result, an untraceable value).
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { mockRequests, render } from '../../src/testing/index.js';

const text = (r: Awaited<ReturnType<typeof render>>, sel: string) => [...r.root.querySelectorAll(sel)].map((x) => x.textContent).join(',');
const click = async (r: Awaited<ReturnType<typeof render>>, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };
const touch = <T,>(xs: T[], i: number) => ({ at: xs[i], seen: true });
const helpers = { module: '/src/sinter.helpers.ts', names: ['touch'], namespaces: {} };
const writes = (html: string) => {
  const out = compileParts(html, { file: '/p/index.html', root: '/p', dev: false, helpers, readFile: () => { throw new Error('none'); } });
  return [...out.ir.roots, ...out.ir.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'on' && b.w).map((b) => (b.w as string[]).slice().sort()));
};

const PAGE = `<sn-resource name="todos" src="/api/todos" key="id"></sn-resource><main data-sn-state="{ sel: null, view: null }">
  <ul><template data-sn-for="t in todos"><li data-sn-text="t.n"></li></template></ul><b data-sn-text="sel ? sel.n : '-'"></b><i data-sn-text="view ? view.seen : '-'"></i>
  <button id="a" data-sn-on-click="sel = todos[1]; view = touch(todos, 1)"></button><button id="m" data-sn-on-click="merge(todos[1], { n: 20 })"></button>
  <button id="w" data-sn-on-click="view.seen = false"></button></main>`;

describe('a write through state that holds a resource\'s item, or a value made from one', () => {
  test('marks the state only: no path of the resource', () => {
    const w = writes(PAGE).find((x) => x.includes('$s0.view.seen'))!;
    expect(w.filter((p) => p.startsWith('$r.'))).toEqual([]);
  });
  test('the page shows the state\'s write, and a merge() through the resource still reaches the state that holds the item', async () => {
    const r = await render(PAGE, { requests: mockRequests({ 'GET /api/todos': [{ id: 1, n: 1 }, { id: 2, n: 2 }] } as never), helpers: { touch } });
    await r.settle();
    await click(r, '#a');
    expect(text(r, 'b')).toBe('2');
    expect(text(r, 'i')).toBe('true');
    await click(r, '#w');
    expect(text(r, 'i')).toBe('false');
    await click(r, '#m');
    expect(text(r, 'li')).toBe('1,20');
  });
  test('a write into the item through a value the build cannot follow throws in a dev build (what is left to the freeze)', async () => {
    const r = await render(`<sn-resource name="todos" src="/api/todos" key="id"></sn-resource><main data-sn-state="{ sel: null }"><b data-sn-text="sel ? sel.n : '-'"></b>
      <button id="a" data-sn-on-click="sel = todos.reduce((a, t) => a ?? t, null)"></button><button id="w" data-sn-on-click="sel.n = 9"></button></main>`, { requests: mockRequests({ 'GET /api/todos': [{ id: 1, n: 1 }] } as never), strict: false });
    await r.settle();
    await click(r, '#a');
    const errors: unknown[] = [];
    const was = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    try { await click(r, '#w'); } finally { console.error = was; }
    expect(r.root.querySelector('b')!.textContent).toBe('1');
    expect(Object.isFrozen((r.state(r.root.querySelector('main')!).get() as { sel: object }).sel)).toBe(true);
  });
});
