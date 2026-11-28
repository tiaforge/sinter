// @vitest-environment jsdom
// A helper called again and again with the same arguments while the page renders (warning 38, dev.ts;
// docs/expressions.md, Memoized helpers). A `data-sn-let` or a prop is its expression at every read, so a helper in
// one runs for every binding and row that reads it; a dev build counts an app helper's calls in values and, when the
// repeats alone took time, names the helper and `memo()`. The limits and the clock are `REPEATS` (dev.ts): the tests
// set them, and each helper here moves the clock by what a call of it costs.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { REPEATS } from '../../src/dev.js';
import { memo } from '../../src/memo.js';
import { render } from '../../src/testing/index.js';

type R = Awaited<ReturnType<typeof render>>;
const warned = (r: R) => r.warnings().filter((w) => w.code == 38).map((w) => w.message);
const click = async (r: R, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };

let clock = 0;
const was = { ...REPEATS };
beforeEach(() => { clock = 0; Object.assign(REPEATS, was, { now: () => clock }); });
afterEach(() => { Object.assign(REPEATS, was); });

/** a helper that takes `cost` milliseconds a call, and its calls */
const slow = (cost: number) => {
  const calls: unknown[][] = [];
  const grid = (...args: unknown[]) => { calls.push(args); clock += cost; return Array.from({ length: 3 }, (_, i) => `${args[0]}-${i}`); };
  return { calls, grid };
};
const rows = (n: number) => Array.from({ length: n }, (_, i) => i).join(', ');
/** `n` rows, each reading the let of the page through two bindings */
const page = (n = 30) => `<main data-sn-state="{ ym: '2026-11', xs: [${rows(n)}], n: 0 }" data-sn-let="{ cells: grid(ym) }">
  <template data-sn-for="x in xs"><p><i data-sn-text="cells.length + x + n"></i><b data-sn-attr="{ title: cells[0] }"></b></p></template>
  <button id="n" data-sn-on-click="n++"></button><button id="ym" data-sn-on-click="ym = '2026-12'"></button></main>`;

