// @vitest-environment jsdom
// A component script's state (docs/spec.md, Aliases): the build reads the script, and when every write to its state is
// a value that holds none of the page's objects (src/script-values.ts), the state is no alias of anything; else its
// fields may hold any object, and a write inside one marks everything.
import { describe, expect, test } from 'vitest';
import { Component } from '../../src/components.js';
import { compileParts } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const text = (r: Awaited<ReturnType<typeof render>>, sel: string) => [...r.root.querySelectorAll(sel)].map((x) => x.textContent).join(',');
const click = async (r: Awaited<ReturnType<typeof render>>, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };
const w36 = (r: Awaited<ReturnType<typeof render>>) => r.warnings().filter((w) => w.code == 36).map((w) => w.message);

const HOLD = `<template data-sn-props="{ item: { n: number } }"><span data-sn-state="{ held: null, count: 0 }"><i class="c" data-sn-text="count"></i>
  <button class="w" data-sn-on-click="held && (held.n = held.n + 10)"></button></span></template>`;
/** follows the rule: its state gets a number and a copy of the prop */
class Counts extends Component<{ item: { n: number } }, {}, {}, { held: { n: number } | null; count: number }> {
  connected() { this.root.addEventListener('mouseover', () => { this.state.count = this.state.count + 1; this.state.held = structuredClone(this.props.item); }); }
}
/** breaks it: its state keeps the prop's object itself */
class Keeps extends Component<{ item: { n: number } }, {}, {}, { held: { n: number } | null; count: number }> {
  connected() { this.root.addEventListener('mouseover', () => { this.state.held = this.props.item; }); }
}
const PAGE = `<main data-sn-state="{ ys: [{ n: 1 }], k: 0 }"><ul><template data-sn-for="y in ys"><li data-sn-text="y.n"></li></template></ul>
  <x-hold data-sn-with="{ item: ys[0] }"></x-hold><button id="k" data-sn-on-click="k = k + 1; ys[0].n = ys[0].n + 1"></button></main>`;
const hover = async (r: Awaited<ReturnType<typeof render>>) => { r.root.querySelector('.c')!.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await r.settle(); };
/** the handlers' write lists, the component's script read from its class's code */
const writes = (cls: () => void) => {
  const files: Record<string, string> = { '/p/src/components/x-hold.html': HOLD, '/p/src/components/x-hold.ts': `export default ${cls.toString()}` };
  const out = compileParts(PAGE, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, componentNames: ['x-hold'],
    readFile: (f: string) => { if (f in files) return files[f]!; throw new Error('none'); }, listFiles: () => Object.keys(files) });
  return [...out.ir.roots, ...out.ir.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'on' && b.w).map((b) => b.w as string[]));
};
const everything = (w: string[]) => w.includes('$s0.**');

describe('a component script\'s state', () => {
  test('a script that gives its state only primitives and copies: no handler marks everything; one that keeps the prop\'s object: its state\'s writes do', () => {
    expect(writes(Counts as never).some(everything)).toBe(false);
    expect(writes(Keeps as never).some(everything)).toBe(true);
  });
  test('a script that gives its state only primitives and copies: its writes are followed, and the page shows them', async () => {
    const r = await render(PAGE, { components: { 'x-hold': HOLD }, scripts: { 'x-hold': Counts }, strict: false });
    await hover(r);
    expect(text(r, '.c')).toBe('1');
    await click(r, '.w');
    // the copy changed, not the page's item
    expect(text(r, 'li')).toBe('1');
    await click(r, '#k');
    expect(text(r, 'li')).toBe('2');
    expect(w36(r)).toEqual([]);
  });
  test('a script that keeps the prop\'s object: untraceable, and a write through its state still reaches the list', async () => {
    const r = await render(PAGE, { components: { 'x-hold': HOLD }, scripts: { 'x-hold': Keeps }, strict: false });
    await hover(r);
    await click(r, '.w');
    expect(text(r, 'li')).toBe('11');
    expect(w36(r)).toEqual([]);
  });
  test('forced traced (a stand-in that is not the script): the dev module\'s check fires', async () => {
    const r = await render(PAGE, { components: { 'x-hold': HOLD }, scripts: { 'x-hold': Keeps }, files: { 'src/components/x-hold.ts': 'export default class X { connected() { this.state.held = null; } }' }, strict: false });
    await hover(r);
    await click(r, '.w');
    // (a scope no mark is in at all: warning 15, the scope-level form of the check)
    expect(r.warnings().filter((w) => w.code == 15 || w.code == 36).map((w) => w.message)).toEqual([expect.stringMatching(/^sinter: state `ys`, `k` changed outside sinter/)]);
  });
});
