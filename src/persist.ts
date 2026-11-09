// `data-sn-persist`: keeps a model value or a whole state object in
// localStorage under `sn:<key>`. Storage failures are ignored.
import type { App, Feature } from './runtime/app.js';

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
    app.ext.persist = {
      model(rb, set) {
        const key = rb.b.p!;
        const v = read(key);
        if (v !== undefined) set(v);
        app.afterFlush.push((dirty) => {
          if (!app.reaches(rb.b.w ?? [], dirty)) return;
          try { write(key, app.fns[rb.b.f!]!(rb.s)); } catch { /* unreadable: skip */ }
        });
      },
      state(key, obj) {
        const v = read(key);
        if (!v || typeof v !== 'object') return;
        for (const k of Object.keys(obj)) if (Object.hasOwn(v, k)) obj[k] = (v as Record<string, unknown>)[k];
      },
      saveState: write,
    };
  },
};

export default persist;