describe('warning 38: a helper called with the same arguments again and again while the page renders', () => {
  test('a let of the page read by every row: the helper, its calls, the time of the repeats, the let and memo()', async () => {
    const { calls, grid } = slow(0.1);
    const r = await render(page(), { helpers: { grid } });
    expect(calls.length).toBe(60);
    const [m, ...more] = warned(r);
    expect(more).toEqual([]);
    expect(m).toContain('helper `grid` was called 60 times while the page rendered, 59 of them with the same arguments as an earlier call of the same render, and those repeats took 5.9 ms.');
    expect(m).toMatch(/It is read through `cells` \(`data-sn-let`, [^)]*:1:\d+\)\./);
    expect(m).toContain('`export const grid = memo(gridImpl)`');
    expect(m).toContain('@tiaforge-ui/sinter/memo');
    // its argument is a string, which memo() keys
    expect(m).not.toContain('Here argument');
  });

  test('an argument memo() cannot key (an array of objects): the message names it', async () => {
    const days = (list: Array<{ d: string }>, ym: string) => { clock += 0.1; return list.filter((x) => x.d.startsWith(ym)); };
    const r = await render(page().replace('n: 0 }', "n: 0, all: [{ d: '2026-11-01' }] }").replace('{ cells: grid(ym) }', '{ cells: days(all, ym) }'), { helpers: { days } });
    const [m] = warned(r);
    expect(m).toContain('helper `days` was called 60 times');
    expect(m).toContain('if `days` takes one, wrap the expensive function it calls instead. Here argument 1 is one.');
  });

  test('once a helper, however often it happens again; another helper has its own', async () => {
    const { grid } = slow(0.1);
    const other = (s: string) => { clock += 0.2; return s.length; };
    const r = await render(page().replace('{ cells: grid(ym) }', '{ cells: grid(ym), len: other(ym) }').replace('cells.length + x + n', 'cells.length + x + n + (n ? len : 0)'), { helpers: { grid, other } });
    expect(warned(r).length).toBe(1);
    await click(r, '#n');
    expect(warned(r).map((m) => /helper `(\w+)`/.exec(m)![1])).toEqual(['grid', 'other']);
    await click(r, '#n');
    await click(r, '#ym');
    expect(warned(r).length).toBe(2);
  });

  test('different arguments at every call: nothing, whatever the calls cost', async () => {
    const calls: number[] = [];
    const label = (x: number, o: { pad: number }) => { calls.push(x); clock += 1; return String(x).padStart(o.pad, '0'); };
    // (a new object at every call is another argument, even an equal one)
    const r = await render(`<main data-sn-state="{ xs: [${rows(40)}], o: { pad: 2 } }">
      <template data-sn-for="x in xs"><p data-sn-text="label(x, o) + label(x + 100, { pad: 4 })"></p></template></main>`, { helpers: { label } });
    expect(calls.length).toBe(80);
    expect(warned(r)).toEqual([]);
  });

  test('cheap repeats, and a few slow ones, stay under the limits; the limits are the test\'s to set', async () => {
    // 59 repeats of 0.05 ms: 3 ms, under 5
    expect(warned(await render(page(), { helpers: { grid: slow(0.05).grid } }))).toEqual([]);
    // 9 repeats of 5 ms: under 20 repeats
    expect(warned(await render(page(5), { helpers: { grid: slow(5).grid } }))).toEqual([]);
    REPEATS.calls = 5;
    expect(warned(await render(page(5), { helpers: { grid: slow(5).grid } })).length).toBe(1);
    REPEATS.calls = 20;
    REPEATS.ms = 2;
    expect(warned(await render(page(), { helpers: { grid: slow(0.05).grid } })).length).toBe(1);
  });

  test('many repeats of a helper that costs less than memo() would: nothing', async () => {
    REPEATS.ms = 0.1;
    // 59 repeats of 4 microseconds: 0.24 ms, over this test's limit, but under 5 microseconds a call
    expect(warned(await render(page(), { helpers: { grid: slow(0.004).grid } }))).toEqual([]);
    REPEATS.each = 0.003;
    expect(warned(await render(page(), { helpers: { grid: slow(0.004).grid } })).length).toBe(1);
  });

  test('the renders that follow each other add up; renders further apart than the gap do not', async () => {
    // 6 rows: 11 repeats (3.3 ms) at the mount, 5 (1.5 ms) a click
    const apart = await render(page(6), { helpers: { grid: slow(0.3).grid } });
    for (let i = 0; i < 4; i++) { clock += 2000; await click(apart, '#n'); }
    expect(warned(apart)).toEqual([]);
    const close = await render(page(6), { helpers: { grid: slow(0.3).grid } });
    await click(close, '#n');
    expect(warned(close)).toEqual([]);
    await click(close, '#n');
    expect(warned(close)[0]).toContain('helper `grid` was called 24 times while the page rendered, 21 of them with the same arguments');
  });

  test('the same arguments in another render are not repeats, and a handler\'s reads are not counted', async () => {
    const { grid } = slow(1);
    const r = await render(`<main data-sn-state="{ n: 0, seen: 0 }" data-sn-let="{ cells: grid('a') }"><i data-sn-text="cells.length + n"></i>
      <button id="n" data-sn-on-click="n++"></button><button id="h" data-sn-on-click="seen = ${Array.from({ length: 30 }, () => 'cells.length').join(' + ')}"></button></main>`, { helpers: { grid } });
    for (let i = 0; i < 12; i++) await click(r, '#n');
    await click(r, '#h');
    expect(warned(r)).toEqual([]);
  });

  test('with memo() the repeats cost nothing: no warning', async () => {
    const { calls, grid } = slow(0.1);
    const r = await render(page(), { helpers: { grid: memo(grid) } });
    expect(calls.length).toBe(1);
    expect(warned(r)).toEqual([]);
    expect(r.root.querySelector('i')!.textContent).toBe('3');
  });

  test('a production build has none of it; a dev build\'s early file reads the helper as written', () => {
    const html = `<!doctype html><html><head><script type="application/json" data-sn-resource="post">{"body":"a"}</script></head><body><sn-resource name="post" src="/api/post"></sn-resource>
      <main data-sn-let="{ a: fmt(post ? post.body : ''), b: crunch.parse(a) }"><i data-sn-text="a"></i><b data-sn-text="b + fmt('x')"></b></main></body></html>`;
    const helpers = { module: '/src/sinter.helpers.ts', names: ['fmt'], namespaces: { crunch: { module: '/src/crunch.ts', members: ['parse'] } } };
    const out = (dev: boolean) => compile(html, { file: '/p/index.html', root: '/p', dev, early: { module: null }, helpers, readFile: () => { throw new Error('none'); } });
    const prod = out(false), dev = out(true);
    expect(prod.module + JSON.stringify(prod.early ?? '')).not.toMatch(/\$hv|\/\*h/);
    expect(dev.module).toContain('$.$hv(fmt, "fmt", "`a` (`data-sn-let`, /p/index.html:');
    expect(dev.module).toContain('$.$hv(crunch$parse, "crunch.parse", "`b` (`data-sn-let`, /p/index.html:');
    // a call outside a let: the place of its expression
    expect(dev.module).toMatch(/\$\.\$hv\(fmt, "fmt", "\/p\/index\.html:\d+:\d+"\)\('x'\)/);
    expect(JSON.stringify(dev.early ?? '')).not.toContain('$hv');
  });
});
