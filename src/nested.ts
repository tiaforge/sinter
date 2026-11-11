// Nested items (docs/components.md): `patch(r, …)` and `remove(r)` for an item of a nested list
// (`r in comment.replies`, at any depth in a recursive component), and `upsert(c.replies, x)`. The
// item is found under the resource's rows through those lists, by the resource's key; the objects
// along its path are replaced, and the row is patched. Loaded only by pages that change nested items.
import type { App, Feature } from './runtime/app.js';
import type { Resource } from './runtime/store.js';

type Obj = Record<string, any>;

const feature: Feature = {
  name: 'nested',
  install(app: App) {
    /**
     * The change of the row (or single resource) holding `item` under `fields`, at any depth: the row's
     * fields to patch, or null when it is not there. `same`: by identity only, or also by key.
     */
    const change = (r: Resource, fields: string[], op: 'patch' | 'remove', item: unknown, set: Obj | undefined, byId: boolean) => {
      const k = r.key && item && typeof item == 'object' ? r.keyOf(item as Obj) : null;
      const same = (x: unknown) => x === item || (!byId && k != null && !!x && typeof x == 'object' && r.keyOf(x as Obj) === k);
      const under = (x: Obj): Obj | null => {
        for (const f of fields) {
          const list = x?.[f];
          if (!Array.isArray(list)) continue;
          for (let i = 0; i < list.length; i++) {
            if (same(list[i])) return { [f]: op == 'remove' ? list.filter((_, j) => j != i) : list.with(i, { ...list[i], ...set }) };
            const deeper = list[i] && typeof list[i] == 'object' ? under(list[i]) : null;
            if (deeper) return { [f]: list.with(i, { ...list[i], ...deeper }) };
          }
        }
        return null;
      };
      for (const top of r.isCollection ? r.all() : [r.value()]) {
        const c = top && typeof top == 'object' ? under(top as Obj) : null;
        if (c) return [top, c] as const;
      }
      return null;
    };
    const apply = (r: Resource, fields: string[], op: 'patch' | 'remove', item: unknown, set: Obj | undefined, byId: boolean) => {
      const c = change(r, fields, op, item, set, byId);
      if (c) r.patch(c[0] as Obj, c[1]);
      return !!c;
    };
    /** `patch(item, …)`/`remove(item)` from these sources: a nested one with the same object first, then a row by key, then a nested one by key */
    const byItem = (res: (n: string) => Resource, op: 'patch' | 'remove', names: string[], item: unknown, set?: Obj) => {
      const nested = (byId: boolean) => names.some((n) => { const [r, f] = n.split('>'); return f != null && apply(res(r!), f.split(','), op, item, set, byId); });
      if (nested(true)) return;
      for (const n of names) {
        if (n.includes('>')) continue;
        const r = res(n);
        if (r.isCollection ? item != null && r.has(item as Obj) : true) return void (op == 'patch' ? r.patch(item as Obj, set!) : r.remove(item as Obj));
      }
      nested(false);
    };
    const isObj = (v: unknown): v is Obj => !!v && typeof v == 'object' && !Array.isArray(v);
    app.ext.nested = {
      change: byItem,
      apply,
      // write-through (apply.ts): the item the target names (a row, or a shared definition's prop: a path in scope)
      wt(t, s, fields, log) {
        const r = app.resource(t.r), item = t.v!.split('.').reduce((x: any, k) => x?.[k], s);
        if (!isObj(item)) return;
        if (fields === null) { if (apply(r, t.n!, 'remove', item, undefined, false)) log(t.r, 'remove nested'); return; }
        if (!isObj(fields)) return;
        // only the fields that differ, at the target's sub-path inside the item
        const p = t.p ?? [], cur = p.reduce((x: any, k) => x?.[k], item);
        let diff: Obj | null = null;
        for (const k of Object.keys(fields)) if (!isObj(cur) || !(k in cur) || JSON.stringify(cur[k]) !== JSON.stringify(fields[k])) (diff ??= {})[k] = fields[k];
        if (!diff) return;
        const at = (x: any, q: string[]): Obj => (q.length ? { [q[0]!]: { ...(isObj(x?.[q[0]!]) ? x[q[0]!] : {}), ...at(x?.[q[0]!], q.slice(1)) } } : diff!);
        if (apply(r, t.n!, 'patch', item, at(item, p), false)) log(t.r, `patch ${t.n!.join(',')}${p.length ? ' .' + p.join('.') : ''}`);
      },
      upsert(res, names, owner, field, item) {
        const key = res(names[0]!.split('>')[0]!);
        const l: unknown[] = Array.isArray(owner?.[field]) ? owner[field] : [];
        const i = key.key && item && typeof item == 'object' ? l.findIndex((x) => x && key.keyOf(x as Obj) === key.keyOf(item as Obj)) : -1;
        byItem(res, 'patch', names, owner, { [field]: i < 0 ? [...l, item] : l.with(i, item) });
      },
    };
  },
};
export default feature;
