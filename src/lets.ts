// Lets that wait for a lazy helper module (docs/spec.md, Derived names): a `data-sn-let` entry, or a prop, that
// calls a helper of a module reaching a package of `sinter({ lazy })` compiles to `$.$w(() => …)`, each such
// helper read as `$.$z(index, name)`. Until the module has arrived the value is `undefined`; its arrival marks
// `$lz.<index>`, a dependency of every let that waits for it, which renders again. A failed load takes the
// unhandled-error path, once. Lets are otherwise their expression, inlined at every read. Loaded only by
// pages with such a let.
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
