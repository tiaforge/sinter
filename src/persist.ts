// `data-sn-persist`: keeps a model value or a whole state object in
// localStorage under `sn:<key>`. Storage failures are ignored.
import type { App, Dirty, Feature } from './runtime/app.js';
import type { Entry } from './paths.js';
import { decode, inState, passes } from './paths.js';

const PREFIX = 'sn:';

const persist: Feature = {
  name: 'persist',
  install(app: App) {
    const read = (key: string): unknown => {
      try {
        const v = app.env.storage()?.getItem(PREFIX + key);
        return v == null ? undefined : JSON.parse(v);
      } catch { return undefined; }
    };
    const write = (key: string, value: unknown) => {
      try { app.env.storage()?.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* ignored */ }
    };
    // a model's written path is among the page's dependencies (the compiler added it): whether a dirty path reaches it
    const reaches = (nodes: unknown[], dirty: Dirty[]) => dirty.some((d) => d.w >= 0 && ((app.ir.ps!.r[d.w] || []) as Entry[]).some((x) => { const e = decode(x); return nodes.includes(e.d) && passes(e, d.v); }));
    app.ext.persist = {
      model(rb, set) {
        const key = rb.b.p!;
        const v = read(key);
        if (v !== undefined) set(v);
        app.afterFlush.push((dirty) => {
          if (!reaches(rb.b.w ?? [], dirty)) return;
          try { write(key, app.fns[rb.b.f!]!(rb.s)); } catch { /* unreadable: skip */ }
        });
      },
      state(key, obj, sid) {
        const v = read(key);
        if (v && typeof v === 'object') for (const k of Object.keys(obj)) if (Object.hasOwn(v, k)) obj[k] = (v as Record<string, unknown>)[k];
        app.afterFlush.push((d) => d.some((p) => inState(app.ir.ps!, p, sid)) && write(key, obj));
      },
    };
  },
};

export default persist;
