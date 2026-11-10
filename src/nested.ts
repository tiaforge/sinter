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
    app.ext.nested = {
      apply(r, fields, op, item, set, byId) {
        const c = change(r, fields, op, item, set, byId);
        if (c) r.patch(c[0] as Obj, c[1]);
        return !!c;
      },
      upsert(list: unknown, item: unknown, key: Resource | null) {
        const l = Array.isArray(list) ? list : [];
        const i = key?.key && item && typeof item == 'object' ? l.findIndex((x) => x && key.keyOf(x) === key.keyOf(item as Obj)) : -1;
        return i < 0 ? [...l, item] : l.with(i, item);
      },
    };
  },
};
export default feature;
