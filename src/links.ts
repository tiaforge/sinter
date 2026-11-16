// The navigation chain and links as navigations, for the features that decide on navigations (same-page
// links, transitions, the swap): only pages with one of them load this.
//
// `chain(app)` installs on the app (once) the handlers in their rank, the observers of what goes, `decide`
// (every handler asked, nothing run) and `go` (the first decision run, else the source's fallback).
// Where the browser has the Navigation API, its `navigate` event is the one source of intents: a link,
// `navigate()`, `location.assign` and Back all arrive as one event each, which a handler intercepts or
// leaves to the browser. Where it does not, `links(app)` turns a plain click on a link into an intent and
// the core's `popstate` gives the traversals, as before.
import type { App, Decision, Intent, Navigator } from './runtime/app.js';

/** The order handlers are asked in (lower first): a module that takes navigations itself, then same-page links, then the swap. */
export const RANK = { views: 10, same: 20, swap: 30 } as const;

type Chain = App & Required<Pick<App, 'nav' | 'onGo' | 'decide' | 'go'>> & {
  add(h: Navigator, rank: number): void;
  /**
   * Guards, run when a navigation goes (never when the chain is only asked, as next-page data does): one
   * that returns true refuses it (`data-sn-on-navigate` and `$event.preventDefault()`, navigate.ts). Not run
   * for what cannot be refused any more: a traversal without the Navigation API, or an event that cannot
   * be canceled (the browser's own Back without activation).
   */
  guards: Array<(i: Intent) => boolean>;
};

/** what the chain reads of a `navigate` event (the Navigation API) */
interface NavigateLike extends Event {
  canIntercept: boolean; hashChange: boolean; downloadRequest: string | null; formData: FormData | null; cancelable: boolean;
  navigationType: Intent['kind'] | 'reload'; signal: AbortSignal; sourceElement?: Element | null; info?: unknown;
  destination: { url: string; key: string; index: number; sameDocument: boolean };
}
type Nav = EventTarget & { currentEntry: { key: string } | null; navigate(url: string, o: { history: 'push' | 'replace'; info: unknown }): unknown };
const api = (): Nav | undefined => (globalThis as { navigation?: Nav }).navigation;
/** what a `navigate()` call hands its event: the element of its handler */
const INFO = Symbol('sinter.trigger');

