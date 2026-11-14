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
    const reads = app.ir.urlReads!, here = () => new URL(app.env.href());
    /** where a click on `a` goes when it may stay in the page: the same origin and path; nothing: the browser's */
    const place = (a: Element): URL | void => {
      if (a.matches('[download],[target]:not([target=_self]),[rel~=external]')) return;
      const at = here();
      try {
        const to = new URL(a.getAttribute('href')!, at);
        if (to.origin == at.origin && to.pathname == at.pathname) return to;
      } catch { /* not a URL: the browser's */ }
    };
    /** a query without the parameters `drop`, each name's values together in their order: equal for equal queries */
    const key = (u: URL, drop: string[] = []) => {
      const q = new URLSearchParams(u.search);
      for (const n of drop) q.delete(n);
      q.sort();
      return '' + q;
    };
    /** whether the query of `to` differs from the current one, by name and values (`?a=1&b=2` is `?b=2&a=1`); nothing: a parameter the page does not read does */
    const differs = (to: URL): boolean | void => {
      const at = here();
      return key(at) != key(to) && (key(at, reads) == key(to, reads) || undefined);
    };
    app.ext.sameLink = (a) => { const to = place(a); return to && differs(to); };
    /** goes to `to` in the page when it may (true: done here, the browser does nothing); `replace`: in the current entry */
    const follow = (to: URL, replace?: boolean): boolean => {
      // what typing waits to commit goes into its own entry first: the link is compared with that URL
      app.ext.typing?.finish();
      const d = differs(to);
      if (d == null) return false;
      // the same query: a `#hash` (the link's or the address bar's) is the browser's; else nothing changes
      if (!d && (to.hash || here().hash)) return false;
      if (!d) return true;
      const loc = app.ext.location!, u = app.page.$url, href = to.href.replace(/#.*/, '');
      // a history call the browser refuses (Safari, too often): the link loads
      // the URL as the link wrote it (`?` stays), without its hash
      try { replace ? app.env.replaceState(href) : loc.push(href); } catch { app.env.navigate(to.href); return true; }
      for (const k in u) delete u[k];
      Object.assign(u, readUrl(app.env.href(), app.ir.path));
      loc.arrive();
      app.mark('$url');
      // a native fragment navigation in the new entry: `:target`, `scroll-margin` and focus as in any page
      if (to.hash) (app.env.fragment ?? ((h) => location.replace(h)))(to.hash);
      return true;
    };
    app.ext.follow = (url, replace) => {
      const at = here(), to = new URL(url, at);
      return to.origin == at.origin && to.pathname == at.pathname && follow(to, replace);
    };
    const click = (e: Event) => {
      const m = e as MouseEvent, a = (e.target as Element | null)?.closest?.('a[href],area[href]');
      const to = !m.defaultPrevented && !(m.button || m.ctrlKey || m.metaKey || m.shiftKey || m.altKey) && a && place(a);
      if (to && follow(to)) e.preventDefault();
    };
    // after the page's own handlers (the core listens in the capture phase): one may prevent the default
    app.root.addEventListener('click', click);
    app.addCleanup(() => app.root.removeEventListener('click', click));
  },
};
export default feature;
