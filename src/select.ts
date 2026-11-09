// The selection index: a value binding in a row that compares a row side with an outer side
// (`{active: row.id === selectedId}`). When only the outer side changes, the binding is
// re-evaluated on the rows the comparison held for and the rows whose row side equals the new
// outer value; the others keep their value. Loaded by pages the compiler found such a binding on.
import type { Binding, TemplateDef } from './ir.js';
import type { App, Feature, Inner } from './runtime/app.js';

const selOf = new WeakMap<TemplateDef, Binding[]>();
/** the selection bindings of the template's own nodes */
const sels = (t: TemplateDef): Binding[] => selOf.get(t) ?? (selOf.set(t, t.nodes.flatMap((nd) => nd.b.filter((b) => b.s))), selOf.get(t)!);

const feature: Feature = {
  name: 'select',
  install(app: App) {
    app.ext.select = ({ hit, isSimple, walkSimple, process }: Inner) => {
      const fns = app.fns;
      /**
       * A selection binding whose outer side may have changed. The index (rows by row-side value,
       * and the rows the comparison holds for) is built from the rows on first use and kept on the
       * list binding (`sx`) while no row is rendered.
       */
      function select(rb: any, b: Binding) {
        const s = b.s!, f = s.x ? 0 : 1, t = rb.t as TemplateDef, meta = isSimple(t), j = meta ? meta.vals.findIndex((y) => y[1] == b) : -1;
        if (!hit(s.d, rb.s)) return;
        // the binding's current value in a row (undefined when its element is missing), and its re-evaluation
        const cur = (x: any) => (meta ? x.v![j] : x.rbs!.find((y: any) => y.b == b)?.v);
        const run = (x: any) => { if (meta) walkSimple(x, t, meta, 2, j); else { const y = x.rbs!.find((y: any) => y.b == b); if (y) process(y, 2); } };
        const safe = (i: number, sc: any) => { try { return fns[i]!(sc); } catch { return undefined; } };
        let e: { m: Map<unknown, any[]>; on: Set<any> } | undefined = rb.sx?.get(b);
        if (!e) {
          const m = new Map<unknown, any[]>(), on = new Set<any>();
          for (const x of rb.rows!) {
            const k = safe(s.r, x.s), a = m.get(k);
            a ? a.push(x) : m.set(k, [x]);
            if (+!!cur(x) == f) on.add(x);
          }
          (rb.sx ??= new Map()).set(b, (e = { m, on }));
        }
        for (const x of [...e.on, ...(e.m.get(safe(s.o, rb.s)) ?? [])]) {
          run(x);
          if (+!!cur(x) == f) e.on.add(x); else e.on.delete(x);
        }
      }
      return (rb: any, free) => {
        const ss = sels(rb.t);
        if (!ss.some((b) => hit(b.s!.d, rb.s))) return 0;
        if (!free) return 2;
        for (const b of ss) select(rb, b);
        return 1;
      };
    };
  },
};
export default feature;
