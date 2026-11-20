// `cache` on `<sn-resource>`: the page-load cache. A resource shows the data it had
// on the last page load at once and revalidates as usual. Entries live in
// sessionStorage (one tab's lifetime) under `sn:c:`, keyed by the request URL and
// the `items`/`total` paths, so pages that load the same thing share them. Written
// after every load, on `pagehide` and when the app is destroyed (confirmed data only, never optimistic layers);
// removed on any 401 and by `clearStored()`.
//
// Back and Forward: on a page reached by a history traversal (a load of type `back_forward`, which the
// back/forward cache did not serve, or a swap's traversal), every resource the cache can hold restores
// its entry, with or without `cache`, at any age, and revalidates. So the compiler adds this module to
// every page with such a resource (not `for`, `call`, `method="POST"` or `file:`), and a resource
// without `cache` writes its entry once, as the page is left (`pagehide`, or destroyed for a swap): the
// page as the visitor left it, which is what they come back to. `append` lists are not written then.
import type { ResourceDef } from './ir.js';
import type { App, Feature } from './runtime/app.js';
import { CACHE_PREFIX } from './runtime/config.js';
import type { Resource } from './runtime/store.js';

/** entries larger than this (serialized) are not written */
export const MAX_ENTRY = 256 * 1024;

/** set by a swap for the page it mounts: whether it is a traversal (Back, Forward), which a load's navigation type cannot say */
const TRAVERSE = Symbol.for('sinter.traverse');
/** set by a swap's traversal that reloads its entry instead (swap.ts `back()`): the URL it reloads */
const BACK = 'sn:back';

interface Tracked { def: ResourceDef; r: Resource; url: string; dirty: boolean; appended: boolean; off: boolean }

/** what the page-load cache never holds: `call`, `for`, `method="POST"` and `file:` resources */
const never = (d: ResourceDef) => d.call || d.each || d.body != null || d.fx;

const cache: Feature = {
  name: 'cache',
  install(app: App) {
    const tracked = new Map<string, Tracked>();
    // Back or Forward to this page (decided as it mounts): a swap says so; a load, by its navigation type, or by the mark
    // of a swap's traversal that reloaded its entry (to a page with nothing to run, or one that could not mount)
    const g = globalThis as any, s = app.env.session();
    let back: boolean = app.env.traversal?.() ?? g[TRAVERSE] ?? ((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type == 'back_forward');
    try { if (s?.getItem(BACK) != null) { back ||= s.getItem(BACK) == app.env.href(); s.removeItem(BACK); } } catch { /* storage failures are ignored */ }
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
        // without `cache`: only coming back, and only what this module writes
        if (def.cache == null && (!back || never(def))) return null;
        try {
          const v = app.env.session()?.getItem(keyOf(def, url));
          if (!v) return null;
          const e = JSON.parse(v) as { t: number; items: unknown; total: number | null };
          return !back && def.cache && app.env.now() - e.t > def.cache ? null : e;
        } catch {
          return null;
        }
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
