// The navigation chain and links as navigations, for the features that decide on navigations (same-page
// links, transitions, the swap): only pages with one of them load this. `chain(app)` installs the
// handlers' list, its observers, `decide` and `go` on the app (once); `links(app)` also turns a plain
// click on a link into an intent. A decision prevents the click's default; else the browser follows the
// link, as without this module (and the swap, where there is one, gets the browser's `navigate` event).
import type { App, Decision, Intent, Navigator } from './runtime/app.js';

type Chain = App & Required<Pick<App, 'nav' | 'onGo' | 'decide' | 'go'>>;

/** The app's navigation chain, installed once: every handler is asked, the core's fallbacks run the rest. */
export function chain(app: App): Chain {
  const c = app as Chain;
  if ((app as App).go) return c;
  const env = app.env, nav: Navigator[] = (c.nav = []);
  c.onGo = [];
  c.decide = (i) => {
    let d: Decision | void | undefined;
    for (const h of nav) { const r = h(i); d ||= r; }
    return d || undefined;
  };
  c.go = (i) => {
    i.from ||= env.href();
    for (const f of c.onGo) f(i);
    const d = c.decide(i);
    // the fallback is the source's (an event's: its module's), else the page loads
    const load = () => (i.load ? i.load() : i.kind == 'replace' ? (env.replace ?? ((u: string) => location.replace(u)))(i.to) : env.navigate(i.to));
    // no decision: a call loads; a link is the browser's to follow, an event the browser's to go on with
    if (!d) i.source == 'call' && load();
    else {
      const r = d.run?.();
      if (r === false) load();
      else if (r instanceof Promise) r.then((ok) => ok === false && load(), load);
    }
    return d;
  };
  return c;
}

/**
 * Listens for plain clicks on links: the primary button, no modifier, no default prevented by the page's
 * handlers (they run first: the core listens in the capture phase, this in the bubble phase), on an
 * `<a href>` or `<area href>` without `download`, a `target` other than `_self` or `rel="external"`.
 */
export function links(app: App): void {
  const c = chain(app);
  if (app.ext.links) return;
  app.ext.links = true;
  const click = (e: Event) => {
    const m = e as MouseEvent, a = (e.target as Element | null)?.closest?.('a[href],area[href]');
    if (!a || m.defaultPrevented || m.button || m.ctrlKey || m.metaKey || m.shiftKey || m.altKey) return;
    if (a.matches('[download],[target]:not([target=_self]),[rel~=external]')) return;
    let to: string;
    try { to = new URL(a.getAttribute('href')!, app.env.href()).href; } catch { return; }
    if (c.go({ to, kind: 'push', source: 'link', trigger: a })) e.preventDefault();
  };
  app.root.addEventListener('click', click);
  app.addCleanup(() => { app.root.removeEventListener('click', click); delete app.ext.links; });
}
