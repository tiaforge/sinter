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
        const key = rb.def.p!;
        const v = read(key);
        if (v !== undefined) set(v);
        const paths = (rb.def.w ?? []).map((w) => w.split('.').map((s) => (s[0] === '{' ? '*' : s)));
        app.afterFlush.push((dirty) => {
          if (!dirty.some((d) => paths.some((p) => overlaps(p, d)))) return;
          try { write(key, app.fns[rb.def.f!]!(rb.scope)); } catch { /* unreadable: skip */ }
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

function overlaps(a: string[], b: string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i] && a[i] !== '*' && b[i] !== '*') return false;
  return true;
}

export default persist;
