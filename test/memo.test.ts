// @vitest-environment node
// memo() (src/memo.ts): keyed one to one by its arguments, copies them, freezes and shares its results,
// bounded by size with the least recently used going first, and caches nothing for a call that throws.
import { describe, expect, test } from 'vitest';
import { memo } from '../src/memo.js';

/** a memoized function that records its calls, returning a new object each time */
const counted = <A extends unknown[]>(f: (...a: A) => unknown = (...a) => ({ a }), o?: { maxSize?: number }) => {
  const calls: unknown[][] = [];
  const m = memo((...a: A) => { calls.push(a); return f(...a); }, o);
  return { m, calls };
};

describe('keys: equal arguments only, one to one', () => {
  test('primitives that look alike stay apart: -0 and 0, NaN, undefined and null, numbers and strings', () => {
    const { m, calls } = counted();
    const args: unknown[][] = [[0], [-0], [NaN], [undefined], [null], ['0'], ['NaN'], ['u'], ['z'], [false], ['f'], [0n], [''], [], [undefined, undefined], ['a', 'b'], ['ab'], ['a', ''], ['', 'a']];
    for (const a of args) m(...a);
    expect(calls.length).toBe(args.length);
    for (const a of args) m(...a);
    expect(calls.length).toBe(args.length);
    // NaN equals NaN as a key
    expect(m(NaN)).toBe(m(NaN));
  });

  test('strings that could run into each other do not: lengths are part of the key', () => {
    const { m, calls } = counted();
    m('s1:a', 'b');
    m('s1', ':ab');
    m('s1:ab');
    m({ 'a1:b': 1 });
    m({ a: 1, b: 1 });
    expect(calls.length).toBe(5);
  });

  test('plain objects and arrays of primitives: by content, keys in order, holes, length, prototype', () => {
    const { m, calls } = counted();
    const a = m({ x: 1, y: [1] as unknown });
    expect(calls.length).toBe(1);
    // (a nested array calls through: only primitives inside)
    m({ x: 1, y: [1] as unknown });
    expect(calls.length).toBe(2);
    expect(m({ x: 1, y: 2 })).toBe(m({ x: 1, y: 2 }));
    expect(calls.length).toBe(3);
    // key order is part of the key (a function may read Object.keys)
    m({ y: 2, x: 1 });
    expect(calls.length).toBe(4);
    // a hole, an undefined element, a shorter array
    m([1, , 3]);
    m([1, undefined, 3]);
    m([1, 3]);
    m([, ]);
    m([]);
    expect(calls.length).toBe(9);
    // an object with a null prototype is not a plain object with the same entries
    m(Object.assign(Object.create(null), { x: 1, y: 2 }));
    expect(calls.length).toBe(10);
    expect(a).toBeDefined();
  });

  test('anything else calls through, uncached: nested objects, Maps, Dates, class instances, functions, symbols, accessors, extra array properties', () => {
    const { m, calls } = counted();
    const extra = Object.assign([1, 2], { tag: 'x' });
    const getter = Object.defineProperty({}, 'x', { get: () => 1, enumerable: true });
    const hidden = Object.defineProperty({}, 'x', { value: 1, enumerable: false });
    const keyed = { [Symbol('s')]: 1 };
    class P { n = 1; }
    const odd: unknown[] = [{ a: { b: 1 } }, [[1]], new Map(), new Date(0), new P(), () => 1, Symbol('s'), extra, getter, hidden, keyed, new Uint8Array(2)];
    for (const x of odd) { m(x); m(x); }
    expect(calls.length).toBe(odd.length * 2);
    // what it got is the caller's own object, as without memo()
    expect(calls[0]![0]).toBe(odd[0]);
  });
});

describe('copies and frozen results', () => {
  test('an object argument is copied before the call: the result never holds the caller\'s object', () => {
    const same = memo((o: { n: number }) => o);
    const mine = { n: 1 };
    const got = same(mine);
    expect(got).toEqual({ n: 1 });
    expect(got).not.toBe(mine);
    // the caller's object changes later; the kept result does not, and an equal argument gets it
    mine.n = 2;
    expect(same({ n: 1 }).n).toBe(1);
    expect(same(mine).n).toBe(2);
    const list = [1, 2];
    const l = memo((xs: number[]) => xs)(list);
    expect(l).not.toBe(list);
  });

  test('a result is deep-frozen and shared: equal arguments give the same object', () => {
    const parse = memo((s: string) => ({ words: s.split(' ').map((w) => ({ w })), meta: { n: s.length } }));
    const a = parse('a b');
    expect(parse('a b')).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.words)).toBe(true);
    expect(Object.isFrozen(a.words[0])).toBe(true);
    expect(Object.isFrozen(a.meta)).toBe(true);
    expect(() => { (a.words as Array<{ w: string }>).push({ w: 'c' }); }).toThrow(TypeError);
    // a cycle is fine
    const cyc = memo(() => { const o: Record<string, unknown> = { n: 1 }; o.self = o; return o; })();
    expect(Object.isFrozen(cyc)).toBe(true);
  });

  test('a result that holds anything but plain data is returned as it is, uncached and not frozen', () => {
    let calls = 0;
    const m = memo((k: string) => { calls++; return { k, at: new Date(0), m: new Map([[k, 1]]) }; });
    const a = m('x'), b = m('x');
    expect(calls).toBe(2);
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(false);
    const f = memo(() => () => 1);
    expect(f()).not.toBe(f());
  });

  test('primitive results are kept too', () => {
    let calls = 0;
    const m = memo((s: string) => { calls++; return s.length; });
    m('abc'); m('abc');
    expect(calls).toBe(1);
    const u = memo(() => { calls++; return undefined; });
    u(); u();
    expect(calls).toBe(2);
  });
});

describe('size, eviction, clear, errors', () => {
  test('bounded by an approximate size: the least recently used go first', () => {
    // each result about 2 × 1000 bytes: four fit in 9,000
    const { m, calls } = counted((s: string) => s.repeat(1000), { maxSize: 9000 });
    for (const k of ['a', 'b', 'c', 'd']) m(k);
    m('a');
    expect(calls.length).toBe(4);
    // 'e' evicts the least recently used, 'b' ('a' was just used)
    m('e');
    m('a');
    expect(calls.length).toBe(5);
    m('b');
    expect(calls.length).toBe(6);
  });

  test('an entry larger than the whole cache is not kept', () => {
    const { m, calls } = counted((s: string) => s.repeat(100), { maxSize: 100 });
    m('x'); m('x');
    expect(calls.length).toBe(2);
  });

  test('clear() forgets every result', () => {
    const { m, calls } = counted();
    m(1); m(2); m(1);
    expect(calls.length).toBe(2);
    m.clear();
    m(1);
    expect(calls.length).toBe(3);
  });

  test('a call that throws caches nothing: the next equal call runs again', () => {
    let n = 0;
    const m = memo((s: string) => { if (n++ === 0) throw new Error('first'); return s; });
    expect(() => m('a')).toThrow('first');
    expect(m('a')).toBe('a');
    expect(n).toBe(2);
  });

  test('`this` is passed on; a recursive memoized function', () => {
    const fib: (n: number) => number = memo((n: number) => (n < 2 ? n : fib(n - 1) + fib(n - 2)));
    expect(fib(80)).toBe(23416728348467685);
    const o = { k: 2, f: memo(function (this: { k: number }, x: number) { return x * this.k; }) };
    expect(o.f(3)).toBe(6);
  });
});
