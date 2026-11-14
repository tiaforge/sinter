// Same-page links: a plain click on a link to this page that changes only query parameters the page
// reads is handled in the page. A new history entry, `$url` read again, and everything follows as
// after Back or Forward, which is what loading the URL would show (a `page-model` list loads the
// link's page). A `#hash` stays the browser's. Any other click is the browser's: another path or
// origin, `download`, a `target`, `rel="external"`, a modifier key, a prevented default, or a
// parameter the page does not read. Loaded only by pages with a link the build sees goes to the page.
import type { App, Feature } from './runtime/app.js';
import { readUrl } from './runtime/url.js';

const feature: Feature = {
  name: 'query-links',
  install(app: App) {
    const reads = new Set(app.ir.urlReads ?? []);
    /** where a click on `a` goes in the page, and whether its query differs; null: the browser follows it */
    const target = (a: Element): { to: URL; differs: boolean } | null => {
      const l = a as HTMLAnchorElement;
      if (l.hasAttribute('download') || (l.target && l.target != '_self') || /(^|\s)external(\s|$)/i.test(l.rel ?? '')) return null;
      const here = new URL(app.env.href());
      let to: URL;
      try { to = new URL(l.getAttribute('href')!, here); } catch { return null; }
      if (to.origin != here.origin || to.pathname != here.pathname) return null;
      // by name and values, not as a string: `?a=1&b=2` is `?b=2&a=1`
      let differs = false;
      for (const n of new Set([...here.searchParams.keys(), ...to.searchParams.keys()])) {
        const x = here.searchParams.getAll(n), y = to.searchParams.getAll(n);
        if (x.length == y.length && x.every((v, i) => v == y[i])) continue;
        if (!reads.has(n)) return null;
        differs = true;
      }
      return { to, differs };
    };
    app.ext.sameLink = (a) => !!target(a)?.differs;
    const click = (e: Event) => {
      const m = e as MouseEvent;
      if (m.defaultPrevented || m.button != 0 || m.ctrlKey || m.metaKey || m.shiftKey || m.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href], area[href]'), t = a && target(a);
      if (!t) return;
      const { to, differs } = t;
      // the same query: a `#hash` is the browser's; the current URL changes nothing
      if (!differs && to.hash) return;
      e.preventDefault();
      if (!differs) return;
      // what typing waits to commit goes into its own entry first
      app.ext.typing?.finish();
      (app.env.pushState ?? ((x) => history.pushState(null, '', x)))(to.pathname + to.search);
      const u = app.page.$url;
      for (const k in u) delete u[k];
      Object.assign(u, readUrl(app.env.href(), app.ir.path));
      app.ext.location!.arrive();
      app.mark('$url');
      // a native fragment navigation in the new entry: `:target`, `scroll-margin` and focus as in any page
      if (to.hash) (app.env.fragment ?? ((h) => location.replace(h)))(to.hash);
    };
    // after the page's own handlers (the core listens in the capture phase): one may prevent the default
    const ET = EventTarget.prototype;
    ET.addEventListener.call(app.root, 'click', click);
    app.addCleanup(() => ET.removeEventListener.call(app.root, 'click', click));
  },
};
export default feature;