/** The app's navigation chain, installed once: every handler is asked, the core's fallbacks run the rest. */
export function chain(app: App): Chain {
  const c = app as Chain;
  if ((app as App).go) return c;
  const env = app.env, nav: Navigator[] = (c.nav = []), ranks: number[] = [], N = api();
  c.add = (h, r) => {
    let i = ranks.length;
    while (i && ranks[i - 1]! > r) i--;
    nav.splice(i, 0, h);
    ranks.splice(i, 0, r);
  };
  c.onGo = [];
  c.guards = [];
  c.decide = (i) => {
    let d: Decision | void | undefined;
    for (const h of nav) { const r = h(i); d ||= r; }
    return d || undefined;
  };
  /** whether a guard refuses `i` (every guard runs: each may note the navigation) */
  const refused = (i: Intent) => {
    let no = false;
    for (const g of c.guards) no = g(i) || no;
    return no;
  };
  /** the entry of a traversal a handler took from its event: its `popstate` is decided, once */
  let took: string | null = null;
  c.go = (i) => {
    i.from ||= env.href();
    // with the Navigation API, a call is the browser's navigation, whose event is the intent (and its guards)
    if (N && i.source == 'call') {
      for (const f of c.onGo) f(i);
      // its promises reject when a guard refuses it or a newer navigation replaces it: expected, not an error
      const r = N.navigate(i.to, { history: i.kind == 'replace' ? 'replace' : 'push', info: { [INFO]: i.trigger } }) as { committed?: Promise<unknown>; finished?: Promise<unknown> } | undefined;
      r?.committed?.catch(() => {});
      r?.finished?.catch(() => {});
      return;
    }
    if (N && i.source == 'popstate') {
      if (took == null || took !== N.currentEntry?.key) return;
      took = null;
      return { name: 'taken' };
    }
    const e = i.event as NavigateLike | undefined;
    // refused: a link's default is prevented (a decision without `run`), an event cancelled, a call does nothing
    if (i.source != 'popstate' && (!e || e.cancelable) && refused(i)) {
      e?.preventDefault();
      return { name: 'refused' };
    }
    for (const f of c.onGo) f(i);
    const d = c.decide(i);
    // the fallback is the source's: an event's own (`load`), or none (the browser goes on with it); a call loads
    const load = () => (i.load ? i.load() : i.source == 'event' ? undefined
      : i.kind == 'replace' ? (env.replace ?? ((u: string) => location.replace(u)))(i.to) : env.navigate(i.to));
    // no decision: a call loads; a link is the browser's to follow, an event the browser's to go on with
    if (!d) i.source == 'call' && load();
    else {
      if (i.source == 'event' && i.kind == 'traverse' && d.run) took = (i.event as NavigateLike).destination.key;
      const r = d.run?.();
      if (r === false) load();
      else if (r instanceof Promise) r.then((ok) => ok === false && load(), load);
    }
    return d;
  };
  if (N) {
    const on = (ev: Event) => {
      const e = ev as NavigateLike;
      if (!e.canIntercept || e.hashChange || e.downloadRequest != null || e.formData || e.navigationType == 'reload') return;
      // `history.pushState` (a `$url` write) fires it too: no navigation to decide on
      if (e.destination.sameDocument && e.navigationType != 'traverse') return;
      // what the browser keeps: a form's navigation (its submitter is the source), a link to another site, a
      // download, another target
      const from = e.sourceElement;
      if (from && (from.localName == 'form' || (from as HTMLButtonElement).form || from.matches('[rel~=external],[download],[target]:not([target=_self])'))) return;
      const info = e.info as { [INFO]?: Element | null } | undefined;
      c.go({ to: e.destination.url, kind: e.navigationType, source: 'event', trigger: from ?? info?.[INFO] ?? null, index: e.destination.index, signal: e.signal, event: e });
    };
    N.addEventListener('navigate', on);
    app.addCleanup(() => N.removeEventListener('navigate', on));
  }
  return c;
}

/**
 * Links as intents where there is no `navigate` event (the chain gets links from it otherwise): plain clicks,
 * the primary button, no modifier, no default prevented by the page's handlers (they run first: the core
 * listens in the capture phase, this in the bubble phase), on an `<a href>` or `<area href>` without
 * `download`, a `target` other than `_self` or `rel="external"`.
 */
export function links(app: App): void {
  const c = chain(app);
  if (app.ext.links || api()) return;
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

/** an entry and the navigation's type, as `NavigationActivation` and a `pageswap` event's `activation` give them */
interface Activation { navigationType: string; from?: { index: number } | null; entry?: { index: number } | null }
interface Typed { viewTransition?: { types?: Set<string> } | null; activation?: Activation | null }

/**
 * The types of a view transition for a navigation (docs/proposals/swap-navigation.md §8), the same for a
 * swap and a page load, for `:active-view-transition-type()`: `sn-push`, `sn-replace` or `sn-traverse`,
 * and on a traversal `sn-back` or `sn-forward`, from the entries' indexes.
 */
export const vtTypes = (kind: string, from?: number, to?: number) =>
  ['sn-' + kind, ...(kind == 'traverse' && from != null && to != null && from != to ? [to < from ? 'sn-back' : 'sn-forward'] : [])];

/** page loads: the same types on the browser's transition (`pageswap` on the page left, `pagereveal` on the next), once per app */
export function loadTypes(app: App): void {
  if (app.ext.types) return;
  app.ext.types = true;
  const add = (e: Event, a?: Activation | null) => {
    const t = (e as Typed).viewTransition?.types;
    if (t && a) for (const x of vtTypes(a.navigationType, a.from?.index, a.entry?.index)) t.add(x);
  };
  const N = (globalThis as { navigation?: { activation?: Activation | null } }).navigation;
  app.addCleanup(app.env.listen('pageswap', (e) => {
    // (the page left is the current entry; `activation` is a platform object: its fields, not a copy)
    const a = (e as Typed).activation;
    add(e, a && { navigationType: a.navigationType, entry: a.entry, from: (N as { currentEntry?: { index: number } } | undefined)?.currentEntry });
  }));
  app.addCleanup(app.env.listen('pagereveal', (e) => add(e, N?.activation)));
}
