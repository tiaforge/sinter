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
    /** where a click on `a` goes in the page, and whether its query differs; nothing: the browser follows it */
    const where = (a: Element): [URL, boolean] | void => {
      if (a.matches('[download],[target]:not([target=_self]),[rel~=external]')) return;
      const here = new URL(app.env.href()), q = here.searchParams;
      let to: URL;
      try { to = new URL(a.getAttribute('href')!, here); } catch { return; }
      if (to.origin != here.origin || to.pathname != here.pathname) return;
      // by name and values, not as a string: `?a=1&b=2` is `?b=2&a=1`
      let differs = false;
      for (const n of new Set([...q.keys(), ...to.searchParams.keys()])) {
        if (q.getAll(n).join('\0') == to.searchParams.getAll(n).join('\0')) continue;
        if (!reads.has(n)) return;
        differs = true;
      }
      return [to, differs];
    };
    app.ext.sameLink = (a) => !!where(a)?.[1];
    const click = (e: Event) => {
      const m = e as MouseEvent, a = (e.target as Element | null)?.closest?.('a[href],area[href]');
      const w = !m.defaultPrevented && !(m.button || m.ctrlKey || m.metaKey || m.shiftKey || m.altKey) && a && where(a);
      // the same query: a `#hash` is the browser's; the current URL changes nothing
      if (!w || (!w[1] && w[0].hash)) return;
      e.preventDefault();
      if (!w[1]) return;
      const [to] = w, loc = app.ext.location!, u = app.page.$url;
      // what typing waits to commit goes into its own entry first
      app.ext.typing?.finish();
      loc.push(to.pathname + to.search);
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
