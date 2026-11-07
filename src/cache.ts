// `cache` on `<sn-resource>`: the page-load cache. A resource shows the data it had
// on the last page load at once and revalidates as usual. Entries live in
// sessionStorage (one tab's lifetime) under `sn:c:`, keyed by the request URL and
// the `items`/`total` paths, so pages that load the same thing share them. Written
// after every load and on `pagehide` (confirmed data only, never optimistic layers);
// removed on any 401 and by `clearPersisted()`.
import type { ResourceDef } from './ir.js';
import type { App, Feature } from './runtime/app.js';
import { CACHE_PREFIX } from './runtime/config.js';
import type { Resource } from './runtime/store.js';

/** entries larger than this (serialized) are not written */
export const MAX_ENTRY = 256 * 1024;

interface Tracked { def: ResourceDef; r: Resource; url: string; dirty: boolean; appended: boolean; off: boolean }

const cache: Feature = {
  name: 'cache',
  install(app: App) {
    const tracked = new Map<string, Tracked>();
    const keyOf = (def: ResourceDef, url: string) => CACHE_PREFIX + JSON.stringify([url, def.items, def.total]);

    /** drops the older half of the cache entries; false when there was nothing to drop */
    const evict = (s: Storage, keep: string): boolean => {
      const entries: Array<[string, number]> = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k || !k.startsWith(CACHE_PREFIX) || k == keep) continue;
        let t = 0;
        try { t = JSON.parse(s.getItem(k)!).t; } catch { /* unreadable: oldest */ }
        entries.push([k, t]);
      }
      if (!entries.length) return false;
      entries.sort((a, b) => a[1] - b[1]);
      for (const [k] of entries.slice(0, Math.ceil(entries.length / 2))) s.removeItem(k);
      return true;
    };

    const write = (def: ResourceDef, url: string, items: unknown, total: number | null) => {
      const s = app.env.session();
      if (!s) return;
      let text: string;
      try { text = JSON.stringify({ t: app.env.now(), items, total }); } catch { return; }
      if (text.length > MAX_ENTRY) return app.warn(19, def.name, Math.round(text.length / 1024));
      const key = keyOf(def, url);
      for (let tries = 0; tries < 2; tries++) {
        try { s.setItem(key, text); return; } catch { if (!evict(s, key)) return; }
      }
    };

    app.ext.cache = {
      read(def, url) {
        try {
          const v = app.env.session()?.getItem(keyOf(def, url));
          if (!v) return null;
          const e = JSON.parse(v) as { t: number; items: unknown; total: number | null };
          return def.cache && app.env.now() - e.t > def.cache ? null : e;
        } catch {
          return null;
        }
      },
      loaded(def, r, url, items, total, appended) {
        let t = tracked.get(def.name);
        if (!t) {
          const entry: Tracked = (t = { def, r, url, dirty: false, appended, off: false });
          // confirmed changes after the load (server events, action results); layers never fire this
          r.subscribe(() => { entry.dirty = true; });
          tracked.set(def.name, t);
        }
        t.url = url;
        t.appended = appended;
        t.off = false;
        // `append` caches only its first page: later pages would be shown as if they were it
        if (!appended) write(def, url, items, total);
        t.dirty = false;
      },
      // the emptied resource must not replace the entry of its last URL
      cleared(def) {
        const t = tracked.get(def.name);
        if (t) t.off = true;
      },
    };

    app.addCleanup(app.env.listen('pagehide', () => {
      for (const t of tracked.values()) {
        if (!t.dirty || t.off || t.appended || t.def.paginate?.mode == 'append') continue;
        const b = t.r.base();
        write(t.def, t.url, b.items, b.total);
        t.dirty = false;
      }
    }));
  },
};

export default cache;
