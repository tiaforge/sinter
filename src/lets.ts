// Lets that wait for a lazy helper module (docs/spec.md, Derived names): a `data-sn-let` entry, or a prop, that
// calls a helper of a module reaching a package of `sinter({ lazy })` compiles to `$.$w(() => …)`, each such
// helper read as `$.$z(index, name)`. Until the module has arrived the value is `undefined`; its arrival marks
// `$lz.<index>`, a dependency of every let that waits for it, which renders again. A failed load takes the
// unhandled-error path, once. Lets are otherwise their expression, inlined at every read.
//
// The let cache (docs/spec.md, Derived names): a let that calls something compiles, where a value reads it, to
// `$.$l($, n, ($) => …)`, and is computed once until state may have changed. `IR.lc[n]` lists the names the let
// reads off its scope (loop variables, state, props, `$r`, `$url`, …). The value is kept on the nearest scope that
// has one of those names as its own (else the page's): no scope nearer to the reader has any of them, so each
// name resolves from that scope as it does from the reader's, and every reader below it shares the value. A row's
// lets go with its scope. A value holds while `App.ep` is the one it was computed at (app.ts: every mark, the end
// of every handler, a kept row taking another item); while a handler runs (`App.hd`) the cache is neither read nor
// filled, since its writes are marked only after it. A let that throws keeps nothing: each read throws again.
// Loaded only by pages with a waiting or a cached let.
import type { App, Feature } from './runtime/app.js';
import { loadError } from './lazy.js';

/** thrown by `$z` while a lazy helper module is on its way: the let is `undefined` until then */
const WAIT = Symbol('wait');

const feature: Feature = {
  name: 'lets',
  install(app: App) {
    const ir = app.ir;
    /** lazy helper modules: the module once it has arrived, 1 while it loads, 2 after it failed */
    const mods: unknown[] = [];
    const page = app.page as any;
    const lc = ir.lc;
    if (lc) {
      const kept = new WeakMap<object, unknown[]>(), own = Object.prototype.hasOwnProperty;
      page.$l = (s: any, n: number, f: (s: any) => unknown) => {
        if (app.hd) return f(s);
        const names = lc[n]!;
        let o = s;
        find: for (; o && o != page; o = Object.getPrototypeOf(o)) for (let j = 0; j < names.length; j++) if (own.call(o, names[j]!)) break find;
        // (a scope that is not the page's: evaluated as written)
        if (!o) return f(s);
        let c = kept.get(o);
        if (!c) kept.set(o, (c = []));
        if (c[2 * n] === app.ep) return c[2 * n + 1];
        // the clock as it was before: a change while the let is computed leaves the value stale at once
        const ep = app.ep, v = f(o);
        c[2 * n] = ep;
        return (c[2 * n + 1] = v);
      };
    }
    page.$w = (f: () => unknown) => {
      try { return f(); } catch (err) { if (err !== WAIT) throw err; return undefined; }
    };
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
