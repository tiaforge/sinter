// @vitest-environment node
// memo() against calling the function directly (CONTRIBUTING.md, Fuzz tests): random argument lists (primitives
// that look alike, plain objects and arrays of them in other orders, with holes, a null prototype, and some that
// call through), each call compared by value with the direct call, the same object for equal arguments, the
// caller's objects never frozen nor kept, every kept result frozen, and the least recently used going first when
// the cache is small. `SN_MEMO_SEEDS` (default 200).
import { expect, test } from 'vitest';
import { memo } from '../src/memo.js';

const SEEDS = Number(process.env.SN_MEMO_SEEDS ?? 200);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** a value as one string, one to one (what the function computes, and how results are compared) */
function show(v: unknown, seen = new Set<object>()): string {
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : `n${v}`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return String(v);
  if (seen.has(v)) return '<cycle>';
  seen.add(v);
  if (v instanceof Map) return `Map(${[...v].map(([k, x]) => show(k, seen) + '=>' + show(x, seen)).join(',')})`;
  if (Array.isArray(v)) return `[${Array.from({ length: v.length }, (_, i) => (Object.hasOwn(v, i) ? show(v[i], seen) : '<hole>')).join(',')}]`;
  return `${Object.getPrototypeOf(v) === null ? 'null-proto' : ''}{${Object.keys(v).map((k) => `${JSON.stringify(k)}:${show((v as Record<string, unknown>)[k], seen)}`).join(',')}}`;
}

const PRIMS: unknown[] = [0, -0, 1, 1.5, NaN, Infinity, -Infinity, '', '0', '-0', 'NaN', 'a', 'ab', 's1:a', ':', 'u', 'z', 's', 'as', 'sb', 'n1;', true, false, null, undefined, 0n, 7n];

/** a random argument: mostly primitives and plain objects or arrays of them; now and then one that calls through */
function value(r: () => number): unknown {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const x = r();
  if (x < 0.45) return pick(PRIMS);
  if (x < 0.7) {
    const a: unknown[] = [];
    const n = Math.floor(r() * 4);
    for (let i = 0; i < n; i++) if (r() < 0.85) a[i] = pick(PRIMS);
    a.length = n;
    return a;
  }
  if (x < 0.92) {
    const keys = ['a', 'b', 'a1:b', '', 'length'].filter(() => r() < 0.5);
    if (r() < 0.5) keys.reverse();
    const o = r() < 0.15 ? Object.create(null) : {};
    for (const k of keys) o[k] = pick(PRIMS);
    return o;
  }
  // calls through: a nested object, a Map
  return r() < 0.5 ? { a: [pick(PRIMS)] } : new Map([[pick(PRIMS), pick(PRIMS)]]);
}
/** an equal argument list, made anew (equal contents, other objects) */
const again = (args: unknown[]): unknown[] => args.map((a) => {
  if (a instanceof Map) return new Map(a);
  if (Array.isArray(a)) { const b: unknown[] = []; for (let i = 0; i < a.length; i++) if (Object.hasOwn(a, i)) b[i] = a[i]; b.length = a.length; return b; }
  if (a && typeof a === 'object') return Object.assign(Object.create(Object.getPrototypeOf(a)), a);
  return a;
});
/** a look-alike of an argument list, which must not share its key: one detail changed, as a careless key would lose it */
function lookalike(args: unknown[], r: () => number): unknown[] {
  const out = again(args);
  const i = Math.floor(r() * (out.length + 1));
  const a = out[i];
  const swap = new Map<unknown, unknown>([[0, -0], [-0, 0], ['0', 0], [NaN, 'NaN'], ['', undefined], [undefined, null], [null, 'z'], [false, 'f'], [0n, 0], [1, '1']]);
  const k = out.findIndex((x, j) => typeof x === 'string' && typeof out[j + 1] === 'string' && x.length > 0);
  if (k >= 0 && r() < 0.3) {
    // one character across the boundary of two strings (`'as', 'b'` and `'a', 'sb'`)
    const x = out[k] as string;
    out[k] = x.slice(0, -1);
    out[k + 1] = x.slice(-1) + (out[k + 1] as string);
  } else if (i >= out.length) {
    // the strings split another way (`'s1:a', 'b'` and `'s1', ':ab'`), or one more argument
    if (out.length && typeof out[out.length - 1] === 'string') { const t = out.pop() as string; out.push(t.slice(0, 1), t.slice(1) + 'x'); } else out.push(undefined);
  } else if (Array.isArray(a)) {
    const j = Math.floor(r() * (a.length + 1));
    if (j >= a.length) a.length++;
    else if (!Object.hasOwn(a, j)) a[j] = undefined;
    else if (r() < 0.5) delete a[j];
    else a[j] = swap.has(a[j]) ? swap.get(a[j]) : -0;
  } else if (a && typeof a === 'object' && !(a instanceof Map)) {
    const e = Object.entries(a);
    if (r() < 0.4 && e.length > 1) out[i] = Object.assign(Object.create(Object.getPrototypeOf(a)), Object.fromEntries(e.reverse()));
    else if (r() < 0.5) out[i] = Object.assign(Object.getPrototypeOf(a) === null ? {} : Object.create(null), a);
    else out[i] = { ...a, ['a1:b']: ':' };
  } else out[i] = swap.has(a) ? swap.get(a) : typeof a === 'string' ? a + ':' : 'NaN';
  return out;
}

