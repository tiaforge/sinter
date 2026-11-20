// Back and Forward on a page without `cache` (src/cache.ts does this, and more, on a page with it): when the
// visitor comes back to the page and the back/forward cache did not keep it (a load of type `back_forward`, a
// swap's traversal, or the reload a swap's traversal marks), each resource shows what the page showed as it was
// left, at once, and revalidates. Entries are the page-load cache's (`sn:c:`, keyed by the request URL and the
// `items`/`total` paths: the 256 KB limit, the 401 and `clearStored()` apply), written once, as the page is left
// (`pagehide`, or the app destroyed for a swap): its confirmed data, not after each load. The compiler adds this
// module to a page with a resource it can restore (not `for`, `call`, `method="POST"`, `file:`, embedded or `append`).
import type { ResourceDef } from './ir.js';
import type { App, Feature } from './runtime/app.js';
import { CACHE_PREFIX } from './runtime/config.js';

/** entries larger than this (serialized) are not written */
export const MAX_ENTRY = 256 * 1024;

/** what the page-load cache never holds: `call`, `for`, `method="POST"` and `file:` resources */
export const never = (d: ResourceDef) => d.call || d.each || d.body != null || d.fx;

export const keyOf = (d: ResourceDef, url: string) => CACHE_PREFIX + JSON.stringify([url, d.items, d.total]);

/**
 * Whether the page is reached by Back or Forward, as it mounts: the env says (tests), else a swap (which sets
 * `Symbol.for('sinter.traverse')` for the page it mounts: the document's own navigation type is its first load's),
 * else the load's navigation type; or the mark a swap's traversal leaves when it reloads its entry instead (swap.ts
 * `back()`), read once.
 */
export function traversal(app: App): boolean {
  const s = app.env.session();
  let back: boolean = app.env.traversal?.() ?? (globalThis as any)[Symbol.for('sinter.traverse')] ?? ((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type == 'back_forward');
  try { const m = s?.getItem('sn:back'); if (m != null) { back ||= m == app.env.href(); s!.removeItem('sn:back'); } } catch { /* storage failures are ignored */ }
  return back;
}

const back: Feature = {
  name: 'back',
  install(app: App) {
    const on = traversal(app);
    /** each resource's request as last stored (null: emptied, or an `append` list, whose pages would read as its first) */
    const urls = new Map<ResourceDef, string | null>();
    app.ext.cache = {
      read(def, url) {
        if (!on || never(def)) return null;
        try { return JSON.parse(app.env.session()?.getItem(keyOf(def, url)) ?? 'null'); } catch { return null; }
      },
      loaded(def, _r, url, _items, _total, appended) { if (!never(def)) urls.set(def, appended || def.paginate?.mode == 'append' ? null : url); },
      cleared(def) { urls.set(def, null); },
    };
    const flush = () => {
      const s = app.env.session();
      for (const [def, url] of urls) {
        if (!url || !s) continue;
        const b = app.resource(def.name).base(), key = keyOf(def, url);
        let text: string;
        try { text = JSON.stringify({ t: app.env.now(), items: b.items, total: b.total }); } catch { continue; }
        if (text.length > MAX_ENTRY) { app.warn(19, def.name, Math.round(text.length / 1024)); continue; }
        // full: the page-load cache's entries go, and this one is written once more
        try { s.setItem(key, text); } catch {
          for (let i = s.length; i--;) if (s.key(i)?.startsWith(CACHE_PREFIX)) s.removeItem(s.key(i)!);
          try { s.setItem(key, text); } catch { /* too large for the storage */ }
        }
      }
    };
    app.addCleanup(app.env.listen('pagehide', flush));
    // an app destroyed with the document staying (the next page swapped in) has no pagehide
    app.addCleanup(flush);
  },
};

export default back;
