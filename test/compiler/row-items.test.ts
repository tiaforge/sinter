// A row's item as the first pass's worklist hands it to the row (`frozenData`, docs/proposals/redesign-notes/floor.md):
// frozen at every depth, sharing what is frozen already rather than copying it again at every level of a tree, and a
// copy where sharing could be seen (a helper's result, which a helper call takes by reference; an array with holes;
// an object reached twice).
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';
import { frozenData, plainData } from '../../src/compiler/compile.js';

const frozenEverywhere = (v: unknown): boolean => !v || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(frozenEverywhere));

describe('frozenData', () => {
  test('a copy frozen at every depth, equal to structuredClone\'s', () => {
    const v = { a: [1, { b: 'x', c: null, d: undefined }], e: -0, f: { g: [[]] } };
    const out = frozenData(v);
    expect(out).not.toBe(v);
    expect(out).toStrictEqual(structuredClone(v));
    expect(Object.is((out as { e: number }).e, -0)).toBe(true);
    expect(frozenEverywhere(out)).toBe(true);
    expect(Object.isFrozen(v)).toBe(false);
  });

  test('what it froze is shared, whole or as a part of something new', () => {
    const once = frozenData({ children: [{ type: 'text', value: 'a' }, { type: 'text', value: 'b' }] }) as { children: object[] };
    expect(frozenData(once)).toBe(once);
    expect(frozenData(once.children[1])).toBe(once.children[1]);
    const props = frozenData({ node: once.children[0], tight: true }) as { node: object };
    expect(props.node).toBe(once.children[0]);
    expect(frozenEverywhere(props)).toBe(true);
  });

  test('a helper\'s result is copied, as is everything new around it', () => {
    const result = frozenData({ type: 'root', children: [] }) as object;
    const fresh = (x: object) => x === result;
    const a = frozenData(result, fresh);
    expect(a).not.toBe(result);
    expect(a).toStrictEqual(result);
    const b = frozenData({ doc: result }, fresh) as { doc: object };
    expect(b.doc).not.toBe(result);
    expect(b.doc).toStrictEqual(result);
  });

  test('holes, keys besides the indexes and an object reached twice: copied as structuredClone copies them', () => {
    const holes = [1, , 3];
    expect(frozenData(holes)).toStrictEqual(structuredClone(holes));
    expect(1 in (frozenData(holes) as unknown[])).toBe(false);
    const extra = Object.assign([1, 2], { index: 4 });
    expect((frozenData(extra) as { index?: number }).index).toBe(4);
    const shared = { x: 1 };
    const twice = frozenData({ a: shared, b: shared }) as { a: object; b: object };
    expect(twice.a).toBe(twice.b);
    expect(frozenEverywhere(twice)).toBe(true);
  });
});

describe('plainData with the heights of frozen data', () => {
  const deep = (n: number, leaf: unknown = 'x'): unknown => { let t = leaf; for (let i = 0; i < n; i++) t = { a: t }; return t; };
  test('the same answers as without, a part measured before included, at the bound too', () => {
    const heights = new Map<object, number>();
    const tree = frozenData(deep(1000)) as object;
    expect(plainData(tree, heights)).toBe(true);
    expect(heights.get(tree)).toBe(999);
    // the part measured is 999 deep: under 24 more levels it is within the bound, under 26 past it
    for (const n of [24, 25, 26, 40]) {
      const v = deep(n, tree);
      expect(plainData(v, heights)).toBe(plainData(v));
    }
    expect(plainData(deep(24, tree), heights)).toBe(true);
    expect(plainData(deep(26, tree), heights)).toBe(false);
  });

  test('what is not plain data, and a cycle, are as without', () => {
    const heights = new Map<object, number>();
    const cyc: Record<string, unknown> = { n: 1 };
    cyc.self = cyc;
    for (const v of [{ d: new Date(0) }, [() => 1], cyc, { m: new Map() }, [Symbol('s')]]) expect(plainData(v, heights)).toBe(plainData(v));
  });
});

const options = (extra: Partial<CompileOptions> = {}): CompileOptions => ({
  file: '/p/index.html', root: '/p', dev: false, prerender: true,
  helpers: { module: '/h.js', names: [], namespaces: {} },
  readFile: () => { throw new Error('missing'); },
  ...extra,
});
const bodyOf = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)![1]!;

describe('row items in the worklist', () => {
  test('a row cannot change its item, or the item of the row above, for the rows after it', () => {
    const out = compile('<!doctype html><html><head></head><body><div data-sn-state="{ t: [{ kids: [{ n: 1 }] }] }"><template data-sn-for="a in t"><template data-sn-for="b in a.kids"><i data-sn-text="(a.kids.push(b), b.n)"></i><b data-sn-text="a.kids.length"></b></template></template></div></body></html>', options());
    // (the push throws on the frozen item: that binding is the second pass's, which compiles it over a copy of its own)
    expect(bodyOf(out.html)).toBe('<div><i>1</i><b>1</b></div>');
  });

  test('nested rows over one constant tree read their parts as written', () => {
    const tree = "{ children: [{ v: 'a', children: [{ v: 'b', children: [] }] }, { v: 'c', children: [] }] }";
    const out = compile(`<!doctype html><html><head></head><body><div data-sn-state="{ t: ${tree} }"><template data-sn-for="x in t.children"><p data-sn-text="x.v"></p><template data-sn-for="y in x.children"><q data-sn-text="x.v + y.v"></q></template></template></div></body></html>`, options());
    expect(bodyOf(out.html)).toBe('<div><p>a</p><q>ab</q><p>c</p></div>');
  });
});
