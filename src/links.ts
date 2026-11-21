// The navigation chain and links as navigations, for the features that decide on navigations (same-page
// links, transitions, the swap): only pages with one of them load this.
//
// `chain(app)` installs on the app (once) the document's chain: the handlers of every app on the document in
// their rank, the observers of what goes, `decide` (every handler asked, nothing run) and `go` (the first
// decision run, else the source's fallback).
// Where the browser has the Navigation API, its `navigate` event is the one source of intents: a link,
// `navigate()`, `location.assign` and Back all arrive as one event each, which a handler intercepts or
// leaves to the browser. Where it does not, `links(app)` turns a plain click on a link into an intent and
// the core's `popstate` gives the traversals, as before.
import type { App, Decision, Intent, Navigator } from './runtime/app.js';

/** The order handlers are asked in (lower first): a module that takes navigations itself, then same-page links, then the swap. */
export const RANK = { views: 10, same: 20, swap: 30 } as const;

type Chain = App & Required<Pick<App, 'onGo' | 'decide' | 'go'>> & {
  add(h: Navigator, rank: number): void;
  /**
   * Guards, run when a navigation goes (never when the chain is only asked, as next-page data does): one
   * that returns true refuses it (`data-sn-on-sn-navigate` and `$event.preventDefault()`, navigate.ts). Not run
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
type Nav = EventTarget & { currentEntry: { key: string } | null; navigate(url: string, o: { history: 'auto' | 'replace'; info: unknown }): unknown };
/**
 * The Navigation API, where its `navigate` event says which element started it (`sourceElement`): Chromium 102
 * to 134 have the API without it (no link's `data-sn-swap="off"`, `rel="external"`, form or trigger), and take
 * the path of browsers without the API (links by their click, Back by `popstate`, every other page a load)
 */
export const api = (): Nav | undefined => {
  const g = globalThis as { navigation?: Nav; NavigateEvent?: { prototype: object } };
  return g.NavigateEvent && 'sourceElement' in g.NavigateEvent.prototype ? g.navigation : undefined;
};
const none = () => {};
/** what a `navigate()` call hands its event: the element of its handler */
const INFO = Symbol('sinter.trigger');
/**
 * `to`: a link to another site whose click the guards were asked about already (navigate.ts): its event asks
 * none; `last`: the latest `navigate` event (the swap tells a history write from a navigation by it)
 */
export const asked: { to: string | null; t?: number; last?: Event } = { to: null };
/** `to` was asked about just now: its navigation, if one follows within a second, asks the guards no more */
export const ask = (to: string) => { asked.to = to; asked.t = Date.now(); };
/** whether `to`'s guards were asked just now (once) */
const wasAsked = (to: string) => { const y = asked.to == to && Date.now() - asked.t! < 1000; if (y) asked.to = null; return y; };

/** What the apps of one document share: one ordered chain, one `navigate` listener, one claim on a traversal. */
interface Shared {
  /** every app's handlers, by rank (lower first), and the app each came from */
  nav: Array<[number, Navigator, App]>;
  apps: Set<Chain>;
  /** the entry of a traversal a handler took from its event: its `popstate` is decided, once */
  took: string | null;
  off?: () => void;
}
const docs = new WeakMap<object, Shared>();

/**
 * The navigation chain, one per document: every app on it adds its handlers, observers and guards (they go with
 * the app), every handler is asked in rank order, the first decision runs, and a guard of any app refuses for
 * all. Installed on the app once; the core's fallbacks (a call's load) use the env of the app that went.
 */
export function chain(app: App): Chain {
  const c = app as Chain;
  if ((app as App).go) return c;
  const env = app.env, root = app.root, doc = (root as Node).ownerDocument ?? root, N = api();
  let d = docs.get(doc);
  if (!d) docs.set(doc, (d = { nav: [], apps: new Set(), took: null }));
  const sh = d;
  sh.apps.add(c);
  c.add = (h, r) => {
    let i = sh.nav.length;
    while (i && sh.nav[i - 1]![0] > r) i--;
    sh.nav.splice(i, 0, [r, h, app]);
  };
  c.onGo = [];
  c.guards = [];
  c.decide = (i) => {
    let d: Decision | void | undefined;
    for (const [, h] of sh.nav) { const r = h(i); d ||= r; }
    return d as Decision | undefined;
  };
  const all = <T>(k: 'onGo' | 'guards') => [...sh.apps].flatMap((a) => a[k] as T[]);
  /** whether a guard of any app refuses `i` (every guard runs: each may note the navigation) */
  const refuses = (i: Intent) => all<(i: Intent) => boolean>('guards').reduce((no, g) => g(i) || no, false);
  c.go = (i) => {
    i.from ||= env.href();
    // with the Navigation API, a call is the browser's navigation, whose event is the intent (and its guards)
    if (N && i.source == 'call') {
      for (const f of all<(i: Intent) => void>('onGo')) f(i);
      // its promises reject when a guard refuses it or a newer navigation replaces it: expected, not an error
      const r = N.navigate(i.to, { history: i.kind == 'replace' ? 'replace' : 'auto', info: { [INFO]: i.trigger } }) as { committed?: Promise<unknown>; finished?: Promise<unknown> } | undefined;
      r?.committed?.catch(none);
      r?.finished?.catch(none);
      return;
    }
    if (N && i.source == 'popstate') {
      if (!sh.took || sh.took != N.currentEntry?.key) return;
      sh.took = null;
      return { name: 'taken' };
    }
    const e = i.event as NavigateLike | undefined;
    // a navigation the guards were asked about already (the swap's own fallback, or its navigation again) asks none
    const pre = wasAsked(i.to);
    // refused: a link's default is prevented (a decision without `run`), an event cancelled, a call does nothing;
    // every guard runs (each may note the navigation)
    if (!pre && i.source != 'popstate' && (!e || e.cancelable) && refuses(i)) {
      e?.preventDefault();
      return { name: 'refused' };
    }
    for (const f of all<(i: Intent) => void>('onGo')) f(i);
    const d = c.decide(i);
    // the fallback is the source's: an event's own (`load`), or none (the browser goes on with it); a call loads
    const load = () => (i.load ? i.load() : i.source == 'event' ? undefined
      : i.kind == 'replace' ? env.replace(i.to) : env.navigate(i.to));
    // no decision: a call loads; a link is the browser's to follow, an event the browser's to go on with
    if (!d) i.source == 'call' && load();
    else {
      if (i.source == 'event' && i.kind == 'traverse' && d.run) sh.took = (i.event as NavigateLike).destination.key;
      const r = d.run?.();
      if (r === false) load();
      else if (r instanceof Promise) r.then((ok) => ok === false && load(), load);
    }
    return d;
  };
  // one `navigate` listener for the document, whichever app installed it: it goes with the last app
  if (N && !sh.off) {
    const on = (ev: Event) => {
      const e = (asked.last = ev) as NavigateLike;
      if (e.hashChange || e.downloadRequest != null || e.formData || e.navigationType == 'reload') return;
      // `history.pushState` (a `$url` write) fires it too: no navigation to decide on
      if (e.destination.sameDocument && e.navigationType != 'traverse') return;
      // a form's navigation (its submitter is the source), a download, another target: the browser's
      const from = e.sourceElement;
      if (from && (from.localName == 'form' || (from as HTMLButtonElement).form || from.matches('[download],[target]:not([target=_self])'))) return;
      // another site (or `rel="external"`): the browser's too, but the page's guards are asked while it can be refused
      if (!e.canIntercept || from?.matches('[rel~=external]')) {
        if (!wasAsked(e.destination.url) && e.cancelable && refuses({ to: e.destination.url, from: env.href(), kind: e.navigationType, source: 'event', trigger: from ?? null, event: e })) e.preventDefault();
        return;
      }
      const info = e.info as { [INFO]?: Element | null } | undefined;
      [...sh.apps][0]?.go({ to: e.destination.url, kind: e.navigationType, source: 'event', trigger: from ?? info?.[INFO] ?? null, index: e.destination.index, event: e });
    };
    N.addEventListener('navigate', on);
    sh.off = () => N.removeEventListener('navigate', on);
  }
  app.addCleanup(() => {
    sh.apps.delete(c);
    sh.nav = sh.nav.filter((x) => x[2] !== app);
    if (!sh.apps.size) { sh.off?.(); docs.delete(doc); }
  });
  return c;
}

/**
 * Links as intents where there is no `navigate` event (the chain gets links from it otherwise): plain clicks,
 * the primary button, no modifier, no default prevented by the page's handlers (they run first: the core
 * listens in the capture phase, this in the bubble phase), on an `<a href>` or `<area href>` without
 * `download` or a `target` other than `_self`.
 */
export function links(app: App): void {
  const c = chain(app);
  if (app.ext.links || api()) return;
  app.ext.links = true;
  const click = (e: Event) => {
    const m = e as MouseEvent, a = (e.target as Element | null)?.closest?.('a[href],area[href]');
    if (!a || m.defaultPrevented || m.button || m.ctrlKey || m.metaKey || m.shiftKey || m.altKey) return;
    // (`rel="external"` and other sites go on: no handler takes them, the guards are asked)
    if (a.matches('[download],[target]:not([target=_self])')) return;
    let to: string;
    try { to = new URL(a.getAttribute('href')!, app.env.href()).href; } catch { return; }
    if (c.go({ to, kind: 'push', source: 'link', trigger: a })) e.preventDefault();
  };
  app.root.addEventListener('click', click);
  app.addCleanup(() => { app.root.removeEventListener('click', click); delete app.ext.links; });
}
