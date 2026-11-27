// @vitest-environment jsdom
// A helper changes none of its arguments, in a handler as in a binding (docs/spec.md, Method classes; changed
// 2026-11-27). A helper call in a handler marks nothing of its arguments; the handler changes state in place with the
// method itself, which the compiler sees, or assigns a helper's result. Enforced in layers: the build reports a call
// that gives page data to a parameter the helper's module writes into (SN214, helper-writes.ts), and a dev build
// reports a helper that changed an argument when a handler called it (warning 37, dev.ts).
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

type R = Awaited<ReturnType<typeof render>>;
const text = (r: R, sel: string) => [...r.root.querySelectorAll(sel)].map((x) => x.textContent).join(',');
const click = async (r: R, sel: string) => { r.root.querySelector<HTMLElement>(sel)!.click(); await r.settle(); };
const warned = (r: R, code: number) => r.warnings().filter((w) => w.code == code).map((w) => w.message);
const helpers = { module: '/src/sinter.helpers.ts', names: ['sorted', 'pick', 'count'], namespaces: {} };
/** the paths each handler marks, in document order */
const writes = (html: string) => {
  const out = compileParts(html, { file: '/p/index.html', root: '/p', dev: false, helpers, readFile: () => { throw new Error('none'); } });
  return [...out.ir.roots, ...out.ir.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'on').map((b) => ((b.w as string[] | undefined) ?? []).slice().sort()));
};

describe('a helper call in a handler writes nothing of its arguments', () => {
  test('a call whose result is assigned marks what is assigned; one that is not marks nothing', () => {
    expect(writes(`<main data-sn-state="{ tasks: [3, 1], sel: null }"><button data-sn-on-click="tasks = sorted(tasks)"></button>
      <button data-sn-on-click="sel = pick(tasks)"></button><button data-sn-on-click="count(tasks)"></button><p data-sn-text="tasks.join() + sel"></p></main>`))
      .toEqual([['$s0.tasks'], ['$s0.sel'], []]);
  });

  test('the in-place forms in the handler mark what they change, and the page shows it', async () => {
    const r = await render(`<main data-sn-state="{ tasks: [3, 1, 2], ys: [{ n: 1 }, { n: 2 }] }">
      <p data-sn-text="tasks.join()"></p><ul><template data-sn-for="y in ys"><li data-sn-text="y.n"></li></template></ul>
      <button id="sort" data-sn-on-click="tasks.sort((a, b) => a - b)"></button><button id="bump" data-sn-on-click="ys[0].n++"></button>
      <button id="new" data-sn-on-click="tasks = sorted(tasks).reverse()"></button></main>`, { helpers: { sorted: (xs: number[]) => [...xs].sort((a, b) => a - b) } });
    await click(r, '#sort');
    expect(text(r, 'p')).toBe('1,2,3');
    await click(r, '#bump');
    expect(text(r, 'li')).toBe('2,2');
    await click(r, '#new');
    expect(text(r, 'p')).toBe('3,2,1');
    expect(r.warnings().filter((w) => w.code == 36 || w.code == 37 || w.code == 15)).toEqual([]);
  });
});

