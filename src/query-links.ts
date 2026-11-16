// Same-page links: a plain click on a link to this page that changes only query parameters the page
// reads is handled in the page. A new history entry, `$url` read again, and everything follows as
// after Back or Forward, which is what loading the URL would show (a `page-model` list loads the
// link's page). A `#hash` stays the browser's. Any other click is the browser's: another path or
// origin, `download`, a `target`, `rel="external"`, a modifier key, a prevented default, or a
// parameter the page does not read. Loaded only by pages with a link the build sees goes to the page
// (its list of read parameters is `IR.urlReads`).
import { links } from './links.js';
import type { App, Feature } from './runtime/app.js';
import { readUrl } from './runtime/url.js';

const feature: Feature = {
  name: 'query-links',
  install(app: App) {
    const reads = app.ir.urlReads!, here = () => new URL(app.env.href());
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
      // a history call the browser refuses (Safari, too often): false, and the core loads the URL
      // as the link wrote it (`?` stays), without its hash
      try { replace ? app.env.replaceState(href) : loc.push(href); } catch { return false; }
      for (const k in u) delete u[k];
      Object.assign(u, readUrl(app.env.href(), app.ir.path));
      loc.arrive();
      app.mark('$url');
      // a native fragment navigation in the new entry: `:target`, `scroll-margin` and focus as in any page
      if (to.hash) (app.env.fragment ?? ((h) => location.replace(h)))(to.hash);
      return true;
    };
    // a link or `navigate()` to this page (the same origin and path) is the page's when it may; Back and
    // Forward are the core's, the browser's `navigate` event the swap's. Deciding changes nothing: next-page
    // data asks too. Where the browser should follow (a parameter the page does not read, a `#hash` with
    // the same query) there is no decision
    app.nav.push((i) => {
      if (i.kind == 'traverse' || i.source == 'event') return;
      const at = here(), to = new URL(i.to, at);
      if (to.origin != at.origin || to.pathname != at.pathname) return;
      const d = differs(to);
      if (d == null || (!d && (to.hash || at.hash))) return;
      return { name: 'same', run: () => follow(to, i.kind == 'replace') };
    });
    links(app);
  },
};
export default feature;
