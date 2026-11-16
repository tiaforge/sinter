// Links as navigations: one listener turns a plain click on a link into an intent for the app's
// navigation handlers (`App.nav`: same-page links). A handler that decides on it prevents the default;
// else the browser follows the link, as without this module (and the swap, where there is one, gets the
// browser's `navigate` event). Shared by the features that handle links, installed once per app.
import type { App } from './runtime/app.js';

/**
 * Listens for plain clicks on links: the primary button, no modifier, no default prevented by the page's
 * handlers (they run first: the core listens in the capture phase, this in the bubble phase), on an
 * `<a href>` or `<area href>` without `download`, a `target` other than `_self` or `rel="external"`.
 */
export function links(app: App): void {
  if (app.ext.links) return;
  app.ext.links = true;
  const click = (e: Event) => {
    const m = e as MouseEvent, a = (e.target as Element | null)?.closest?.('a[href],area[href]');
    if (!a || m.defaultPrevented || m.button || m.ctrlKey || m.metaKey || m.shiftKey || m.altKey) return;
    if (a.matches('[download],[target]:not([target=_self]),[rel~=external]')) return;
    let to: string;
    try { to = new URL(a.getAttribute('href')!, app.env.href()).href; } catch { return; }
    if (app.go({ from: app.env.href(), to, kind: 'push', source: 'link', trigger: a })) e.preventDefault();
  };
  app.root.addEventListener('click', click);
  app.addCleanup(() => { app.root.removeEventListener('click', click); delete app.ext.links; });
}