/** whether memo() keys an argument (what its docs say) */
const keyable = (a: unknown): boolean => {
  if (a === null || typeof a !== 'object') return typeof a !== 'symbol' && typeof a !== 'function';
  const p = Object.getPrototypeOf(a);
  if (Array.isArray(a)) return p === Array.prototype && Array.from({ length: a.length }, (_, i) => i).every((i) => !Object.hasOwn(a, i) || (a[i] === null || typeof a[i] !== 'object'));
  return (p === Object.prototype || p === null) && Object.values(a).every((x) => x === null || typeof x !== 'object');
};

/** the functions: a result that describes the arguments, one that holds them, a primitive */
const FNS: Array<(...a: unknown[]) => unknown> = [
  (...a) => ({ shown: a.map((x) => show(x)), n: a.length, parts: a.map((x) => ({ s: show(x) })) }),
  (...a) => ({ args: a }),
  (...a) => a.map((x) => show(x)).join('|'),
];

test('memo() gives what the function gives, the same object for equal arguments, and never keeps or freezes the caller\'s objects', () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= SEEDS && failures.length < 5; seed++) {
    const r = rng(seed * 2654435761);
    const fn = FNS[seed % FNS.length]!;
    const m = memo(fn);
    const base = Array.from({ length: 3 }, () => Array.from({ length: Math.floor(r() * 4) }, () => value(r)));
    const pool = [...base, ...base.map((b) => lookalike(b, r)), ...base.map((b) => lookalike(b, r))];
    const last = new Map<string, unknown>();
    for (let step = 0; step < 40; step++) {
      const args = again(pool[Math.floor(r() * pool.length)]!);
      const key = args.map((a) => show(a)).join('|') + `#${args.length}`;
      const want = show(fn(...again(args)));
      let got: unknown;
      try { got = m(...args); } catch (e) { failures.push(`seed ${seed} step ${step}: threw ${(e as Error).message}`); break; }
      const at = `seed ${seed} step ${step} ${key}`;
      if (show(got) !== want) failures.push(`${at}: ${show(got)} where the function gives ${want}`);
      for (const a of args) if (a && typeof a === 'object' && Object.isFrozen(a)) failures.push(`${at}: the caller's argument was frozen`);
      if (args.every(keyable)) {
        if (got && typeof got === 'object') {
          if (!Object.isFrozen(got)) failures.push(`${at}: a kept result is not frozen`);
          if (last.has(key) && last.get(key) !== got) failures.push(`${at}: another object for equal arguments`);
          // the result holds none of the caller's objects
          const held = (x: unknown, seen = new Set<unknown>()): boolean => x !== null && typeof x === 'object' && !seen.has(x) && (seen.add(x), args.includes(x) || Object.values(x).some((y) => held(y, seen)));
          if (held(got)) failures.push(`${at}: the result holds the caller's object`);
        }
        last.set(key, got);
      }
      // the caller changes its object afterwards: the next equal call is not affected
      for (const a of args) if (Array.isArray(a) && a.length && !Object.isFrozen(a)) a[0] = 'changed';
    }
  }
  expect(failures).toEqual([]);
});

test('a small cache: an old key is computed again, a key just used is not', () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= SEEDS && failures.length < 5; seed++) {
    const r = rng(seed * 40503);
    const size = 200 + Math.floor(r() * 800);
    let calls = 0;
    // each result about 2 × size bytes, with a few dozen more: three fit in 8 × size
    const m = memo((k: string) => { calls++; return k.repeat(size); }, { maxSize: 8 * size });
    const keys = Array.from({ length: 12 }, (_, i) => String.fromCharCode(97 + i));
    m(keys[0]!);
    // the first key used again between new ones stays; untouched for more than the cache holds, it goes
    for (let i = 1; i < keys.length; i++) {
      m(keys[i]!);
      if (i < 6) { const before = calls; m(keys[0]!); if (calls !== before) failures.push(`seed ${seed}: '${keys[0]}', just used, was computed again after '${keys[i]}'`); }
    }
    const before = calls;
    m(keys[1]!);
    if (calls === before) failures.push(`seed ${seed}: '${keys[1]}' was kept although ${keys.length - 2} keys came after it, in a cache for three`);
  }
  expect(failures).toEqual([]);
});
