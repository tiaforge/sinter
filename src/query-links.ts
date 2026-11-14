// Same-page links: a plain click on a link to this page that changes only query parameters the page
// reads is handled in the page. A new history entry, `$url` read again, and everything follows as
// after Back or Forward, which is what loading the URL would show (a `page-model` list loads the
// link's page). A `#hash` stays the browser's. Any other click is the browser's: another path or
// origin, `download`, a `target`, `rel="external"`, a modifier key, a prevented default, or a
// parameter the page does not read. Loaded only by pages with a link the build sees goes to the page
// (its list of read parameters is `IR.urlReads`).
import type { App, Feature } from './runtime/app.js';
import { readUrl } from './runtime/url.js';

const feature: Feature = {
  name: 'query-links',
  install(app: App) {
    const reads = new Set(app.ir.urlReads);
    /** where a click on `a` goes when it may stay in the page: the same origin and path; nothing: the browser's */
    const place = (a: Element): URL | void => {
      if (a.matches('[download],[target]:not([target=_self]),[rel~=external]')) return;
      const here = new URL(app.env.href());
      try {
        const to = new URL(a.getAttribute('href')!, here);
        if (to.origin == here.origin && to.pathname == here.pathname) return to;
      } catch { /* not a URL: the browser's */ }
    };
    /** whether the query of `to` differs from the current one, by name and values (`?a=1&b=2` is `?b=2&a=1`); nothing: a parameter the page does not read does */
    const differs = (to: URL): boolean | void => {
      const q = new URL(app.env.href()).searchParams;
      let d = false;
      for (const n of new Set([...q.keys(), ...to.searchParams.keys()])) {
        if (q.getAll(n).join('\0') == to.searchParams.getAll(n).join('\0')) continue;
        if (!reads.has(n)) return;
        d = true;
      }
      return d;
    };
    app.ext.sameLink = (a) => { const to = place(a); return !!to && !!differs(to); };
    const click = (e: Event) => {
      const m = e as MouseEvent, a = (e.target as Element | null)?.closest?.('a[href],area[href]');
      const to = !m.defaultPrevented && !(m.button || m.ctrlKey || m.metaKey || m.shiftKey || m.altKey) && a && place(a);
      if (!to) return;
      // what typing waits to commit goes into its own entry first: the link is compared with that URL
      app.ext.typing?.finish();
      const d = differs(to);
      if (d == null) return;
      // the same query: a `#hash` (the link's or the address bar's) is the browser's; else nothing changes
      if (!d && (to.hash || new URL(app.env.href()).hash)) return;
      e.preventDefault();
      if (!d) return;
      const loc = app.ext.location!, u = app.page.$url;
      // a history call the browser refuses (Safari, too often): the link loads
      // the URL as the link wrote it (`?` stays), without its hash
      try { loc.push(to.href.replace(/#.*/, '')); } catch { return app.env.navigate(to.href); }
      for (const k in u) delete u[k];
      Object.assign(u, readUrl(app.env.href(), app.ir.path));
      loc.arrive();
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
