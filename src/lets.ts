// Cached lets (docs/spec.md, Derived names): a `data-sn-let` entry, or a prop, that calls an app
// helper is computed once per scope instance and kept until its dependencies change (`ir.lt`, checked
// per flush round); then computed again, with each helper call returning its last result when its
// arguments are equal primitives (`memo.ts`). Between flushes, a let read after paths were marked (a
// handler marks its writes before it runs; store functions, listeners and nested handlers mark theirs)
// is computed again when one of them reaches its dependencies, and otherwise keeps its value (and its
// objects); the verdict holds until the next mark. A let that calls a helper of a module that reaches a lazy
// package waits for the module (`ir.lm`): `undefined` until it arrives, which marks `$lz.<index>`, and
// the let is computed again. A failed load takes the unhandled-error path, once. Loaded only by pages
// with such a let.
import type { App, Feature } from './runtime/app.js';
import { call, owner, type Entry } from './runtime/memo.js';
import { loadError } from './lazy.js';

/** thrown by `$z` while a lazy helper module is on its way: the let is `undefined` until then */
const WAIT = Symbol('wait');

const feature: Feature = {
  name: 'lets',
  install(app: App) {
    const ir = app.ir, lt = ir.lt ?? [], gen = new Int32Array(lt.length), names: string[][] = [];
    const caches = new WeakMap<object, Array<Entry | undefined>>();
    let round = 0, cur: Entry | null = null;
    // a let whose dependencies a round's changes reach is computed again when next read
    app.ext.lets = (hit, r) => { round = r; for (let j = 0; j < lt.length; j++) if (hit(lt[j]!.d)) gen[j] = r; };
    /** lazy helper modules: the module once it has arrived, 1 while it loads, 2 after it failed */
    const mods: unknown[] = [];
    const page = app.page as any;
    page.$c = (s: any, j: number, n: string, f: (s: any) => unknown) => {
      const ns = (names[j] ??= n ? n.split(' ') : []), o = owner(s, ns);
      let all = caches.get(o);
      if (!all) caches.set(o, (all = []));
      const e = all[j];
      // current: no flush since reached it, the same names, and nothing marked since, or nothing marked that reaches it
      if (e && e.r >= gen[j]! && ns.every((x, i) => o[x] === e.n[i]) && (e.q == app.marks || !app.pending(lt[j]!.d))) { e.q = app.marks; return e.v; }
      // in a handler whose marked writes reach it, the writes may come after this read: computed again at every read
      // until the handler returns (q -1), as an inlined let would be; otherwise current until the next mark
      const x: Entry = { v: undefined, n: ns.map((k) => o[k]), m: e?.m ?? [], r: round, q: app.handling && app.pending(lt[j]!.d) ? -1 : app.marks }, prev = cur;
      cur = x;
      try { x.v = f(o); } catch (err) { if (err !== WAIT) throw err; } finally { cur = prev; }
      all[j] = x;
      return x.v;
    };
    page.$h = (k: number, f: (...a: unknown[]) => unknown, a: unknown[]) => call(cur, k, f, a);
    page.$z = (i: number, name: string) => {
      const m = mods[i];
      if (m && typeof m == 'object') return (m as Record<string, unknown>)[name];
      if (m == null) {
        mods[i] = 1;
        app.busy++;
        Promise.resolve().then(() => app.fns[ir.lm![i]!]!(null)).then(
          (v) => { mods[i] = v ?? {}; app.mark('$lz.' + i); },
          async (e) => { mods[i] = 2; app.unhandled(await loadError(e, null), null); },
        ).finally(() => { app.busy--; });
      }
      throw WAIT;
    };
  },
};
export default feature;
