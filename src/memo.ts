// memo() (docs/configuration.md, Memoized helpers): an app's expensive pure function, kept by its arguments. Lets and
// props are their expression, evaluated at every read; a parse a page reads in many places is the app's to
// memoize, `export const parse = memo(parseDocument)` in the helpers module. It runs in the browser (the page
// module, the early file) and in Node (helper calls folded at build time), and passes the build's fold check:
// its state is in the closure of each memoized function, none at the module's top level.
//
// - Arguments are keyed one to one when each is a primitive, or a plain object or array of primitives (its
//   entries in order, its length and holes, a null prototype apart; `-0`, `NaN`, `undefined` and the strings
//   all distinct). Any other argument (a nested object, a Map, a class instance, a function) calls through,
//   uncached.
// - An object argument is copied before the call, so a result never holds the caller's object (which may be
//   the page's state, changed in place later).
// - A result of plain data (primitives, plain objects and arrays, at any depth) is deep-frozen, in production
//   too, and the same object is returned for equal arguments: change a copy. A result that holds anything
//   else (a Map, a Set, a Date, a typed array, a class instance, a function) is returned as it is, uncached.
// - The cache is bounded by an approximate size (strings at 2 bytes a character, a constant per value and per
//   entry), `maxSize` bytes, 4 MiB by default; the least recently used entries go first. The last result is
//   always kept, even one larger than `maxSize` (then alone): a page that reads a huge parse at every node must
//   not parse it again at every read.
// - A call that throws caches nothing. `this` is passed on and is not part of the key.
//
// The rule: a memoized function takes everything its result depends on as arguments (the locale, an option),
// and reads nothing else that changes.

export interface MemoOptions {
  /** the cache's approximate size, in bytes (default 4 MiB); an entry larger than it is kept alone, until the next */
  maxSize?: number;
}

export type Memoized<F extends (...args: any[]) => any> = F & {
  /** forgets every kept result */
  clear(): void;
};

/** the function a memoized one calls (the fold check of `render()`'s helpers reads its source) */
export const MEMO_OF = Symbol.for('sinter.memo');

const prim = (v: unknown): string | null => {
  switch (typeof v) {
    case 'undefined': return 'u';
    case 'boolean': return v ? 't' : 'f';
    case 'number': return `n${Object.is(v, -0) ? '-0' : String(v)};`;
    case 'bigint': return `b${String(v)};`;
    case 'string': return `s${v.length}:${v}`;
    case 'object': return v === null ? 'z' : null;
    default: return null;
  }
};

/** an own enumerable data property's value, or a marker that there is none */
const NONE = {};
const own = (o: object, k: PropertyKey): unknown => {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d && 'value' in d && d.enumerable ? d.value : NONE;
};

/** an argument's key, one to one, or null for one that calls through uncached */
function keyOf(v: unknown): string | null {
  const p = prim(v);
  if (p !== null || v === null || typeof v !== 'object') return p;
  const proto = Object.getPrototypeOf(v);
  const keys = Reflect.ownKeys(v);
  if (Array.isArray(v)) {
    if (proto !== Array.prototype) return null;
    // indexes and `length` only: an array with other properties (holes or not) calls through
    for (const k of keys) if (k !== 'length' && (typeof k !== 'string' || String(+k >>> 0) !== k || +k >= v.length)) return null;
    let out = `[${v.length}:`;
    for (let i = 0; i < v.length; i++) {
      if (!Object.hasOwn(v, i)) { out += 'h'; continue; }
      const x = own(v, i), k = x === NONE ? null : prim(x);
      if (k === null) return null;
      out += k;
    }
    return out + ']';
  }
  if (proto !== Object.prototype && proto !== null) return null;
  let out = proto === null ? '{0' : '{';
  for (const k of keys) {
    if (typeof k !== 'string') return null;
    const x = own(v, k), xk = x === NONE ? null : prim(x);
    if (xk === null) return null;
    out += `${k.length}:${k}${xk}`;
  }
  return out + '}';
}

/** a copy of a keyed argument (it holds only primitives); own keys defined one by one, `__proto__` included */
const copy = (v: unknown): unknown => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice();
  const o = Object.create(Object.getPrototypeOf(v));
  for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: (v as Record<string, unknown>)[k], enumerable: true, writable: true, configurable: true });
  return o;
};

/**
 * Freezes a result of plain data, at every depth (without recursion: a deep tree does not overflow the stack), and
 * returns its approximate size; -1 (nothing frozen) for one that holds anything else. An array's elements are read
 * by index (a million-element array is not listed key by key)
 */
function freeze(v: unknown): number {
  const objects: object[] = [], seen = new Set<object>(), todo: unknown[] = [v];
  let size = 0;
  while (todo.length) {
    const x = todo.pop();
    if (typeof x === 'string') { size += 8 + 2 * x.length; continue; }
    if (typeof x === 'function' || typeof x === 'symbol') return -1;
    if (x === null || typeof x !== 'object') { size += 8; continue; }
    if (seen.has(x)) continue;
    seen.add(x);
    const proto = Object.getPrototypeOf(x);
    size += 16;
    if (Array.isArray(x)) {
      if (proto !== Array.prototype) return -1;
      for (let i = 0; i < x.length; i++) if (i in x) todo.push(x[i]);
    } else {
      if (proto !== Object.prototype && proto !== null) return -1;
      for (const k of Reflect.ownKeys(x)) {
        if (typeof k === 'symbol') return -1;
        const d = Object.getOwnPropertyDescriptor(x, k)!;
        if (!('value' in d)) return -1;
        size += 8 + 2 * k.length;
        todo.push(d.value);
      }
    }
    objects.push(x);
  }
  for (const o of objects) Object.freeze(o);
  return size;
}

/** `fn`, keeping its results by its arguments (see above) */
export function memo<F extends (...args: any[]) => any>(fn: F, options: MemoOptions = {}): Memoized<F> {
  const max = options.maxSize ?? 4 * 1024 * 1024;
  // by key, in order of use (least recent first): the result and its size
  const cache = new Map<string, { v: unknown; size: number }>();
  const state = { total: 0 };
  const m = function (this: unknown, ...args: unknown[]) {
    let key = `${args.length}|`;
    for (const a of args) {
      const k = keyOf(a);
      if (k === null) return fn.apply(this, args);
      key += k;
    }
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.v;
    }
    const v = fn.apply(this, args.map(copy));
    const size = freeze(v);
    if (size < 0) return v;
    const entry = { v, size: size + 2 * key.length + 64 };
    cache.set(key, entry);
    state.total += entry.size;
    // the least recently used go first; the result just computed stays, alone if it is larger than the cache
    for (const [k, e] of cache) {
      if (state.total <= max || k === key) break;
      cache.delete(k);
      state.total -= e.size;
    }
    return v;
  } as Memoized<F>;
  m.clear = () => { cache.clear(); state.total = 0; };
  Object.defineProperty(m, MEMO_OF, { value: fn });
  Object.defineProperty(m, 'name', { value: fn.name, configurable: true });
  Object.defineProperty(m, 'length', { value: fn.length, configurable: true });
  return m;
}
