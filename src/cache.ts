// `cache` on `<sn-resource>`: the page-load cache. A resource shows the data it had
// on the last page load at once and revalidates as usual. Entries live in
// sessionStorage (one tab's lifetime) under `sn:c:`, keyed by the request URL and
// the `select`/`total` paths, so pages that load the same thing share them (the key holds the paths, not the names:
// a build that renamed `items` to `select` reads the entries an older one wrote, of the same shape). Written
// after every load, on `pagehide` and when the app is destroyed (confirmed data only, never optimistic layers);
// removed on any 401 and by `clearStored()`.
//
// Back and Forward: on a page reached by a history traversal (a load of type `back_forward`, which the
// back/forward cache did not serve, or a swap's traversal), every resource the cache can hold restores
// its entry, with or without `cache`, at any age, and revalidates; a resource without `cache` writes its
// entry once, as the page is left (`pagehide`, or destroyed for a swap). A page without `cache` gets the
// smaller src/back.ts for that instead. `append` lists are not written then.
import type { ResourceDef } from './ir.js';
import type { App, Feature } from './runtime/app.js';
import { CACHE_PREFIX } from './runtime/config.js';
import type { Resource } from './runtime/store.js';
import { keyOf, MAX_ENTRY, never, readEntry, traversal, writeEntry } from './back.js';

export { MAX_ENTRY };

interface Tracked { def: ResourceDef; r: Resource; url: string; dirty: boolean; appended: boolean; off: boolean }

const cache: Feature = {
  name: 'cache',
  install(app: App) {
    const tracked = new Map<string, Tracked>();
    const back = traversal(app);

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
      const key = keyOf(def, url), text = writeEntry(app.env, key, items, total), s = app.env.session()!;
      if (!text) return;
      if (text.length > MAX_ENTRY) return app.warn(19, def.name, Math.round(text.length / 1024));
      // full: the older half goes, and it is written once more
      if (evict(s, key)) try { s.setItem(key, text); } catch { evict(s, key); }
    };

    app.ext.cache = {
      read(def, url) {
        // without `cache`: only coming back, and only what this module writes
        if (def.cache == null && (!back || never(def))) return null;
        const e = readEntry(app.env, keyOf(def, url));
        return e && !(!back && def.cache && app.env.now() - e.t > def.cache) ? e : null;
      },
      loaded(def, r, url, items, total, appended) {
        if (never(def)) return;
        let t = tracked.get(def.name);
        if (!t) {
          // without `cache`: written as the page is left, so always dirty
          const entry: Tracked = (t = { def, r, url, dirty: def.cache == null, appended, off: false });
          // confirmed changes after the load (server events, action results); layers never fire this
          if (def.cache != null) r.subscribe(() => { entry.dirty = true; });
          tracked.set(def.name, t);
        }
        t.url = url;
        t.appended = appended;
        t.off = false;
        if (def.cache == null) return;
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

    const flush = () => {
      for (const t of tracked.values()) {
        if (!t.dirty || t.off || t.appended || t.def.paginate?.mode == 'append') continue;
        const b = t.r.base();
        write(t.def, t.url, b.items, b.total);
        t.dirty = t.def.cache == null;
      }
    };
    app.addCleanup(app.env.listen('pagehide', flush));
    // an app destroyed with the document staying (the next page swapped in) has no pagehide
    app.addCleanup(flush);
  },
};

export default cache;
