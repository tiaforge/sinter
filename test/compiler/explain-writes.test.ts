// SN548 (`sinter({ explainWrites: true })`): each alias whose value the compiler cannot follow, where it was made, what
// it holds and the handlers whose writes it makes everything. It reports; it changes nothing that is marked.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { strictPromotes } from '../../src/compiler/diagnostics.js';

const helpers = { module: '/src/sinter.helpers.ts', names: ['pick'], namespaces: {} };
const compile = (html: string, explainWrites?: boolean) => compileParts(html, { file: '/p/index.html', root: '/p', dev: false, helpers, readFile: () => { throw new Error('none'); }, ...(explainWrites ? { explainWrites } : {}) });
const sn548 = (html: string) => compile(html, true).diagnostics.filter((d) => d.code === 'SN548');
const writes = (out: ReturnType<typeof compile>) => [...out.ir.roots, ...out.ir.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.w).map((b) => b.w));

const UNTRACEABLE = `<main data-sn-state="{ ys: [{ n: 1 }], sel: null, k: 0 }"><b data-sn-text="ys[0].n + (sel ? sel.n : 0) + k"></b>
  <button data-sn-on-click="sel = ys.reduce((a, y) => y, null)"></button>
  <button data-sn-on-click="sel.n = 5"></button>
  <button data-sn-on-click="ys[0].n = 6"></button>
  <button data-sn-on-click="k = k + 1"></button></main>`;

describe('SN548', () => {
  test('names the alias once, where it was made, with what it holds and the handlers it makes everything', () => {
    const ds = sn548(UNTRACEABLE);
    expect(ds).toHaveLength(1);
    const d = ds[0]!;
    expect(d).toMatchObject({ severity: 'warning', file: '/p/index.html', line: 2 });
    expect(d.message).toContain('`sel` may hold any of the page\'s objects (`ys.reduce((a, y) => y, null)` is the result of `reduce()`)');
    // the write inside the alias (the one inside the list reaches what reads the alias, not everything)
    expect(d.message).toContain('so the writes of a handler cannot be followed and re-render everything that reads state: `data-sn-on-click` (index.html:3).');
    expect(d.message).toContain('It was made by `sel = ys.reduce((a, y) => y, null)`');
    expect(d.hint).toContain('structuredClone');
  });

  test('changes no write list, and is off by default', () => {
    expect(writes(compile(UNTRACEABLE, true))).toEqual(writes(compile(UNTRACEABLE)));
    expect(compile(UNTRACEABLE).diagnostics.filter((d) => d.code === 'SN548')).toEqual([]);
  });

  test('a page whose aliases the compiler follows has none', () => {
    expect(sn548(`<main data-sn-state="{ ys: [{ n: 1 }], sel: null }"><b data-sn-text="ys[0].n + (sel ? sel.n : 0)"></b>
      <button data-sn-on-click="sel = ys[0]"></button><button data-sn-on-click="sel.n = 5"></button><button data-sn-on-click="sel = pick(ys)"></button></main>`)).toEqual([]);
  });

  test('through a `data-sn-let`, what the let\'s value is; an event\'s detail, why it is not followed', () => {
    const ds = sn548(`<main data-sn-state="{ ys: [{ n: 1 }], sel: null, box: null }" data-sn-let="{ last: ys.reduce((a, y) => y, null) }" data-sn-on-pick="box = $event.detail"><b data-sn-text="ys[0].n + (sel ? sel.n : 0)"></b>
      <button data-sn-on-click="sel = last"></button><button data-sn-on-click="sel.n = 6"></button><button data-sn-on-click="box.n = 7"></button></main>`);
    expect(ds.map((d) => d.message.split(' (')[0])).toEqual(expect.arrayContaining(['`sel` may hold any of the page\'s objects', '`box` may hold any of the page\'s objects']));
    expect(ds.find((d) => d.message.startsWith('`sel`'))!.message).toContain('`ys.reduce((a, y) => y, null)` is the result of `reduce()`');
    expect(ds.find((d) => d.message.startsWith('`box`'))!.message).toContain('`$event` of `pick` may be any object: the build did not read the page\'s modules');
  });

  test('a state field\'s initial value: at its `data-sn-state`', () => {
    const [d, ...more] = sn548(`<sn-resource name="rs" src="/r"></sn-resource><main data-sn-state="{ sel: rs.reduce((a, y) => y, null) }"><b data-sn-text="sel.n"></b>
      <button data-sn-on-click="sel.n = 5"></button></main>`);
    expect(more).toEqual([]);
    expect(d!.line).toBe(1);
    expect(d!.message).toContain('It was made by `{ sel: rs.reduce((a, y) => y, null) }`');
  });

  test('stays a warning in strict mode', () => {
    expect(strictPromotes('SN548')).toBe(false);
  });
});
