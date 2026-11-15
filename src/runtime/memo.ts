// Cached lets (docs/spec.md, Derived names): what the page module (lets.ts) and the early file
// (early.ts) share, each in its own copy. A `data-sn-let` over a helper compiles to
// `$.$c($, id, names, ($) => …)`, and each helper call in it to `$.$h(k, f, [args])`.

/** one cached let in one scope instance: its value, the owner's values of the names it reads, each call's last arguments and result */
/** a cached let's value: `r` the flush round it was computed in, `q` the app's marks when it was last known current */
export interface Entry { v: unknown; n: unknown[]; m: Array<[unknown[] | null, unknown] | undefined>; r: number; q: number }

/**
 * The scope instance a let's value belongs to: from `s`, the nearest scope that holds one of the names its
 * code reads (a row's loop variable, a state scope, `$el`), else the root. A read from an inner row or with
 * `$el` finds the same instance as the row that declares the let.
 */
export function owner(s: any, names: string[]): any {
  let o = s;
  for (let p; !names.some((n) => Object.hasOwn(o, n)) && (p = Object.getPrototypeOf(o)) && p !== Object.prototype;) o = p;
  return o;
}

/** a primitive, as compared by `Object.is` */
const prim = (v: unknown) => v === null || (typeof v != 'object' && typeof v != 'function');

/**
 * The arguments as kept for the next call: primitives as they are, a plain object of primitives as a
 * copy (state may be changed in place, so the object itself proves nothing); null when one is anything
 * else, so the next call runs again.
 */
function keep(a: unknown[]): unknown[] | null {
  const out: unknown[] = [];
  for (const v of a) {
    if (prim(v)) { out.push(v); continue; }
    const p = Object.getPrototypeOf(v);
    if ((p !== Object.prototype && p !== null) || !Object.values(v as object).every(prim)) return null;
    out.push({ ...(v as object) });
  }
  return out;
}

const same = (k: unknown[], a: unknown[]) => k.length == a.length && a.every((v, i) => {
  const w = k[i];
  if (prim(v) || prim(w)) return Object.is(v, w);
  const x = Object.keys(v as object), y = w as Record<string, unknown>;
  return Object.getPrototypeOf(v) === Object.getPrototypeOf(w) && x.length == Object.keys(y).length && x.every((key) => Object.hasOwn(y, key) && Object.is((v as any)[key], y[key]));
});

/** call `k` of the let being computed (`e`): its last result when the arguments are equal primitives, else `f` called again */
export function call(e: Entry | null, k: number, f: (...a: unknown[]) => unknown, a: unknown[]): unknown {
  if (!e) return f(...a);
  const last = e.m[k];
  if (last?.[0] && same(last[0], a)) return last[1];
  const v = f(...a);
  e.m[k] = [keep(a), v];
  return v;
}