describe('SN214: a call that gives page data to a parameter the helper writes into', () => {
  const page = (call: string, where = 'handler') => (where === 'handler'
    ? `<main data-sn-state="{ tasks: [3, 1], o: { n: 1 } }"><p data-sn-text="tasks.join() + o.n"></p><button data-sn-on-click="${call}"></button></main>`
    : `<main data-sn-state="{ tasks: [3, 1], o: { n: 1 } }"><p data-sn-text="${call}"></p></main>`);
  const build = (html: string, h: Record<string, unknown>) => render(html, { helpers: h }).then(() => 'built', (e: Error) => e.message);
  const sortInPlace = (xs: number[]) => { xs.sort(); };
  const bump = (o: { n: number }) => { const at = o; void at; o.n++; return o.n; };

  test('in a handler: the call, the argument, where the helper writes it, and the hint', async () => {
    const m = await build(page('sortInPlace(tasks)'), { sortInPlace });
    expect(m).toMatch(/SN214 helper-changes-argument: `sortInPlace\(\)` changes its argument `tasks` \(`xs\.sort\(\)` at <sortInPlace>:\d+:\d+\), and a helper changes none of its arguments/);
    expect(m).toMatch(/change it in the handler with the method itself, which the compiler sees \(`tasks\.sort\(cmp\)`, `ys\[0\]\.n\+\+`\), or make `sortInPlace\(\)` return a new value and assign it \(`tasks = sortInPlace\(…\)`\)/);
  });
  test('in a binding too, and through a member, a row\'s item and a namespace member', async () => {
    expect(await build(page('bump(o)', 'binding'), { bump })).toMatch(/`bump\(\)` changes its argument `o` \(`o\.n\+\+`/);
    expect(await build(page('ns.bump(o)'), { ns: { bump } })).toMatch(/`ns\.bump\(\)` changes its argument `o`/);
    expect(await build(`<main data-sn-state="{ ys: [{ n: 1 }] }"><ul><template data-sn-for="y in ys"><li data-sn-on-click="bump(y)" data-sn-text="y.n"></li></template></ul></main>`, { bump }))
      .toMatch(/`bump\(\)` changes its argument `y`/);
  });
  test('not for an element, an event, a literal or a copy: a helper may scroll or focus what it is given', async () => {
    const scrollTop = (el: HTMLElement) => { el.scrollTop = 0; };
    const stop = (e: Event & { handled?: boolean }) => { e.handled = true; };
    const fill = (xs: number[]) => xs.fill(0);
    expect(await build(page("scrollTop($el); stop($event); fill([1, 2]); fill([...tasks]); fill(tasks.slice())"), { scrollTop, stop, fill })).toBe('built');
  });
  test('not for a helper that writes only into its own copy, or a parameter it reassigned', async () => {
    const sorted = (xs: number[]) => { const c = [...xs]; c.sort(); return c; };
    const again = (xs: number[]) => { xs = [...xs]; xs.push(1); return xs; };
    expect(await build(page('tasks = sorted(tasks); tasks = again(tasks)'), { sorted, again })).toBe('built');
  });
});

describe('dev warning 37: a helper called in a handler changed an argument', () => {
  // what the build's check cannot see: the write is in a function the helper is handed, not in its own source
  const touch = (o: { n: number }) => { o.n += 100; };
  const bump = (o: { n: number }) => touch(o);
  const touchAll = (xs: Array<{ n: number }>) => { xs[1]!.n = 9; xs.push({ n: 0 }); };
  const bumpAll = (xs: Array<{ n: number }>) => touchAll(xs);

  test('names the helper and each path it changed, once, with the hint; no warning 36 or 15 for the same change', async () => {
    const r = await render(`<main data-sn-state="{ ys: [{ n: 1 }, { n: 2 }], k: 0 }"><ul><template data-sn-for="y in ys"><li data-sn-text="y.n"></li></template></ul>
      <button id="a" data-sn-on-click="bump(ys[0])"></button><button id="b" data-sn-on-click="k = k + 1; bumpAll(ys)"></button></main>`, { helpers: { bump, bumpAll }, strict: false });
    await click(r, '#a');
    expect(warned(r, 37)).toEqual([expect.stringMatching(/^sinter: helper `bump` changed `ys\[0\]\.n`, which a helper may not do: .* change the state with the method itself \(`tasks\.sort\(cmp\)`, `ys\[0\]\.n\+\+`\), or return a new value from the helper and assign it/)]);
    await click(r, '#b');
    expect(warned(r, 37)[1]).toMatch(/^sinter: helper `bumpAll` changed `ys\[1\]\.n`, `ys\[2\]`, which a helper may not do/);
    expect([...warned(r, 36), ...warned(r, 15)]).toEqual([]);
  });

  test('a pure helper, and a helper given an element or a frozen resource item, are not reported', async () => {
    const r = await render(`<main data-sn-state="{ ys: [{ n: 1 }], sel: null }"><p data-sn-text="sel ? sel.n : '-'"></p>
      <button id="a" data-sn-on-click="sel = pick(ys, 0); focusIt($el)"></button></main>`, { helpers: { pick: (xs: unknown[], i: number) => xs[i], focusIt: (el: HTMLElement) => { el.dataset.f = '1'; } }, strict: false });
    await click(r, '#a');
    expect(warned(r, 37)).toEqual([]);
  });

  test('a production build calls the helper directly: no check, nothing added', () => {
    const html = '<main data-sn-state="{ ys: [] }"><button data-sn-on-click="pick(ys)"></button></main>';
    const code = (dev: boolean) => { const out = compileParts(html, { file: '/p/index.html', root: '/p', dev, helpers, readFile: () => { throw new Error('none'); } }); return out.fns.join('\n'); };
    expect(code(true)).toContain('$.$hc(pick, "pick", ["ys"])');
    expect(code(false)).not.toContain('$hc');
  });
});
