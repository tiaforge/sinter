// @vitest-environment jsdom
// A DOM event's `$event` (docs/spec.md, Aliases) is the browser's: it holds none of the page's objects, so a value made
// from it (`sel = pick($event, sel)`) aliases only what else it was made from. Unless the page sends an event of that
// name itself (a component that declares it, an `emit()`): then its detail may be any of the page's objects.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const text = (r: Awaited<ReturnType<typeof render>>, sel: string) => [...r.root.querySelectorAll(sel)].map((x) => x.textContent).join(',');
const click = async (r: Awaited<ReturnType<typeof render>>, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };
/** a helper that is handed the event: a new selection, or the one it had */
const step = (e: Event, sel: { n: number } | null) => (e.type === 'click' ? { n: (sel?.n ?? 0) + 1 } : sel);
const helpers = { module: '/src/sinter.helpers.ts', names: ['step'], namespaces: {} };
const writes = (html: string, components?: Record<string, string>) => {
  const out = compileParts(html, { file: '/p/index.html', root: '/p', dev: false, helpers, readFile: (f: string) => { const n = /components\/(.+)\.html$/.exec(f)?.[1]; if (n && components?.[n]) return components[n]!; throw new Error('none'); }, ...(components ? { componentNames: Object.keys(components) } : {}) });
  return [...out.ir.roots, ...out.ir.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'on' && b.w).map((b) => (b.w as string[]).slice().sort()));
};
const everything = (ws: string[]) => ws.includes('$s0.**');

const PAGE = `<main data-sn-state="{ ys: [{ n: 1 }], sel: null }"><ul><template data-sn-for="y in ys"><li data-sn-text="y.n"></li></template></ul><b data-sn-text="sel ? sel.n : '-'"></b>
  <button id="a" data-sn-on-click="sel = step($event, sel)"></button><button id="k" data-sn-on-keydown-enter="sel = step($event, sel)"></button>
  <button id="b" data-sn-on-click="sel.n = sel.n + 10"></button></main>`;

describe('a DOM event\'s `$event`', () => {
  test('holds none of the page\'s objects: a write through a value made from it is not everything', () => {
    const ws = writes(PAGE);
    expect(ws.map(everything)).toEqual([false, false, false]);
    // (what the helper may return of its other argument is `sel` itself)
    expect(ws[2]).toEqual(['$s0.sel.n']);
  });
  test('the page shows the writes', async () => {
    const r = await render(PAGE, { helpers: { step } });
    await click(r, '#a');
    expect(text(r, 'b')).toBe('1');
    await click(r, '#b');
    expect(text(r, 'b')).toBe('11');
    expect(text(r, 'li')).toBe('1');
  });
});

describe('an event of a DOM event\'s name the page sends itself', () => {
  const components = { 'c-sel': '<template data-sn-props="{ ys: Array<{ n: number }> }" data-sn-emits="{ select: { n: number } }"><button class="s" data-sn-on-click="emit(\'select\', ys[0])"></button></template>' };
  const COMPONENT = `<main data-sn-state="{ ys: [{ n: 1 }], sel: null }"><ul><template data-sn-for="y in ys"><li data-sn-text="y.n"></li></template></ul>
    <c-sel data-sn-with="{ ys }" data-sn-on-select="sel = $event.detail"></c-sel><button id="b" data-sn-on-click="sel.n = 20"></button></main>`;
  test('a component that declares it: its detail may be any object, as before', () => {
    expect(writes(COMPONENT, components).some(everything)).toBe(true);
  });
  test('a component that declares it: the list shows a write through its detail', async () => {
    const r = await render(COMPONENT, { components });
    await click(r, '.s');
    await click(r, '#b');
    expect(text(r, 'li')).toBe('20');
  });

  const EMIT = `<main data-sn-state="{ ys: [{ n: 1 }], sel: null }" data-sn-on-click="$event.detail && $event.detail.n && (sel = $event.detail)"><ul><template data-sn-for="y in ys"><li data-sn-text="y.n"></li></template></ul>
    <button id="e" data-sn-on-mouseup="emit('click', ys[0])"></button><button id="b" data-sn-on-mousedown="sel.n = 30"></button></main>`;
  test('an `emit()` of the page: its detail may be any object, and the list shows a write through it', async () => {
    expect(writes(EMIT).some(everything)).toBe(true);
    const r = await render(EMIT);
    r.root.querySelector('#e')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await r.settle();
    expect(text(r, 'li')).toBe('1');
    r.root.querySelector('#b')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await r.settle();
    expect(text(r, 'li')).toBe('30');
  });
});
